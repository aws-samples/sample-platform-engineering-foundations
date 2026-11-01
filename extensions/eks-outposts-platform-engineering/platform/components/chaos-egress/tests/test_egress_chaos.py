#!/usr/bin/env python3
"""Offline tests of egress_chaos.py: cut set, render, chart gate and the whole run against a fake cluster that
simulates the Chaos Mesh controller (injection, duration, recovery, PodNetworkChaos).

Every success path has the pair that must fail: ineffective cut, red baseline, missing recovery, exec error,
interruption, stuck rule, stale series, missing control vantage and a duration outside the choreography.
The fake cluster probes imitate the pod loop (one sample per interval, one timestamp per target); their text is
anchored to the REAL loop by ProbeScript, which runs PROBE_SCRIPT in sh with fake nc, httpd and sleep.
No cluster, no AWS, no network.

  python3 -m unittest discover -s platform/components/chaos-egress/tests -v
"""
import calendar, copy, ipaddress, json, re, subprocess, sys, tempfile, time, unittest
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import egress_chaos as ec  # noqa: E402

EXAMPLE = HERE.parent / "inputs.example.json"
REGION_IP, INTERNET_IP = "198.51.100.10", "203.0.113.3"


def inputs(**over):
    d = json.loads(EXAMPLE.read_text())
    d.update(over)
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "inputs.json"
        p.write_text(json.dumps(d))
        return ec.load_inputs(p)


BASE = float(calendar.timegm((2026, 10, 28, 12, 0, 0)))


class Clock:
    """t = true time (the fake cluster time). now() = runner monotonic clock; wall() = wall clock.
    wall_jump/mono_jump = (instant, delta): an NTP adjustment of the wall clock, or a monotonic jump, from that instant."""

    def __init__(self, fail_at=None, wall_jump=None, mono_jump=None):
        self.t, self.fail_at, self.wall_jump, self.mono_jump = 0.0, fail_at, wall_jump, mono_jump

    @staticmethod
    def _j(jump, t):
        return jump[1] if jump and t >= jump[0] else 0

    def now(self):
        return self.t + self._j(self.mono_jump, self.t)

    def wall_at(self, t):
        return BASE + t + self._j(self.wall_jump, t)

    def wall(self):
        return self.wall_at(self.t)

    def sleep(self, s):
        self.t += s
        if self.fail_at is not None and self.t >= self.fail_at:
            self.fail_at = None
            raise KeyboardInterrupt


def fake_metrics(vantage, samples):
    """Prometheus text in the PROBE_SCRIPT format; ProbeScript proves the real loop produces the same parse."""
    out = []
    for metric, idx, fmt in (("platform_probe_success", 2, "{:d}"), ("platform_probe_latency_seconds", 3, "{:.2f}"),
                             ("platform_probe_sample_timestamp_seconds", 4, "{:d}")):
        out.append(f"# TYPE {metric} gauge")
        for x in samples:
            v = int(x[idx]) if fmt == "{:d}" else x[idx]
            out.append(f'{metric}{{vantage="{vantage}",target_class="{x[0]}",target_name="{x[1]}"}} ' + fmt.format(v))
    return "\n".join(out) + "\n"


class FakeKube:
    """Fake cluster. The 'controller' injects while the NetworkChaos exists and the duration has not expired; the
    probes run the pod loop: one sample every interval_seconds since the apply, with the network state AT that instant.
    Faults: stale (loop stops at the cut apply), no_control (always|during), wrong_vantage, exec_error."""

    def __init__(self, d, clock, **f):
        self.d, self.clock, self.f, self.calls = d, clock, f, []
        self.nc_created = None          # instant of the NetworkChaos apply
        self.probe_start = None         # instant of the probe apply
        self.nc_deleted = False
        self.rules = False               # rules in PodNetworkChaos
        self.ns_ann = {ns: {} for ns in ec.selector_namespaces(d)}
        self.ns_lab = {ns: {} for ns in ec.selector_namespaces(d)}
        for ns in f.get("preannotated", []):
            self.ns_ann[ns][ec.INJECT] = "enabled"
        self.reconciled = "2026-10-28T10:00:00Z"
        self.refreshed = False

    def _injected(self, at=None):
        at = self.clock.t if at is None else at
        if self.nc_created is None or self.nc_deleted or at < self.nc_created:
            return False
        if self.f.get("no_recover"):
            return True
        return at - self.nc_created < self.d["_secs"]

    def _sample(self, ns):
        """Content of /tmp/www/metrics in pod `ns` now: the last complete round of the loop."""
        if self.probe_start is None:
            return 1, "", 'pods "probe" not found'
        if self.f.get("exec_error") and self._injected() and ns == ec.PROBE_NS:
            return 1, "", "error: unable to upgrade connection"
        step = self.d["interval_seconds"]
        k = int((self.clock.t - self.probe_start) // step)
        if self.f.get("stale") and self.nc_created is not None:
            k = min(k, int((self.nc_created - self.probe_start) // step))   # the loop died: the file freezes
        at = self.probe_start + k * step
        nc = self.f.get("no_control")
        if ns == ec.CONTROL_NS and (nc == "always" or (nc == "during" and self._injected(at))):
            return 0, "", ""                                              # httpd answers, empty sample
        vantage = "cut" if (self.f.get("wrong_vantage") and ns == ec.CONTROL_NS) else ec.VANTAGE[ns]
        rows = []
        for kind, target in ec.probe_targets(self.d):
            external = kind in ("region", "internet")
            closed = external and ns == ec.PROBE_NS and self._injected(at) and not (self.f.get("ineffective") and kind == "region")
            if self.f.get("local_closed") and not external and target.startswith("gitea"):
                closed = True
            rows.append((ec.TARGET_CLASS[kind], target, not closed, 4.0 if closed else 0.01, self.clock.wall_at(at)))
        return 0, fake_metrics(vantage, rows), ""

    def _j(self, o):
        return 0, json.dumps(o), ""

    def run(self, args, stdin=None, timeout=60):
        a = list(args)
        self.calls.append((a, stdin))
        s = " ".join(a)
        inj = self._injected()
        if not inj and not self.f.get("stuck"):
            self.rules = False
        if s == "-n chaos-mesh get deployment chaos-controller-manager -o json":
            env = [{"name": "ENABLE_FILTER_NAMESPACE", "value": "true"}, {"name": "ALLOW_HOST_NETWORK_TESTING", "value": "false"}]
            return self._j({"spec": {"template": {"spec": {"containers": [{"env": env}]}}}})
        if a[:2] == ["get", "networkchaos"]:
            live = self.nc_created is not None and not (self.nc_deleted and not self.f.get("stuck"))
            return self._j({"items": [{"metadata": {"name": ec.NAME, "namespace": ec.CHAOS_NS}}] if live else []})
        if s == "-n default get service kubernetes -o json":
            return self._j({"spec": {"clusterIP": "172.20.0.1"}})
        if s == "get nodes -o json":
            return self._j({"items": [{"metadata": {"name": "n1"}, "status": {"addresses": [{"type": "InternalIP", "address": "10.40.1.10"}]}}]})
        if s == "-n default get endpoints kubernetes -o json":
            return self._j({"subsets": [{"addresses": [{"ip": "10.40.1.5"}, {"ip": "10.40.1.6"}]}]})
        if s == "get services -A -o json":
            return self._j({"items": [{"metadata": {"namespace": "git-local", "name": "gitea-http"}, "spec": {"clusterIP": "172.20.5.5"}},
                                      {"metadata": {"namespace": "demo-netpol", "name": "frontend-lb"}, "spec": {"clusterIP": "172.20.9.9"},
                                       "status": {"loadBalancer": {"ingress": [{"ip": self.f.get("lb_ip", "10.40.1.242")}]}}}]})
        if a[:2] == ["get", "namespace"]:
            return self._j({"metadata": {"name": a[2], "annotations": self.ns_ann.get(a[2], {})}})
        if len(a) == 6 and a[0] == "-n" and a[2:4] == ["get", "pods"]:
            ns = a[1]
            pod = {"metadata": {"name": f"{ns}-0"}, "spec": {"hostNetwork": self.f.get("hostnet") == ns},
                   "status": {"podIP": "10.40.1.50", "containerStatuses": [{"restartCount": 1 if (self.f.get("restart") and self.nc_created is not None) else 0}]}}
            return self._j({"items": [pod]})
        if a[:4] == ["-n", "argocd", "get", "secrets"]:
            ann = {"cluster_name": self.d["cluster_name"], "node_subnet_cidr": self.f.get("bridge_node", "10.40.1.0/24"),
                   "kubernetes_service_ip_cidr": "172.20.0.1/32"}
            return self._j({"items": [{"metadata": {"annotations": ann}}]})
        if a[:2] == ["apply", "-f"]:
            if "kind: NetworkChaos" in stdin:
                self.nc_created, self.rules = self.clock.t, True
            if "kind: Pod\n" in stdin:
                self.probe_start = self.clock.t
            return 0, "applied", ""
        if len(a) > 2 and a[2] == "wait":
            return 0, "condition met", ""
        if "nslookup" in a:
            host = a[-1]
            ip = self.f.get("resolve", {}).get(host, REGION_IP if "amazonaws" in host else INTERNET_IP)
            return 0, f"Server:\t\t172.20.0.10\nAddress:\t172.20.0.10:53\n\nNon-authoritative answer:\nName:\t{host}\nAddress: {ip}\n", ""
        if a[2:] == ["exec", "probe", "--", "cat", ec.METRICS_FILE]:
            return self._sample(a[1])
        if s == "get --raw /readyz":
            return 0, "ok", ""
        if a[:4] == ["-n", "argocd", "get", "application"]:
            if self.refreshed:
                self.reconciled = "2026-10-28T10:05:00Z"
            return self._j({"status": {"reconciledAt": self.reconciled, "sync": {"status": "Synced"}}})
        if a[:4] == ["-n", "argocd", "annotate", "application"]:
            self.refreshed = True
            return 0, "", ""
        if a[:2] in (["annotate", "namespace"], ["label", "namespace"]):
            ns, kv = a[2], a[3]
            store = self.ns_ann if a[0] == "annotate" else self.ns_lab
            if kv.endswith("-"):
                store.setdefault(ns, {}).pop(kv[:-1], None)
            else:
                k, v = kv.split("=", 1)
                store.setdefault(ns, {})[k] = v
            return 0, "", ""
        if s == f"-n {ec.CHAOS_NS} get networkchaos {ec.NAME} -o json":
            if self.nc_created is None or self.nc_deleted:
                return 1, "", "NotFound"
            conds = [{"type": "AllInjected", "status": "True" if inj else "False"},
                     {"type": "AllRecovered", "status": "False" if inj else "True"}]
            return self._j({"status": {"conditions": conds}})
        if a[:2] == ["delete", "networkchaos"]:
            if self.nc_created is not None:
                self.nc_deleted = True
            return 0, "", ""
        if s == "get podnetworkchaos -A -o json":
            items = []
            if self.rules:
                items.append({"metadata": {"namespace": "git-local", "name": "git-local-0"},
                              "spec": {"iptables": [{"source": ec.SOURCE}]}})
            return self._j({"items": items})
        if a[:2] == ["get", "namespaces"]:
            marked = [ns for ns, l in self.ns_lab.items() if l.get(ec.MARK) == "true"]
            return 0, "\n".join(f"namespace/{ns}" for ns in marked), ""
        if a[:2] == ["delete", "namespace"]:
            return 0, "", ""
        if "patch" in a and "networkchaos" in a:
            self.f["stuck"] = False
            return 0, "", ""
        if "delete" in a and ("pod" in a or "podnetworkchaos" in a):
            self.rules = False
            return 0, "", ""
        raise AssertionError(f"unexpected call: {a}")

    def index(self, pred):
        return next((i for i, (a, s) in enumerate(self.calls) if pred(a, s)), None)


def run(d=None, **f):
    d = d or inputs(duration="60s")
    clock = Clock(fail_at=f.pop("fail_at", None), wall_jump=f.pop("wall_jump", None), mono_jump=f.pop("mono_jump", None))
    k = FakeKube(d, clock, **f)
    log = []
    rc, rep = ec.run(k, d, clock=clock, log=log.append)
    return rc, rep, k, log


def applied_nc(k):
    return k.index(lambda a, s: a[:2] == ["apply", "-f"] and "kind: NetworkChaos" in (s or ""))


class CutSet(unittest.TestCase):
    def test_preserves_exactly_what_must_survive(self):
        d = inputs()
        cut, pres = ec.cut_set(d)
        for ip in ("10.40.1.5", "10.40.1.242", "172.20.0.1", "172.20.200.1", "10.40.0.10", "127.0.0.1",
                   "169.254.20.10", "169.254.170.23", "169.254.169.254"):
            self.assertFalse(ec.in_cut(ip, cut), ip)
        # rest of the VPC in the Region (NAT, resolver, another subnet), public AWS and Internet: cut
        for ip in ("10.40.0.2", "10.40.0.11", "10.40.2.1", REGION_IP, INTERNET_IP, "192.0.2.53", "198.51.100.53", "255.255.255.254"):
            self.assertTrue(ec.in_cut(ip, cut), ip)
        self.assertEqual(sum(c.num_addresses for c in cut) + sum(p.num_addresses for p in pres), 2 ** 32)
        self.assertFalse(any(c.overlaps(p) for c in cut for p in pres))

    def test_extra_preserve_and_operator_ips_are_carved(self):
        cut, _ = ec.cut_set(inputs(operator_ips=["10.40.0.10", "10.40.0.77"], extra_preserve_cidrs=["192.168.50.0/24"]))
        for ip in ("10.40.0.77", "192.168.50.9"):
            self.assertFalse(ec.in_cut(ip, cut), ip)
        self.assertTrue(ec.in_cut("192.168.51.1", cut))

    def test_empty_cut_is_refused(self):
        # A partition with empty externalTargets and no target cuts ALL pod egress.
        with self.assertRaisesRegex(ec.InputError, "empty"):
            ec.cut_set(inputs(extra_preserve_cidrs=["0.0.0.0/1", "128.0.0.0/1"]))

    def test_bounded_duration(self):
        for ok in ("30s", "5m", "15m"):
            inputs(duration=ok)
        for bad in ("10s", "16m", "1h", "5", "-5m"):
            with self.assertRaises(ec.InputError, msg=bad):
                inputs(duration=bad)

    def test_input_guards(self):
        cases = [dict(target_namespaces=["argocd", "kube-system"]), dict(target_namespaces=["argocd", ec.CONTROL_NS]),
                 dict(target_namespaces=["chaos-mesh"]), dict(target_namespaces=[]),
                 dict(target_namespaces=["argocd", "retail-shop"]),
                 dict(probe_image="harbor.local/library/busybox:1.38.0"), dict(operator_ips=[]),
                 dict(kubernetes_service_ip="10.100.0.1"), dict(node_subnet_cidr="2001:db8::/64"),
                 dict(node_subnet_cidr="10.40.1.1/24"), dict(region_probe="https://sts.amazonaws.com")]
        for c in cases:
            with self.assertRaises(ec.InputError, msg=str(c)):
                inputs(**c)


class Render(unittest.TestCase):
    def test_networkchaos_contract(self):
        d = inputs()
        out = ec.render(d)
        nc = yaml.safe_load(out["networkchaos.yaml"])
        sp = nc["spec"]
        self.assertEqual((sp["action"], sp["direction"], sp["mode"], sp["duration"]), ("partition", "to", "all", "8m"))
        self.assertIn(ec.PROBE_NS, sp["selector"]["namespaces"])
        self.assertNotIn(ec.CONTROL_NS, sp["selector"]["namespaces"])
        self.assertEqual(sp["selector"]["podPhaseSelectors"], ["Running"])
        cut, _ = ec.cut_set(d)
        self.assertEqual(sp["externalTargets"], [str(c) for c in cut])
        for t in sp["externalTargets"]:      # CIDRs only, never a name the controller would resolve
            ipaddress.ip_network(t)
        self.assertEqual(nc["metadata"]["labels"], {ec.LABEL: "true"})

    def test_probes_and_chaos_namespace(self):
        out = ec.render(inputs())
        probes = [x for x in yaml.safe_load_all(out["probes.yaml"])]
        nss = [x for x in probes if x["kind"] == "Namespace"]
        self.assertEqual(sorted(n["metadata"]["name"] for n in nss), sorted([ec.PROBE_NS, ec.CONTROL_NS]))
        self.assertTrue(all(ec.INJECT not in n["metadata"].get("annotations", {}) for n in nss))
        for p in (x for x in probes if x["kind"] == "Pod"):
            self.assertIn("@sha256:", p["spec"]["containers"][0]["image"])
            self.assertFalse(p["spec"].get("hostNetwork", False))
        cm = [x for x in yaml.safe_load_all(out["chaos-mesh-netpol.yaml"])]
        # rollback deletes namespaces carrying LABEL: chaos-mesh must not carry that label
        self.assertTrue(all(ec.LABEL not in x["metadata"].get("labels", {}) for x in cm))
        names = {x["metadata"]["name"] for x in cm if x["kind"] == "NetworkPolicy"}
        self.assertEqual(names, {"default-deny", "allow-dns", "allow-same-namespace", "allow-apiserver", "allow-webhook-from-control-plane"})


CHART_OK = """
kind: Deployment
metadata: {name: chaos-controller-manager}
spec: {template: {spec: {containers: [{name: m, image: 'ghcr.io/chaos-mesh/chaos-mesh:v2.8.7@sha256:aa',
  env: [{name: ENABLE_FILTER_NAMESPACE, value: 'true'}, {name: ALLOW_HOST_NETWORK_TESTING, value: 'false'}]}]}}}
---
kind: DaemonSet
metadata: {name: chaos-daemon}
spec: {template: {spec: {hostPID: true, containers: [{name: d, image: 'ghcr.io/chaos-mesh/chaos-daemon:v2.8.7@sha256:bb',
  command: [/usr/local/bin/chaos-daemon, --runtime, containerd]}]}}}
---
kind: ValidatingWebhookConfiguration
metadata: {name: chaos-mesh-validation}
webhooks: [{rules: [{apiGroups: [chaos-mesh.org]}]}]
---
kind: Service
metadata: {name: chaos-dashboard}
spec: {type: ClusterIP, ports: [{port: 2333}]}
"""


class CheckChart(unittest.TestCase):
    def test_pinned_render_passes(self):
        self.assertEqual(ec.check_chart(CHART_OK), [])

    def test_each_mutation_fails(self):
        muts = {
            "digest": CHART_OK.replace("v2.8.7@sha256:aa", "v2.8.7"),
            "filter": CHART_OK.replace("ENABLE_FILTER_NAMESPACE, value: 'true'", "ENABLE_FILTER_NAMESPACE, value: 'false'"),
            "hostnet-testing": CHART_OK.replace("ALLOW_HOST_NETWORK_TESTING, value: 'false'", "ALLOW_HOST_NETWORK_TESTING, value: 'true'"),
            "hostNetwork": CHART_OK.replace("hostPID: true", "hostPID: true, hostNetwork: true"),
            "runtime": CHART_OK.replace("--runtime, containerd", "--runtime, docker"),
            "webhook-core": CHART_OK.replace("apiGroups: [chaos-mesh.org]", "apiGroups: [chaos-mesh.org, '']"),
            "dns-server": CHART_OK + "---\nkind: Deployment\nmetadata: {name: chaos-mesh-dns-server}\nspec: {template: {spec: {containers: [{image: 'x@sha256:cc'}]}}}\n",
            "no-daemon": CHART_OK.split("---")[0],
            "nodeport": CHART_OK.replace("spec: {type: ClusterIP, ports", "spec: {type: NodePort, ports"),
            "loadbalancer": CHART_OK.replace("spec: {type: ClusterIP, ports", "spec: {type: LoadBalancer, ports"),
        }
        for name, text in muts.items():
            self.assertTrue(ec.check_chart(text), name)


class Run(unittest.TestCase):
    def test_pass_path(self):
        rc, rep, k, log = run()
        self.assertEqual((rc, rep["result"], rep["rollback_clean"]), (ec.RC_PASS, "PASS", True), "\n".join(log))
        during = [r for r in rep["rounds"] if r["phase"] == "during"]
        self.assertTrue(during)
        got = {(r["probe"], r["kind"]): r["got"] for r in during}
        self.assertEqual(got[("inside", "region")], ec.BLOCKED)
        self.assertEqual(got[("inside", "internet")], ec.BLOCKED)
        self.assertEqual(got[("inside", "local")], ec.OPEN)
        self.assertEqual(got[("outside", "region")], ec.OPEN)
        self.assertEqual(got[("operator", "api")], ec.OPEN)
        # namespaces annotated before the apply; no delete before the automatic recovery
        ann = k.index(lambda a, s: a[:2] == ["annotate", "namespace"])
        self.assertLess(ann, applied_nc(k))
        recovered = max(i for i, (a, s) in enumerate(k.calls) if a[3:5] == ["networkchaos", ec.NAME])
        first_delete = k.index(lambda a, s: a[:2] == ["delete", "networkchaos"])
        self.assertGreater(first_delete, recovered)
        self.assertTrue(any("reconciled from the local Gitea" in x for x in log))
        # everything reverted
        self.assertTrue(all(ec.INJECT not in v for v in k.ns_ann.values()))
        self.assertTrue(all(ec.MARK not in v for v in k.ns_lab.values()))

    def test_ineffective_cut_fails_and_rolls_back(self):
        rc, rep, k, _ = run(ineffective=True)
        self.assertEqual((rc, rep["result"]), (ec.RC_FAIL, "FAIL"))
        self.assertIn("during the cut", rep["reason"])
        self.assertTrue(rep["rollback_clean"])
        self.assertTrue(all(ec.INJECT not in v for v in k.ns_ann.values()))

    def test_red_baseline_is_inconclusive_and_injects_nothing(self):
        rc, rep, k, _ = run(local_closed=True)
        self.assertEqual((rc, rep["result"]), (ec.RC_INCONCLUSIVE, "INCONCLUSIVE"))
        self.assertIsNone(applied_nc(k))
        self.assertIsNone(k.index(lambda a, s: a[:2] == ["annotate", "namespace"]))
        self.assertIsNotNone(k.index(lambda a, s: a[:2] == ["delete", "namespace"]))

    def test_missing_auto_recovery_fails(self):
        rc, rep, k, _ = run(no_recover=True)
        self.assertEqual(rc, ec.RC_FAIL)
        self.assertIn("automatic recovery", rep["reason"])
        self.assertTrue(rep["rollback_clean"])

    def test_exec_error_is_never_counted_as_blocked(self):
        rc, rep, _, _ = run(exec_error=True)
        self.assertEqual(rc, ec.RC_FAIL)
        self.assertTrue(any(r["got"] == ec.ERROR for r in rep["rounds"]))

    def test_interrupt_mid_cut_rolls_back(self):
        rc, rep, k, _ = run(fail_at=10)
        self.assertEqual((rc, rep["result"]), (ec.RC_FAIL, "FAIL"))
        self.assertIsNotNone(applied_nc(k))
        self.assertTrue(k.nc_deleted)
        self.assertTrue(rep["rollback_clean"])

    def test_restart_during_cut_fails(self):
        rc, rep, _, _ = run(restart=True)
        self.assertEqual(rc, ec.RC_FAIL)
        self.assertIn("restart", rep["reason"])

    def test_preflight_guards_inject_nothing(self):
        for f in (dict(hostnet="argocd"), dict(bridge_node="10.50.1.0/24"), dict(lb_ip="10.40.0.200"),
                  dict(resolve={"github.com": "10.40.1.99"})):
            rc, rep, k, _ = run(**f)
            self.assertEqual(rc, ec.RC_INCONCLUSIVE, str(f))
            self.assertIsNone(applied_nc(k), str(f))

    def test_preannotated_namespace_is_left_as_found(self):
        rc, _, k, _ = run(preannotated=["victorialogs"])
        self.assertEqual(rc, ec.RC_PASS)
        self.assertEqual(k.ns_ann["victorialogs"].get(ec.INJECT), "enabled")
        self.assertNotIn(ec.MARK, k.ns_lab["victorialogs"])


class Series(unittest.TestCase):
    """Series and report come from the same sample: vocabulary, wall-clock timestamps and the failing controls."""

    ISO = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_rows_carry_the_series_vocabulary(self):
        rc, rep, _, _ = run()
        self.assertEqual(rc, ec.RC_PASS)
        rows = [r for r in rep["rounds"] if r["probe"] != "operator"]
        self.assertEqual({r["vantage"] for r in rows}, {"cut", "control"})
        self.assertEqual({r["target_class"] for r in rows}, {"region", "internet", "local"})
        self.assertTrue(all(r["target_name"] == r["target"] for r in rows))
        # the control measures the SAME probes: the three classes in both vantages
        for v in ("cut", "control"):
            self.assertEqual({r["target_class"] for r in rows if r["vantage"] == v}, {"region", "internet", "local"}, v)
        during = {(r["vantage"], r["target_class"]): r["got"] for r in rows if r["phase"] == "during"}
        self.assertEqual(during[("control", "region")], ec.OPEN)
        self.assertEqual(during[("control", "local")], ec.OPEN)

    def test_report_has_wall_clock_utc_and_epoch(self):
        rc, rep, _, _ = run()
        self.assertEqual(rc, ec.RC_PASS)
        for k in ("all_injected_at", "all_recovered_at"):
            self.assertRegex(rep[k], self.ISO, k)
            self.assertEqual(ec.iso(rep[f"{k}_epoch"]), rep[k], k)
        inj, rec = rep["all_injected_at_epoch"], rep["all_recovered_at_epoch"]
        self.assertLess(inj, rec)
        for r in rep["rounds"]:
            self.assertRegex(r["observed_at"], self.ISO, r)
            self.assertEqual(ec.iso(r["observed_at_epoch"]), r["observed_at"], r)
        cut = [r for r in rep["rounds"] if r["probe"] == "inside"]
        # every "during" sample started after AllInjected and before AllRecovered; every "after" sample after it
        self.assertTrue(all(inj < r["observed_at_epoch"] < rec for r in cut if r["phase"] == "during"))
        self.assertTrue(all(r["observed_at_epoch"] > rec for r in cut if r["phase"] == "after"))
        self.assertTrue(all(r["observed_at_epoch"] <= inj for r in cut if r["phase"] == "before"))
        # the JSON records the sample the pod exposed: the epoch is the value of platform_probe_sample_timestamp_seconds
        self.assertTrue(all(float(r["observed_at_epoch"]).is_integer() for r in cut))

    def test_stale_series_during_cut_fails_as_error_not_blocked(self):
        rc, rep, k, _ = run(stale=True)
        self.assertEqual((rc, rep["result"]), (ec.RC_FAIL, "FAIL"))
        during = [r for r in rep["rounds"] if r["phase"] == "during" and r["probe"] == "inside"]
        self.assertTrue(during and all(r["got"] == ec.ERROR and "stale" in r["detail"] for r in during), during[:1])
        self.assertTrue(rep["rollback_clean"])

    def test_missing_control_vantage_is_inconclusive_and_injects_nothing(self):
        rc, rep, k, _ = run(no_control="always")
        self.assertEqual((rc, rep["result"]), (ec.RC_INCONCLUSIVE, "INCONCLUSIVE"))
        self.assertIsNone(applied_nc(k))
        miss = [r for r in rep["rounds"] if r.get("vantage") == "control"]
        self.assertTrue(miss and all(r["got"] == ec.ERROR and r["detail"] == "missing series" for r in miss))

    def test_control_lost_during_cut_fails(self):
        rc, rep, _, _ = run(no_control="during")
        self.assertEqual(rc, ec.RC_FAIL)
        self.assertIn("outside", rep["reason"])

    def test_wrong_vantage_label_counts_as_missing(self):
        # control pod publishing vantage="cut": the control series does not exist, and it does not become a cut sample
        rc, rep, k, _ = run(wrong_vantage=True)
        self.assertEqual(rc, ec.RC_INCONCLUSIVE)
        self.assertIsNone(applied_nc(k))

    def test_late_sample_never_counts_as_during(self):
        # exec breaks for the whole cut: the first readable sample is already after recovery and cannot become "during"
        rc, rep, _, _ = run(exec_error=True)
        self.assertEqual(rc, ec.RC_FAIL)
        during = [r for r in rep["rounds"] if r["phase"] == "during" and r["probe"] == "inside"]
        self.assertTrue(during and all(r["got"] == ec.ERROR for r in during))

    def test_deadlines_use_monotonic_clock_not_wall(self):
        # an NTP adjustment of the wall clock (+3 h) while the run waits for AllRecovered moves no deadline: PASS.
        # (A jump DURING a cut sample fails on purpose: the sample window is wall clock, and without a way to
        # prove it fell inside the cut the run fails closed.)
        rc, rep, _, log = run(wall_jump=(40, 10800))
        self.assertEqual(rc, ec.RC_PASS, "\n".join(log[-5:]))
        self.assertGreater(rep["all_recovered_at_epoch"] - rep["all_injected_at_epoch"], 10800)
        # pair: the SAME jump on the monotonic clock blows the deadlines (proves they read now(), not wall())
        rc, _, _, _ = run(mono_jump=(10, 10800))
        self.assertEqual(rc, ec.RC_FAIL)


class ReportFile(unittest.TestCase):
    """--report written atomically during the run: a reader sees the partial report during the cut."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(__import__("shutil").rmtree, self.tmp, True)
        self.path = self.tmp / "live-chaos-report.json"

    def _spy_run(self, **f):
        """run() with a concurrent reader: on every sleep and every kubectl call, reads the file as an operator
        script would. Every read must be a complete JSON document; keeps (wall instant, injected?, report read)."""
        d = inputs(duration="60s")
        clock = Clock()
        k = FakeKube(d, clock, **f)
        seen, broken = [], []

        def read():
            if not self.path.exists():
                return
            text = self.path.read_text()
            try:
                seen.append((clock.wall(), k._injected(), json.loads(text)))
            except ValueError:
                broken.append(text)
        sleep, krun = clock.sleep, k.run
        clock.sleep = lambda s: (read(), sleep(s))[1]
        k.run = lambda *a, **kw: (read(), krun(*a, **kw))[1]
        log = []
        rc, rep = ec.run(k, d, clock=clock, log=log.append, report_path=str(self.path))
        read()
        return d, rc, rep, seen, broken, log

    def test_partial_report_is_fresh_while_the_cut_is_active(self):
        d, rc, rep, seen, broken, log = self._spy_run()
        self.assertEqual(rc, ec.RC_PASS, "\n".join(log))
        self.assertEqual(broken, [], "leitor viu JSON truncado")
        during = [(w, r) for w, inj, r in seen if inj and r.get("all_injected_at_epoch")]
        self.assertTrue(during, "no read with the cut active after AllInjected")
        # maximum cadence between two writes = one whole observe round (the fresh_samples deadline)
        bound = d["interval_seconds"] + ec.round_budget(d) + 15
        for w, r in during:
            self.assertIs(r["partial"], True, r)
            self.assertIsNone(r["result"], r)
            self.assertNotIn("all_recovered_at_epoch", r)
            self.assertEqual(ec.iso(r["updated_at_epoch"]), r["updated_at"])
            self.assertLessEqual(w - r["updated_at_epoch"], bound, f"partial with {w - r['updated_at_epoch']}s")
        # "during" rounds reach the file while the cut is still up, not only at the end
        self.assertTrue(any(x["phase"] == "during" for _, r in during for x in r["rounds"]))
        # the first write after AllInjected already carries the stamp, before any "during" round
        first = next(r for _, r in during)
        self.assertEqual(first["all_injected_at_epoch"], rep["all_injected_at_epoch"])

    def test_final_write_closes_the_partial(self):
        _, rc, rep, seen, _, _ = self._spy_run()
        self.assertEqual(rc, ec.RC_PASS)
        last = json.loads(self.path.read_text())
        self.assertIs(last["partial"], True)          # run leaves the last partial; main closes it
        self.assertIn("all_recovered_at_epoch", last)
        ec.write_report(self.path, rep)
        final = json.loads(self.path.read_text())
        self.assertEqual((final["partial"], final["result"]), (False, "PASS"))
        self.assertEqual(final["rounds"], rep["rounds"])
        self.assertEqual(list(self.tmp.iterdir()), [self.path], "a temporary file was left in the directory")

    def test_failed_write_keeps_the_previous_report_whole(self):
        ec.write_report(self.path, {"result": None, "rounds": []}, partial=True)
        before = self.path.read_text()
        # 1) non-serializable object: fails BEFORE opening any file
        with self.assertRaises(TypeError):
            ec.write_report(self.path, {"rounds": [object()]})
        # 2) failure in the middle of the write (fsync), with bytes already in the temporary file: the target does not change
        real = ec.os.fsync
        ec.os.fsync = lambda fd: (_ for _ in ()).throw(OSError("disk full"))
        try:
            with self.assertRaises(OSError):
                ec.write_report(self.path, {"result": "PASS", "rounds": [{"x": "y" * 4096}]})
        finally:
            ec.os.fsync = real
        self.assertEqual(self.path.read_text(), before)
        json.loads(before)
        self.assertEqual(list(self.tmp.iterdir()), [self.path], "a temporary file was left in the directory")

    def test_replace_is_same_directory(self):
        calls, real = [], ec.os.replace
        ec.os.replace = lambda a, b: (calls.append((Path(a), Path(b))), real(a, b))[1]
        try:
            ec.write_report(self.path, {"rounds": []})
        finally:
            ec.os.replace = real
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0].parent, self.path.parent)
        self.assertEqual(calls[0][1], self.path)

    def test_partial_write_error_never_aborts_the_cut(self):
        d = inputs(duration="60s")
        clock = Clock()
        k, log = FakeKube(d, clock), []
        rc, rep = ec.run(k, d, clock=clock, log=log.append, report_path=str(self.tmp / "does-not-exist" / "r.json"))
        self.assertEqual((rc, rep["rollback_clean"]), (ec.RC_PASS, True), "\n".join(log))
        self.assertTrue(any(x.startswith("warning: partial report not written") for x in log))


class ProbeRender(unittest.TestCase):
    def setUp(self):
        self.docs = list(yaml.safe_load_all(ec.render(inputs())["probes.yaml"]))

    def kinds(self, kind):
        return [x for x in self.docs if x["kind"] == kind]

    def test_pods_run_the_same_loop_on_the_pinned_busybox(self):
        pods = self.kinds("Pod")
        self.assertEqual(len(pods), 2)
        env = [{e["name"]: e["value"] for e in p["spec"]["containers"][0]["env"]} for p in pods]
        self.assertEqual({e["VANTAGE"] for e in env}, {"cut", "control"})
        self.assertEqual(env[0]["TARGETS"], env[1]["TARGETS"])
        self.assertIn("region=sts.us-west-2.amazonaws.com:443", env[0]["TARGETS"].split())
        for p in pods:
            c = p["spec"]["containers"][0]
            self.assertEqual(c["image"], json.loads(EXAMPLE.read_text())["probe_image"])
            self.assertEqual(c["command"], ["sh", "-c", ec.PROBE_SCRIPT])
            self.assertTrue(c["securityContext"]["readOnlyRootFilesystem"])
            self.assertEqual(c["volumeMounts"], [{"name": "tmp", "mountPath": "/tmp"}])
            self.assertEqual(c["ports"][0]["containerPort"], ec.METRICS_PORT)

    def test_ingress_only_from_vmagent_on_the_metrics_port(self):
        for np in self.kinds("NetworkPolicy"):
            self.assertEqual(np["spec"]["egress"], [{}])
            ing = np["spec"]["ingress"]
            self.assertEqual(len(ing), 1)
            self.assertEqual(ing[0]["ports"], [{"protocol": "TCP", "port": ec.METRICS_PORT}])
            self.assertEqual(ing[0]["from"], [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "monitoring"}},
                                               "podSelector": {"matchLabels": {"app.kubernetes.io/name": "vmagent"}}}])

    def test_vmagent_egress_policy_already_allows_the_metrics_port(self):
        # The probe reuses the port the vmagent policy already allows; if it changes, this test fails before any run.
        pol = (HERE.parents[1] / "network-policies/monitoring.yaml").read_text()
        doc = next(x for x in yaml.safe_load_all(pol.replace("${OUTPOST_SUBNET_CIDR}", "10.40.1.0/24"))
                   if x and x["spec"].get("podSelector", {}).get("matchLabels") == {"app.kubernetes.io/name": "vmagent"})
        self.assertIn(ec.METRICS_PORT, [p["port"] for e in doc["spec"]["egress"] for p in e.get("ports", [])])

    def test_one_scrape_for_both_vantages(self):
        sc = self.kinds("VMServiceScrape")
        self.assertEqual(len(sc), 1)
        sp = sc[0]["spec"]
        self.assertEqual(sc[0]["metadata"]["namespace"], ec.CONTROL_NS)     # rollback deletes the namespace
        self.assertEqual(sorted(sp["namespaceSelector"]["matchNames"]), sorted([ec.PROBE_NS, ec.CONTROL_NS]))
        self.assertEqual(sp["targetLabels"], ["vantage"])
        self.assertEqual(sp["endpoints"][0]["port"], "http-metrics")
        svcs = self.kinds("Service")
        self.assertEqual({s["metadata"]["labels"]["vantage"] for s in svcs}, {"cut", "control"})
        self.assertTrue(all(s["spec"]["selector"] == sp["selector"]["matchLabels"] for s in svcs))


class ProbeScript(unittest.TestCase):
    """The rendered PROBE_SCRIPT, really running in sh with fake nc, httpd and sleep: one round, and its parse has
    the same shape as the text the fake cluster returns (the fake does not diverge from the real producer)."""

    def test_real_loop_output_parses_like_the_fake(self):
        d = inputs()
        with tempfile.TemporaryDirectory() as tmp:
            t = Path(tmp)
            (t / "bin").mkdir()
            (t / "bin/nc").write_text('#!/bin/sh\ncase "$4" in *amazonaws*|github.com) exit 1;; *) exit 0;; esac\n')
            (t / "bin/httpd").write_text("#!/bin/sh\nexit 0\n")
            (t / "bin/sleep").write_text("#!/bin/sh\nkill -TERM $PPID\n")      # end of the first round
            for f in ("nc", "httpd", "sleep"):
                (t / "bin" / f).chmod(0o755)
            (t / "uptime").write_text("100.00 50.00\n")
            env = {"PATH": f"{t / 'bin'}:/usr/bin:/bin", "UPTIME_FILE": str(t / "uptime"), "VANTAGE": "cut",
                   "TARGETS": " ".join(f"{ec.TARGET_CLASS[k]}={x}" for k, x in ec.probe_targets(d)),
                   "INTERVAL": "60", "NC_WAIT": "4", "PORT": "9797"}
            script = ec.PROBE_SCRIPT.replace("W=/tmp/www", f"W={t / 'www'}")
            p = subprocess.run(["sh", "-c", script], env=env, capture_output=True, text=True, timeout=30)
            text = (t / "www/metrics").read_text()
            self.assertFalse((t / "www/.metrics.tmp").exists())             # atomic swap done
        self.assertRegex(p.stdout, r"egress-chaos-probe vantage=cut round=\d+ region/sts")
        real = ec.parse_metrics(text, "cut")
        self.assertEqual(set(real), {x for _, x in ec.probe_targets(d)})
        self.assertEqual(real[d["region_probe"]]["success"], 0)
        self.assertEqual(real[d["local_probes"][0]]["success"], 1)
        ts = {x["ts"] for x in real.values()}
        self.assertTrue(all(abs(v - time.time()) < 60 for v in ts))
        fake = ec.parse_metrics(fake_metrics("cut", [(v["class"], n, v["success"] == 1, v["latency"], v["ts"])
                                                     for n, v in real.items()]), "cut")
        self.assertEqual(fake, real)
        # the same text read as control does not become a control sample
        self.assertEqual(ec.parse_metrics(text, "control"), {})
        # HELP/TYPE once per metric, series grouped (Prometheus exposition format)
        self.assertEqual([l.split()[2] for l in text.splitlines() if l.startswith("# TYPE")],
                         ["platform_probe_success", "platform_probe_latency_seconds", "platform_probe_sample_timestamp_seconds"])


class Choreography(unittest.TestCase):
    def _render(self, duration, *flags):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "in.json"
            src.write_text(json.dumps({**json.loads(EXAMPLE.read_text()), "duration": duration}))
            rc = ec.main(["render", "--inputs", str(src), "--out", str(Path(tmp) / "out"), *flags])
            nc = Path(tmp) / "out/networkchaos.yaml"
            return rc, yaml.safe_load(nc.read_text())["spec"]["duration"] if nc.exists() else None

    def test_example_is_the_canonical_8m(self):
        self.assertEqual(json.loads(EXAMPLE.read_text())["duration"], ec.CHOREOGRAPHY_DURATION)
        self.assertEqual(self._render("8m", "--choreography"), (ec.RC_PASS, "8m"))

    def test_2m_fails_the_choreography_contract(self):
        self.assertEqual(self._render("2m", "--choreography"), (ec.RC_INPUT, None))
        self.assertEqual(self._render("480s", "--choreography"), (ec.RC_INPUT, None))   # same time, other spelling
        # pair: without the choreography, 2m stays valid for a rehearsal
        self.assertEqual(self._render("2m"), (ec.RC_PASS, "2m"))


class Rollback(unittest.TestCase):
    def _stuck(self):
        d = inputs(duration="60s")
        k = FakeKube(d, Clock(), stuck=True)
        k.nc_created, k.nc_deleted, k.rules = 0.0, False, True
        k.ns_ann["argocd"][ec.INJECT] = "enabled"
        k.ns_lab["argocd"][ec.MARK] = "true"
        return k

    def test_stuck_rules_without_force_reports_incomplete(self):
        k = self._stuck()
        self.assertFalse(ec.rollback(k, k.clock, log=lambda *_: None))
        self.assertNotIn(ec.INJECT, k.ns_ann["argocd"])      # the annotation is removed anyway

    def test_force_clears_finalizers_and_recreates_pods(self):
        k = self._stuck()
        self.assertTrue(ec.rollback(k, k.clock, force=True, log=lambda *_: None))
        self.assertIsNotNone(k.index(lambda a, s: "patch" in a))
        self.assertIsNotNone(k.index(lambda a, s: a[-3:] == ["pod", "git-local-0", "--wait=false"]))

    def test_idempotent_on_clean_cluster(self):
        d = inputs()
        k = FakeKube(d, Clock())
        self.assertTrue(ec.rollback(k, k.clock, log=lambda *_: None))
        self.assertTrue(ec.rollback(k, k.clock, log=lambda *_: None))


class CrdSchema(unittest.TestCase):
    """Validates the NetworkChaos against the openAPIV3Schema of the pinned chart CRD. The chart is not vendored:
    run with EGRESS_CHAOS_CHART=<chaos-mesh-2.8.7.tgz> (install.sh downloads it and checks its sha256)."""

    def test_networkchaos_matches_crd(self):
        import os, tarfile
        tgz = os.environ.get("EGRESS_CHAOS_CHART")
        if not tgz:
            self.skipTest("EGRESS_CHAOS_CHART not set")
        import jsonschema
        with tarfile.open(tgz) as t:
            crd = yaml.safe_load(t.extractfile("chaos-mesh/crds/chaos-mesh.org_networkchaos.yaml").read())
        schema = next(v for v in crd["spec"]["versions"] if v["name"] == "v1alpha1")["schema"]["openAPIV3Schema"]
        nc = yaml.safe_load(ec.render(inputs())["networkchaos.yaml"])
        jsonschema.validate(nc, schema)
        bad = copy.deepcopy(nc)
        bad["spec"]["direction"] = "sideways"
        with self.assertRaises(jsonschema.ValidationError):     # control: the schema read really fails it
            jsonschema.validate(bad, schema)


class Cli(unittest.TestCase):
    def test_render_and_input_error_rc(self):
        with tempfile.TemporaryDirectory() as tmp:
            out, bad = Path(tmp) / "out", Path(tmp) / "bad.json"
            self.assertEqual(ec.main(["render", "--inputs", str(EXAMPLE), "--out", str(out)]), 0)
            self.assertEqual(sorted(p.name for p in out.iterdir()),
                             ["chaos-mesh-netpol.yaml", "cut-set.txt", "networkchaos.yaml", "probes.yaml"])
            bad.write_text(json.dumps({**json.loads(EXAMPLE.read_text()), "duration": "2h"}))
            self.assertEqual(ec.main(["render", "--inputs", str(bad), "--out", str(out / "x")]), ec.RC_INPUT)
            self.assertFalse((out / "x").exists())

    def test_retail_target_is_refused_before_any_kubectl_call(self):
        """retail-* in target_namespaces exits rc 2 BEFORE annotating a namespace or creating a NetworkChaos. The fake
        kubectl records every call; the pair without retail-* proves the same kubectl is really called."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            argv, kc = tmp / "argv.txt", tmp / "kubectl"
            kc.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{argv}"\nexit 7\n')
            kc.chmod(0o755)
            base = json.loads(EXAMPLE.read_text())
            for cmd in ("run", "rollback"):
                for ns in (["argocd", "retail-shop"], ["retail-shop1029"]):
                    bad = tmp / "bad.json"
                    bad.write_text(json.dumps({**base, "target_namespaces": ns}))
                    rc = ec.main([cmd, "--inputs", str(bad), "--kubectl", str(kc), "--context", "ctx"])
                    self.assertEqual(rc, ec.RC_INPUT, f"{cmd} {ns}")
                    self.assertFalse(argv.exists(), f"{cmd} {ns}: kubectl called before the refusal")
            for name in ("retail", "retailer", "shop-retail-1"):   # only the retail- prefix is refused
                inputs(target_namespaces=["argocd", name])
            ok = tmp / "ok.json"
            ok.write_text(json.dumps(base))
            try:   # rollback with a failing kubectl keeps retrying: only reaching kubectl matters
                subprocess.run([sys.executable, str(HERE.parent / "egress_chaos.py"), "rollback", "--inputs", str(ok),
                                "--kubectl", str(kc), "--context", "ctx"], capture_output=True, timeout=5)
            except subprocess.TimeoutExpired:
                pass
            self.assertTrue(argv.exists() and argv.read_text().strip(), "control: the fake kubectl must be called")


# The pinned Chaos Mesh release. A version bump changes this table, install.sh and chaos-mesh-values.yaml together.
PIN = {
    "version": "2.8.7",
    "chart_sha256": "c963e0f4ed2e30c1c7e236477f1c31fcf988b171991801bbe392546948436d38",
    "controllerManager": "sha256:b617afa786a654eb6ba3a947a40d9e20db2bae8f17ded71947d5744dceea2ae4",
    "chaosDaemon": "sha256:87d5d2091bc134b857dba1e391b4bd3148a670e05243fe75b2e944cda166a92e",
    "dashboard": "sha256:7dfce19003e4f72e9cd48b453312c515b17262f18c08cdf0f67cfcaa1e2ac2fa",
}
VALUES = HERE.parent / "chaos-mesh-values.yaml"
INSTALL = HERE.parent / "install.sh"


def pinned_findings(values_text, install_text):
    """Findings on the real values file and installer; an empty list means they match the pin and the defenses."""
    fails, v = [], yaml.safe_load(values_text) or {}
    shell = dict(re.findall(r"^(CHART_VERSION|CHART_SHA256)=(\S+)$", install_text, re.M))
    if shell.get("CHART_VERSION") != PIN["version"] or shell.get("CHART_SHA256") != PIN["chart_sha256"]:
        fails.append(f"install.sh pin {shell} differs from {PIN['version']}/{PIN['chart_sha256']}")
    manager = v.get("controllerManager") or {}
    if manager.get("enableFilterNamespace") is not True:
        fails.append("controllerManager.enableFilterNamespace is not true")
    if manager.get("allowHostNetworkTesting") is not False:
        fails.append("controllerManager.allowHostNetworkTesting is not false")
    if (v.get("dnsServer") or {}).get("create") is not False:
        fails.append("dnsServer.create is not false")
    if (v.get("chaosDaemon") or {}).get("runtime") != "containerd":
        fails.append("chaosDaemon.runtime is not containerd")
    if (v.get("images") or {}).get("tag") != "v" + PIN["version"]:
        fails.append("images.tag differs from the pinned version")
    for component in ("controllerManager", "chaosDaemon", "dashboard"):
        tag = str(((v.get(component) or {}).get("image") or {}).get("tag", ""))
        if tag != f"v{PIN['version']}@{PIN[component]}":
            fails.append(f"{component}.image.tag {tag!r} is not the pinned digest")
    if ((v.get("dashboard") or {}).get("service") or {}).get("type") != "ClusterIP":
        fails.append("dashboard.service.type is not ClusterIP (the chart default is NodePort)")
    if re.search(r"(?i)hostnetwork\s*:\s*true", values_text):
        fails.append("values enable hostNetwork")
    return fails


class PinnedValues(unittest.TestCase):
    """Reads the files that install.sh really uses, not a synthetic render."""

    def test_real_files_match_the_pin_and_the_defenses(self):
        self.assertEqual(pinned_findings(VALUES.read_text(), INSTALL.read_text()), [])

    def test_each_mutation_fails(self):
        values, install = VALUES.read_text(), INSTALL.read_text()
        muts = {
            "host-network-testing": (values.replace("allowHostNetworkTesting: false", "allowHostNetworkTesting: true"), install),
            "filter-namespace": (values.replace("enableFilterNamespace: true", "enableFilterNamespace: false"), install),
            "image-without-digest": (values.replace("v2.8.7@" + PIN["chaosDaemon"], "v2.8.7"), install),
            "other-digest": (values.replace(PIN["dashboard"], "sha256:" + "0" * 64), install),
            "chart-sha": (values, install.replace(PIN["chart_sha256"], "0" * 64)),
            "chart-version": (values, install.replace("CHART_VERSION=2.8.7", "CHART_VERSION=2.8.6")),
            "nodeport": (values.replace("    type: ClusterIP\n", "    type: NodePort\n"), install),
            "dns-server": (values.replace("  create: false\n", "  create: true\n", 1), install),
            "runtime": (values.replace("runtime: containerd", "runtime: docker"), install),
        }
        for name, (v, i) in muts.items():
            self.assertNotEqual((v, i), (values, install), f"mutation {name} did not change the files")
            self.assertTrue(pinned_findings(v, i), name)


# The Crossplane core runs hostNetwork, so crossplane-system is never a cut target and the providers keep reaching
# the Region during the cut. No document may claim the opposite.
EXTENSION = HERE.parents[3]
CUT_ACTOR = re.compile(r"\b(?:Crossplane|providers?|XRs?|claims?|crossplane-system)\b")
CUT_WORD = re.compile(r"\b(?:egress cut|the cut|during the cut|cut)\b", re.I)
CUT_CLAIM = re.compile(r"Synced=False|creates nothing|loses? (?:the )?Region|cannot reach the Region|no egress", re.I)
CUT_SAFE = re.compile(r"not a cut target|outside the cut|stays? out|keep reaching|not covered by the cut|not a control", re.I)


def cut_claims(text, about_the_cut=False):
    """Sentences or table cells that tie Crossplane to the egress cut as if the cut blocked it. In a document about
    the cut (about_the_cut) the cut is implicit, unless the sentence is about a Service Link disconnection."""
    pieces = [p for line in text.splitlines() for cell in line.split("|") for p in re.split(r"(?<=[.;:])\s+", cell)]
    return [p.strip() for p in pieces if CUT_ACTOR.search(p)
            and (CUT_WORD.search(p) or (about_the_cut and "Service Link" not in p))
            and CUT_CLAIM.search(p) and not CUT_SAFE.search(p)]


class DocsMatchTheCut(unittest.TestCase):
    def test_crossplane_is_not_a_cut_target(self):
        values = yaml.safe_load((EXTENSION / "platform/components/crossplane/values.yaml").read_text())
        self.assertIs(values.get("hostNetwork"), True, "Crossplane hostNetwork changed: revisit the docs and this test")
        self.assertNotIn("crossplane-system", json.loads(EXAMPLE.read_text())["target_namespaces"])

    def test_no_document_claims_the_cut_stops_crossplane(self):
        found = {str(p.relative_to(EXTENSION)): cut_claims(p.read_text(), about_the_cut=HERE.parent in p.parents)
                 for p in EXTENSION.rglob("*.md") if ".runtime" not in p.parts}
        self.assertEqual({k: v for k, v in found.items() if v}, {})

    def test_controls(self):
        for wrong in ("During the egress cut or a Service Link disconnection the XR stays `Synced=False`.",
                      "| Components that depend on AWS (Crossplane providers, the Argo CD repo server egress) lose the Region |",
                      "- Serverless recipe: a claim opened during the cut stays `Synced=False` and creates nothing."):
            self.assertTrue(cut_claims(wrong, about_the_cut=wrong.startswith("|")), wrong)
        for right in ("During a Service Link disconnection the XR stays `Synced=False`.",
                      "The egress cut does not stop it: `crossplane-system` is not a cut target, so the providers keep reaching the Region.",
                      "| Target pods that call out (the Argo CD repo server egress) lose the Region |"):
            self.assertFalse(cut_claims(right, about_the_cut=True), right)


if __name__ == "__main__":
    unittest.main()
