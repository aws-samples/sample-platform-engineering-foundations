#!/usr/bin/env python3
"""egress_chaos.py - time-boxed cut of the platform pods' egress to the Region and the Internet, with Chaos Mesh.

The cut is a NetworkChaos `partition`, `direction: to`, whose `externalTargets` are the IPv4 complement of the
preserved set. Preserved: the Outpost subnet (nodes, pods, control plane ENIs), the service CIDR, loopback,
link-local (NodeLocal DNS, Pod Identity agent, instance metadata), the operator IPs (the named exception for the
management path), and optional extra local CIDRs. Everything else drops, including the rest of the VPC in the
Region. Targets are CIDRs only, never names, so the set does not depend on DNS at injection time.

Probes and metrics: two probe pods (vantage `cut` inside the cut, `control` outside it) run the SAME TCP loop,
write each sample atomically in Prometheus text format and serve `/metrics` with BusyBox `httpd` on port 9797.
vmagent scrapes them through the VMServiceScrape of probes.yaml. `run` reads the latest sample from each pod
every round, so the JSON report and the series come from the same measurement: every report row carries
`observed_at` (UTC) and the sample epoch, which is the value of `platform_probe_sample_timestamp_seconds`.
Deadlines use the monotonic clock; the wall clock only stamps events and samples.

Report: with --report, `run` writes the JSON ATOMICALLY (temporary file in the same directory, fsync and
os.replace) after every probe round and right after AllInjected, with `partial: true` and `updated_at[_epoch]`.
A reader during the cut always sees a complete JSON document. The final write carries `partial: false` and the
`result`.

Subcommands:
  render      --inputs X --out DIR [--choreography]
              writes networkchaos.yaml, probes.yaml, chaos-mesh-netpol.yaml and cut-set.txt; offline.
              --choreography requires the canonical scene duration (8m) and refuses any other
  check-chart --render FILE|-               checks the Chaos Mesh `helm template` output before install
  run         --inputs X [--context C] [--kubeconfig K] [--report R] [--skip-argocd-refresh] [--choreography]
              preflight, baseline, cut, observation, automatic recovery, controls after recovery and cleanup
  rollback    --inputs X [--context C] [--kubeconfig K] [--force]
              removes the experiment, annotations and probes; idempotent

rc: 0 PASS/ok; 1 FAIL (the cut was injected and something diverged, or the recovery failed); 2 invalid input;
    3 INCONCLUSIVE (a precondition or the baseline was not green: nothing was injected).
"""
import argparse, contextlib, ipaddress, json, os, re, signal, subprocess, sys, tempfile, time
from pathlib import Path

import yaml

NAME = "platform-egress-cut"
CHAOS_NS = "chaos-mesh"
SOURCE = f"{CHAOS_NS}/{NAME}"          # `source` field of the rules the controller writes into PodNetworkChaos
LABEL = "egress-chaos.demo/managed"
MARK = "egress-chaos.demo/annotated"   # namespace label set by THIS run; rollback reverts only these
INJECT = "chaos-mesh.org/inject"
PROBE_NS, CONTROL_NS = "egress-chaos-probe", "egress-chaos-control"
FORBIDDEN_NS = {"kube-system", "kube-public", "kube-node-lease", "default", CHAOS_NS, CONTROL_NS}
RETAIL_PREFIX = "retail-"   # Retail Store namespaces (platform/apps/retail-store): never a cut target
ALWAYS_PRESERVE = ("127.0.0.0/8", "169.254.0.0/16")
MIN_S, MAX_S = 30, 900
MAX_CUT = 128
INJECT_TIMEOUT, RECOVER_GRACE, CLEAN_TIMEOUT = 90, 120, 90
RC_PASS, RC_FAIL, RC_INPUT, RC_INCONCLUSIVE = 0, 1, 2, 3
OPEN, BLOCKED, ERROR = "open", "blocked", "error"
# Canonical scene duration: covers enabling the Retail Store, the local sync and its cold start during the cut.
CHOREOGRAPHY_DURATION = "8m"
# Series contract. 9797 is a metrics port that the vmagent egress policy already allows to the Outpost subnet
# (platform/components/network-policies/monitoring.yaml), so the probes need no change to a shared policy.
METRICS_PORT, METRICS_FILE = 9797, "/tmp/www/metrics"
VANTAGE = {PROBE_NS: "cut", CONTROL_NS: "control"}
TARGET_CLASS = {"region": "region", "internet": "internet", "local": "local"}
SCRAPE = "egress-chaos-probes"
NC_WAIT_S = 4        # timeout of each probe connect (nc -w)
SKEW_S = 2           # tolerance between the operator clock and the node clock when comparing samples with events
STALE_AFTER_S = 90   # age after which a series is stale; the same number is in queries.yaml
SERIES = re.compile(r'^(platform_probe_(?:success|latency_seconds|sample_timestamp_seconds))\{([^}]*)\} (\S+)$')
LABEL_PAIR = re.compile(r'([a-z_]+)="([^"]*)"')
HOSTPORT = re.compile(r"^[a-z0-9]{1}([a-z0-9.-]{0,251}[a-z0-9])?:[0-9]{1,5}$")
DEFAULT_LOCAL = [
    "kubernetes.default.svc.cluster.local:443",
    "gitea-http.git-local.svc.cluster.local:3000",
    "harbor.registry-local.svc.cluster.local:443",
    "argocd-server.argocd.svc.cluster.local:80",
    "vmsingle-victoria-metrics-victoria-metrics-k8s-stack.monitoring.svc.cluster.local:8428",
    "victorialogs-server.victorialogs.svc.cluster.local:9428",
]


class InputError(Exception):
    pass


class Abort(Exception):
    """A precondition or the baseline failed before any injection."""


class Fail(Exception):
    """Something diverged after the injection."""


# ---------------------------------------------------------------- inputs and cut set

def parse_duration(s):
    m = re.fullmatch(r"([0-9]+)(s|m)", str(s))
    if not m:
        raise InputError(f"duration {s!r}: use <n>s or <n>m, for example 5m")
    secs = int(m.group(1)) * (60 if m.group(2) == "m" else 1)
    if not MIN_S <= secs <= MAX_S:
        raise InputError(f"duration {s!r}: outside {MIN_S}s..{MAX_S}s; the cut is time-boxed by construction")
    return secs


def _net(v, what):
    try:
        n = ipaddress.ip_network(v, strict=True)
    except ValueError as e:
        raise InputError(f"{what} {v!r}: {e}")
    if n.version != 4:
        raise InputError(f"{what} {v!r}: IPv4 only")
    return n


def load_inputs(path):
    try:
        d = json.loads(Path(path).read_text())
    except (OSError, ValueError) as e:
        raise InputError(f"unreadable inputs: {e}")
    req = ["cluster_name", "node_subnet_cidr", "service_cidr", "kubernetes_service_ip", "operator_ips",
           "target_namespaces", "duration", "region_probe", "internet_probe", "probe_image"]
    miss = [k for k in req if k not in d]
    if miss:
        raise InputError(f"inputs missing {', '.join(miss)}")
    d.setdefault("extra_preserve_cidrs", [])
    d.setdefault("local_probes", list(DEFAULT_LOCAL))
    d.setdefault("interval_seconds", 20)
    d.setdefault("argocd_root_application", "platform-root")
    d["_node"] = _net(d["node_subnet_cidr"], "node_subnet_cidr")
    d["_svc"] = _net(d["service_cidr"], "service_cidr")
    try:
        kip = ipaddress.ip_address(d["kubernetes_service_ip"])
    except ValueError as e:
        raise InputError(f"kubernetes_service_ip: {e}")
    if kip not in d["_svc"]:
        raise InputError(f"kubernetes_service_ip {kip} outside service_cidr {d['_svc']}")
    if not d["operator_ips"]:
        raise InputError("operator_ips is empty: the management exception is mandatory and named")
    d["_ops"] = [_net(f"{ipaddress.ip_address(x)}/32", "operator_ips") for x in d["operator_ips"]]
    d["_extra"] = [_net(x, "extra_preserve_cidrs") for x in d["extra_preserve_cidrs"]]
    ns = d["target_namespaces"]
    if not ns or len(set(ns)) != len(ns):
        raise InputError("target_namespaces is empty or has duplicates")
    bad = sorted(set(ns) & FORBIDDEN_NS)
    if bad:
        raise InputError(f"target_namespaces includes a forbidden namespace: {', '.join(bad)}")
    retail = sorted(n for n in ns if str(n).startswith(RETAIL_PREFIX))
    if retail:
        raise InputError(f"target_namespaces includes a Retail namespace: {', '.join(retail)}; the store is created "
                         "during the cut and its isolation comes from its NetworkPolicy, never from Chaos Mesh")
    for p in [d["region_probe"], d["internet_probe"], *d["local_probes"]]:
        if not HOSTPORT.match(p):
            raise InputError(f"probe {p!r}: use lowercase host:port")
    if "@sha256:" not in d["probe_image"]:
        raise InputError("probe_image needs a digest (@sha256:)")
    d["_secs"] = parse_duration(d["duration"])
    if not 5 <= int(d["interval_seconds"]) <= 60:
        raise InputError("interval_seconds outside 5..60")
    return d


def check_choreography(d):
    """Scene contract: exactly 8m. The 30s..15m bound still applies to rehearsals; the scene accepts no other value."""
    if d["duration"] != CHOREOGRAPHY_DURATION:
        raise InputError(f"duration {d['duration']!r}: the demo choreography requires exactly {CHOREOGRAPHY_DURATION}")


def preserve_set(d):
    return list(ipaddress.collapse_addresses(
        [d["_node"], d["_svc"], *d["_ops"], *d["_extra"], *(ipaddress.ip_network(x) for x in ALWAYS_PRESERVE)]))


def complement(preserve):
    rest = [ipaddress.ip_network("0.0.0.0/0")]
    for p in preserve:
        nxt = []
        for r in rest:
            if not r.overlaps(p):
                nxt.append(r)
            elif p.subnet_of(r):
                nxt.extend(r.address_exclude(p))
            # r inside p: dropped entirely
        rest = nxt
    return sorted(ipaddress.collapse_addresses(rest))


def cut_set(d):
    """Cut set and the invariants that make the NetworkChaos safe. Raises InputError."""
    pres = preserve_set(d)
    cut = complement(pres)
    # An empty externalTargets list without target makes the partition drop ALL pod egress
    # (SetDrop in controllers/chaosimpl/networkchaos/partition/impl.go, v2.8.7).
    if not cut:
        raise InputError("empty cut set: Chaos Mesh would cut all egress")
    if len(cut) > MAX_CUT:
        raise InputError(f"cut set with {len(cut)} CIDRs (> {MAX_CUT}): consolidate extra_preserve_cidrs")
    if any(c.prefixlen == 0 for c in cut):
        raise InputError("/0 CIDR in the cut")
    if any(c.overlaps(p) for c in cut for p in pres):
        raise InputError("cut and preserved sets overlap")
    if sum(c.num_addresses for c in cut) + sum(p.num_addresses for p in pres) != 2 ** 32:
        raise InputError("cut + preserved do not cover the IPv4 space exactly once")
    return cut, pres


def in_cut(ip, cut):
    a = ipaddress.ip_address(ip)
    return a.version == 4 and any(a in c for c in cut)


# ---------------------------------------------------------------- render

def selector_namespaces(d):
    return sorted({*d["target_namespaces"], PROBE_NS})


def probe_targets(d):
    """(kind, host:port) measured by BOTH probes. Same list in both vantages: only the location changes."""
    return [("region", d["region_probe"]), ("internet", d["internet_probe"])] + [("local", t) for t in d["local_probes"]]


def round_budget(d):
    """Upper bound of one probe round: each connect waits at most NC_WAIT_S, plus 1 s of slack per target."""
    return (NC_WAIT_S + 1) * len(probe_targets(d))


# Pod loop (BusyBox ash). Each target carries its own start timestamp, the whole sample is written to a
# temporary file and swapped in with mv (a scrape never reads half a sample), and the next round starts
# INTERVAL seconds after the previous one. UPTIME_FILE exists only so the test runs this same text outside
# Linux; in the pod it is /proc/uptime (hundredths of a second, monotonic, no dependency on date +%N).
PROBE_SCRIPT = r"""set -u
W=/tmp/www; U=${UPTIME_FILE:-/proc/uptime}
mkdir -p "$W"
httpd -f -p "$PORT" -h "$W" &
up() { read -r x _ < "$U"; echo "$x"; }
while :; do
  r=$(date +%s); s=""; l=""; t=""; sum=""
  for e in $TARGETS; do
    c=${e%%=*}; n=${e#*=}; ts=$(date +%s); a=$(up)
    if nc -z -w "$NC_WAIT" "${n%:*}" "${n##*:}" >/dev/null 2>&1; then v=1; else v=0; fi
    b=$(up)
    k="vantage=\"$VANTAGE\",target_class=\"$c\",target_name=\"$n\""
    s="$s
platform_probe_success{$k} $v"
    l="$l
platform_probe_latency_seconds{$k} $(awk -v a="$a" -v b="$b" 'BEGIN{printf "%.2f", b-a}')"
    t="$t
platform_probe_sample_timestamp_seconds{$k} $ts"
    sum="$sum $c/$n=$v"
  done
  {
    echo "# HELP platform_probe_success 1 when the TCP connect to target_name succeeded in this sample, else 0."
    echo "# TYPE platform_probe_success gauge"; echo "${s#?}"
    echo "# HELP platform_probe_latency_seconds Seconds spent on the TCP connect, including the timeout when it fails."
    echo "# TYPE platform_probe_latency_seconds gauge"; echo "${l#?}"
    echo "# HELP platform_probe_sample_timestamp_seconds Unix time when this sample of the target started."
    echo "# TYPE platform_probe_sample_timestamp_seconds gauge"; echo "${t#?}"
  } > "$W/.metrics.tmp" && mv "$W/.metrics.tmp" "$W/metrics"
  echo "egress-chaos-probe vantage=$VANTAGE round=$r$sum"
  w=$((r + INTERVAL - $(date +%s)))
  [ "$w" -gt 0 ] && sleep "$w"
done
"""


def render(d):
    cut, pres = cut_set(d)
    meta = {"labels": {LABEL: "true"}}
    nc = {
        "apiVersion": "chaos-mesh.org/v1alpha1", "kind": "NetworkChaos",
        "metadata": {"name": NAME, "namespace": CHAOS_NS, **meta},
        "spec": {"action": "partition", "mode": "all", "direction": "to", "duration": d["duration"],
                 "selector": {"namespaces": selector_namespaces(d), "podPhaseSelectors": ["Running"]},
                 "externalTargets": [str(c) for c in cut]},
    }
    probes = []
    app = {"app.kubernetes.io/name": "egress-chaos-probe"}
    targets = " ".join(f"{TARGET_CLASS[k]}={t}" for k, t in probe_targets(d))
    for ns in (PROBE_NS, CONTROL_NS):
        probes += [
            {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": ns, **meta}},
            # The VPC CNI runs in strict mode: a pod without a policy has no network. The probe may reach any
            # destination and only accepts the vmagent scrape, on the metrics port.
            {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
             "metadata": {"name": "probe-egress-and-scrape", "namespace": ns, **meta},
             "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"], "egress": [{}],
                      "ingress": [{"from": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "monitoring"}},
                                             "podSelector": {"matchLabels": {"app.kubernetes.io/name": "vmagent"}}}],
                                   "ports": [{"protocol": "TCP", "port": METRICS_PORT}]}]}},
            {"apiVersion": "v1", "kind": "Pod",
             "metadata": {"name": "probe", "namespace": ns, "labels": {LABEL: "true", **app}},
             "spec": {"automountServiceAccountToken": False, "terminationGracePeriodSeconds": 1,
                      "securityContext": {"runAsNonRoot": True, "runAsUser": 65534,
                                          "seccompProfile": {"type": "RuntimeDefault"}},
                      "containers": [{
                          "name": "probe", "image": d["probe_image"], "command": ["sh", "-c", PROBE_SCRIPT],
                          "env": [{"name": "VANTAGE", "value": VANTAGE[ns]}, {"name": "TARGETS", "value": targets},
                                  {"name": "INTERVAL", "value": str(int(d["interval_seconds"]))},
                                  {"name": "NC_WAIT", "value": str(NC_WAIT_S)}, {"name": "PORT", "value": str(METRICS_PORT)}],
                          "ports": [{"name": "http-metrics", "containerPort": METRICS_PORT}],
                          "readinessProbe": {"exec": {"command": ["test", "-s", METRICS_FILE]}, "periodSeconds": 2},
                          "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
                                              "capabilities": {"drop": ["ALL"]}},
                          "volumeMounts": [{"name": "tmp", "mountPath": "/tmp"}],
                          "resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}}}],
                      "volumes": [{"name": "tmp", "emptyDir": {"sizeLimit": "1Mi"}}]}},
            # The Service label `vantage` becomes a target label (targetLabels): the scrape `up` also says which
            # vantage dropped, and a missing `control` shows up as a missing series, not as the Region being down.
            {"apiVersion": "v1", "kind": "Service",
             "metadata": {"name": "probe-metrics", "namespace": ns, "labels": {LABEL: "true", **app, "vantage": VANTAGE[ns]}},
             "spec": {"selector": app, "ports": [{"name": "http-metrics", "port": METRICS_PORT, "targetPort": "http-metrics"}]}},
        ]
    # One VMServiceScrape for both vantages. It lives in the control namespace, which rollback deletes with it.
    probes.append({
        "apiVersion": "operator.victoriametrics.com/v1beta1", "kind": "VMServiceScrape",
        "metadata": {"name": SCRAPE, "namespace": CONTROL_NS, **meta},
        "spec": {"namespaceSelector": {"matchNames": [PROBE_NS, CONTROL_NS]},
                 "selector": {"matchLabels": app}, "targetLabels": ["vantage"],
                 "endpoints": [{"port": "http-metrics", "path": "/metrics", "interval": "10s", "honorLabels": True}]}})
    # Separate label: rollback deletes namespaces carrying LABEL, and chaos-mesh only leaves through uninstall.
    cmeta = {"labels": {"egress-chaos.demo/part-of": "chaos-mesh"}}
    np = lambda name, spec: {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
                             "metadata": {"name": name, "namespace": CHAOS_NS, **cmeta}, "spec": spec}
    kdns = {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}},
            "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}
    node, kip = str(d["_node"]), f"{d['kubernetes_service_ip']}/32"
    netpol = [
        {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": CHAOS_NS, **cmeta}},
        np("default-deny", {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]}),
        np("allow-dns", {"podSelector": {}, "policyTypes": ["Egress"],
                         "egress": [{"to": [kdns], "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}]}]}),
        # controller -> chaos-daemon (gRPC 31767) and dashboard -> controller stay inside the namespace
        np("allow-same-namespace", {"podSelector": {}, "policyTypes": ["Ingress", "Egress"],
                                    "ingress": [{"from": [{"podSelector": {}}]}], "egress": [{"to": [{"podSelector": {}}]}]}),
        np("allow-apiserver", {"podSelector": {}, "policyTypes": ["Egress"],
                               "egress": [{"to": [{"ipBlock": {"cidr": kip}}, {"ipBlock": {"cidr": node}}],
                                           "ports": [{"protocol": "TCP", "port": 443}]}]}),
        # Chaos Mesh webhooks (chaos-mesh.org group only), called by the API server whose ENIs are in the Outpost subnet
        np("allow-webhook-from-control-plane", {
            "podSelector": {"matchLabels": {"app.kubernetes.io/component": "controller-manager"}},
            "policyTypes": ["Ingress"],
            "ingress": [{"from": [{"ipBlock": {"cidr": node}}], "ports": [{"protocol": "TCP", "port": 10250}]}]}),
    ]
    lines = [f"# cut {NAME} ({d['cluster_name']}), duration {d['duration']}",
             f"# selector: {', '.join(selector_namespaces(d))}", "# preserved:"]
    lines += [f"keep {p}" for p in pres] + ["# cut (externalTargets):"] + [f"cut  {c}" for c in cut]
    return {"networkchaos.yaml": yaml.safe_dump(nc, sort_keys=False),
            "probes.yaml": yaml.safe_dump_all(probes, sort_keys=False),
            "chaos-mesh-netpol.yaml": yaml.safe_dump_all(netpol, sort_keys=False),
            "cut-set.txt": "\n".join(lines) + "\n"}


# ---------------------------------------------------------------- chart gate

def check_chart(text):
    """Findings on the chart render; an empty list means ok."""
    fails, seen = [], set()
    for doc in yaml.safe_load_all(text):
        if not doc:
            continue
        kind, name = doc.get("kind"), doc.get("metadata", {}).get("name")
        seen.add((kind, name))
        if kind in ("Deployment", "DaemonSet"):
            ps = doc["spec"]["template"]["spec"]
            if ps.get("hostNetwork"):
                fails.append(f"{kind}/{name}: hostNetwork")
            for c in ps.get("containers", []) + ps.get("initContainers", []):
                if "@sha256:" not in c.get("image", ""):
                    fails.append(f"{kind}/{name}: image without digest {c.get('image')}")
                env = {e["name"]: e.get("value") for e in c.get("env", [])}
                if name == "chaos-controller-manager":
                    if env.get("ENABLE_FILTER_NAMESPACE") != "true":
                        fails.append("controller-manager: ENABLE_FILTER_NAMESPACE != true")
                    if env.get("ALLOW_HOST_NETWORK_TESTING") != "false":
                        fails.append("controller-manager: ALLOW_HOST_NETWORK_TESTING != false")
                if name == "chaos-daemon" and "containerd" not in (c.get("command") or []) + (c.get("args") or []):
                    fails.append("chaos-daemon: runtime != containerd")
        if kind == "Service" and (doc.get("spec") or {}).get("type", "ClusterIP") != "ClusterIP":
            fails.append(f"Service/{name}: type {doc['spec']['type']} exposes Chaos Mesh outside the cluster")
        if kind in ("MutatingWebhookConfiguration", "ValidatingWebhookConfiguration"):
            groups = {g for w in doc.get("webhooks", []) for r in w.get("rules", []) for g in r.get("apiGroups", [])}
            if groups - {"chaos-mesh.org"}:
                fails.append(f"{kind}/{name}: webhook outside chaos-mesh.org: {sorted(groups)}")
    for need in ("chaos-controller-manager", "chaos-daemon"):
        if not any(n == need for _, n in seen):
            fails.append(f"render without {need}")
    if any(n and "dns-server" in n for _, n in seen):
        fails.append("render with chaos-dns-server (dnsServer.create must be false)")
    return fails


# ---------------------------------------------------------------- cluster

class Kube:
    def __init__(self, kubectl="kubectl", context=None, kubeconfig=None):
        self.base = [kubectl] + (["--kubeconfig", kubeconfig] if kubeconfig else []) + (["--context", context] if context else [])

    def run(self, args, stdin=None, timeout=60):
        try:
            p = subprocess.run(self.base + list(args), input=stdin, capture_output=True, text=True, timeout=timeout)
            return p.returncode, p.stdout, p.stderr
        except subprocess.TimeoutExpired:
            return 124, "", f"timeout {timeout}s"


class Clock:
    # now: deadlines and intervals (monotonic, immune to NTP adjustments). wall: only to stamp events and samples.
    now = staticmethod(time.monotonic)
    wall = staticmethod(time.time)
    sleep = staticmethod(time.sleep)


def kjson(kube, args):
    rc, out, err = kube.run(list(args) + ["-o", "json"])
    if rc != 0:
        raise Abort(f"kubectl {' '.join(args)}: {err.strip() or rc}")
    return json.loads(out)


def resolve(kube, ns, host):
    rc, out, _ = kube.run(["-n", ns, "exec", "probe", "--", "nslookup", host], timeout=20)
    addrs, after = [], False
    for line in out.splitlines():
        if line.startswith("Name:"):
            after = True
        elif after and "Address" in line:
            a = line.split(":", 1)[1].strip().split()[0] if ":" in line else ""
            try:
                if ipaddress.ip_address(a).version == 4:
                    addrs.append(a)
            except ValueError:
                pass
    return addrs


def iso(epoch):
    """Readable UTC wall clock with whole seconds; the epoch next to it keeps the precision."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def stamp(report, key, clock):
    e = round(clock.wall(), 3)
    report[key], report[f"{key}_epoch"] = iso(e), e
    return e


def write_report(path, report, clock=Clock, partial=False):
    """Writes the whole report or nothing: serializes before opening, writes a temporary file in the SAME directory
    (os.replace is atomic only within one filesystem), fsyncs and swaps. A concurrent reader never sees a truncated JSON."""
    p = Path(path)
    e = round(clock.wall(), 3)
    body = json.dumps(dict(report, partial=partial, updated_at=iso(e), updated_at_epoch=e),
                      indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=f".{p.name}.", suffix=".tmp", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def parse_metrics(text, vantage):
    """Pod sample -> {target_name: {class, success, latency, ts}}. A series of another vantage does not count:
    a pod with the wrong label becomes a MISSING series for this vantage, never the sample of the other side."""
    out = {}
    for line in (text or "").splitlines():
        m = SERIES.match(line.strip())
        if not m:
            continue
        lab = dict(LABEL_PAIR.findall(m.group(2)))
        if lab.get("vantage") != vantage or lab.get("target_class") not in TARGET_CLASS.values() or not lab.get("target_name"):
            continue
        try:
            v = float(m.group(3))
        except ValueError:
            continue
        key = {"platform_probe_success": "success", "platform_probe_latency_seconds": "latency",
               "platform_probe_sample_timestamp_seconds": "ts"}[m.group(1)]
        out.setdefault(lab["target_name"], {"class": lab["target_class"]})[key] = v
    return {n: x for n, x in out.items() if {"success", "latency", "ts"} <= x.keys()}


def read_sample(kube, ns):
    """None = the exec did not run (a check failure); {} = the pod answered without any series."""
    rc, out, _ = kube.run(["-n", ns, "exec", "probe", "--", "cat", METRICS_FILE], timeout=20)
    return parse_metrics(out, VANTAGE[ns]) if rc == 0 else None


def checks(d):
    return [(who, ns, kind, t) for who, ns in (("inside", PROBE_NS), ("outside", CONTROL_NS)) for kind, t in probe_targets(d)]


def expected(phase, who, kind):
    if phase == "during" and who == "inside" and kind in ("region", "internet"):
        return BLOCKED
    return OPEN


def fresh_samples(kube, d, clock, after, last, before=None, until=None):
    """Waits, per vantage and target, for a sample that STARTED after `after` (wall clock, with SKEW_S slack), is
    newer than the last one used and, when `before` is set, started early enough to end inside the window.
    Deadline on the monotonic clock, never after `until`. Returns (samples, reason per target)."""
    floor = None if after is None else after + SKEW_S
    got, why = {}, {}
    deadline = clock.now() + d["interval_seconds"] + round_budget(d) + 15
    if until is not None:
        deadline = min(deadline, until)
    step = max(2, int(d["interval_seconds"]) // 4)
    while True:
        for ns in (PROBE_NS, CONTROL_NS):
            s = read_sample(kube, ns)
            for _, t in probe_targets(d):
                if (ns, t) in got:
                    continue
                x = None if s is None else s.get(t)
                if s is None:
                    why[(ns, t)] = "exec failed"
                elif x is None:
                    why[(ns, t)] = "missing series"
                elif (floor is not None and x["ts"] <= floor) or x["ts"] <= last.get((ns, t), float("-inf")):
                    why[(ns, t)] = f"stale series (sample from {iso(x['ts'])})"
                elif before is not None and x["ts"] > before:
                    why[(ns, t)] = f"sample from {iso(x['ts'])} after the cut window"
                else:
                    got[(ns, t)] = x
                    why.pop((ns, t), None)
        if len(got) == 2 * len(probe_targets(d)) or clock.now() > deadline:
            return got, why
        clock.sleep(step)


def observe(kube, d, phase, log, clock=None, after=None, last=None, t=None, before=None, until=None):
    """One round: the NEWEST sample of each pod, read from the pod itself. It is the one vmagent scrapes, so the
    report and the series agree in value and timestamp. A sample that does not arrive in time becomes `error`,
    never `blocked`: a stale or missing series is not proof of a cut."""
    clock = clock or Clock
    last = {} if last is None else last
    got, why = fresh_samples(kube, d, clock, after, last, before, until)
    rows, bad = [], []
    for who, ns, kind, target in checks(d):
        x, want = got.get((ns, target)), expected(phase, who, kind)
        row = {"phase": phase, "probe": who, "kind": kind, "target": target, "vantage": VANTAGE[ns],
               "target_class": TARGET_CLASS[kind], "target_name": target, "want": want}
        if x is None:
            row.update(got=ERROR, observed_at=None, observed_at_epoch=None, detail=why.get((ns, target), "no sample"))
        else:
            last[(ns, target)] = x["ts"]
            row.update(got=OPEN if x["success"] == 1 else BLOCKED, observed_at=iso(x["ts"]),
                       observed_at_epoch=int(x["ts"]), latency_seconds=x["latency"])
        row["ok"] = row["got"] == want
        rows.append(row)
        if not row["ok"]:
            bad.append(row)
    rc, out, _ = kube.run(["get", "--raw", "/readyz"], timeout=15)
    api_ok = rc == 0 and out.strip() == "ok"
    e = round(clock.wall(), 3)
    rows.append({"phase": phase, "probe": "operator", "kind": "api", "target": "/readyz", "want": OPEN,
                 "got": OPEN if api_ok else BLOCKED, "ok": api_ok, "observed_at": iso(e), "observed_at_epoch": e})
    if not api_ok:
        bad.append(rows[-1])
    head = f"[{phase}{'' if t is None else f' t+{int(t):03d}s'}]"
    log(f"{head} {'probe':8} {'kind':8} {'target':58} {'expected':10} {'observed':10} {'sample':20} result")
    for r in rows:
        log(f"{' ' * len(head)} {r['probe']:8} {r['kind']:8} {r['target']:58} {r['want']:10} {r['got']:10} "
            f"{r['observed_at'] or '-':20} {'OK' if r['ok'] else 'DIVERGE ' + r.get('detail', '')}".rstrip())
    return rows, bad


def conditions(kube):
    rc, out, _ = kube.run(["-n", CHAOS_NS, "get", "networkchaos", NAME, "-o", "json"])
    if rc != 0:
        return None
    st = json.loads(out).get("status", {})
    return {c["type"]: c.get("status") for c in st.get("conditions", [])}


def restarts(kube, d):
    snap = {}
    for ns in d["target_namespaces"]:
        for p in kjson(kube, ["-n", ns, "get", "pods"])["items"]:
            snap[f"{ns}/{p['metadata']['name']}"] = sum(s.get("restartCount", 0) for s in p.get("status", {}).get("containerStatuses", []))
    return snap


def preflight(kube, d, cut, log):
    dep = kjson(kube, ["-n", CHAOS_NS, "get", "deployment", "chaos-controller-manager"])
    env = {e["name"]: e.get("value") for c in dep["spec"]["template"]["spec"]["containers"] for e in c.get("env", [])}
    if env.get("ENABLE_FILTER_NAMESPACE") != "true" or env.get("ALLOW_HOST_NETWORK_TESTING") != "false":
        raise Abort("Chaos Mesh lacks enableFilterNamespace=true and allowHostNetworkTesting=false: reinstall with chaos-mesh-values.yaml")
    if kjson(kube, ["get", "networkchaos", "-A", "-l", f"{LABEL}=true"])["items"]:
        raise Abort("a NetworkChaos of this demo already exists: run `egress_chaos.py rollback` first")
    svc = kjson(kube, ["-n", "default", "get", "service", "kubernetes"])["spec"]["clusterIP"]
    if svc != d["kubernetes_service_ip"]:
        raise Abort(f"Service kubernetes at {svc}, inputs say {d['kubernetes_service_ip']}")
    bad = []
    for n in kjson(kube, ["get", "nodes"])["items"]:
        bad += [f"node {n['metadata']['name']} {a['address']}" for a in n["status"].get("addresses", [])
                if a["type"] == "InternalIP" and in_cut(a["address"], cut)]
    for s in kjson(kube, ["-n", "default", "get", "endpoints", "kubernetes"]).get("subsets", []):
        bad += [f"apiserver {a['ip']}" for a in s.get("addresses", []) if in_cut(a["ip"], cut)]
    for s in kjson(kube, ["get", "services", "-A"])["items"]:
        ip = s["spec"].get("clusterIP")
        if ip and ip != "None" and ipaddress.ip_address(ip) not in d["_svc"]:
            bad.append(f"service {s['metadata']['namespace']}/{s['metadata']['name']} {ip} outside service_cidr")
        bad += [f"loadbalancer {s['metadata']['namespace']}/{s['metadata']['name']} {i['ip']}"
                for i in s.get("status", {}).get("loadBalancer", {}).get("ingress", []) or [] if i.get("ip") and in_cut(i["ip"], cut)]
    for ns in d["target_namespaces"]:
        kjson(kube, ["get", "namespace", ns])
        for p in kjson(kube, ["-n", ns, "get", "pods"])["items"]:
            if p["spec"].get("hostNetwork"):
                bad.append(f"pod hostNetwork {ns}/{p['metadata']['name']}: the cut would hit the node")
            ip = p.get("status", {}).get("podIP")
            if ip and in_cut(ip, cut):
                bad.append(f"pod {ns}/{p['metadata']['name']} {ip} inside the cut")
    sec = [s for s in kjson(kube, ["-n", "argocd", "get", "secrets", "-l", "argocd.argoproj.io/secret-type=cluster"])["items"]
           if s["metadata"].get("annotations", {}).get("cluster_name") == d["cluster_name"]]
    if sec:
        a = sec[0]["metadata"]["annotations"]
        if a.get("node_subnet_cidr") != d["node_subnet_cidr"]:
            bad.append(f"cluster Secret node_subnet_cidr={a.get('node_subnet_cidr')} != inputs {d['node_subnet_cidr']}")
        if a.get("kubernetes_service_ip_cidr") != f"{d['kubernetes_service_ip']}/32":
            bad.append(f"cluster Secret kubernetes_service_ip_cidr={a.get('kubernetes_service_ip_cidr')} != inputs")
    else:
        log("warning: Argo CD cluster Secret not found; CIDRs checked only against the live cluster")
    if bad:
        raise Abort("preflight: " + "; ".join(bad))


def set_namespaces(kube, d, log):
    for ns in selector_namespaces(d):
        cur = kjson(kube, ["get", "namespace", ns])["metadata"].get("annotations", {}).get(INJECT)
        if cur == "enabled":
            continue      # annotated before the demo: not ours to revert
        for args in (["annotate", "namespace", ns, f"{INJECT}=enabled", "--overwrite"],
                     ["label", "namespace", ns, f"{MARK}=true", "--overwrite"]):
            rc, _, err = kube.run(args)
            if rc != 0:
                raise Fail(f"{' '.join(args)}: {err.strip()}")
    log(f"namespaces enabled for injection: {', '.join(selector_namespaces(d))}")


def leftovers(kube):
    rc, out, _ = kube.run(["get", "podnetworkchaos", "-A", "-o", "json"])
    if rc != 0:
        return None
    left = []
    for p in json.loads(out)["items"]:
        spec = p.get("spec", {})
        if any(x.get("source") == SOURCE for k in ("iptables", "ipsets", "tcs") for x in spec.get(k) or []):
            left.append(f"{p['metadata']['namespace']}/{p['metadata']['name']}")
    return left


def rollback(kube, clock=Clock, force=False, log=print):
    """Undoes everything the demo creates. Idempotent. True = verified clean state."""
    kube.run(["delete", "networkchaos", "-A", "-l", f"{LABEL}=true", "--ignore-not-found", "--wait=false"])
    deadline, clean, left = clock.now() + CLEAN_TIMEOUT, False, []
    while True:
        rc, out, _ = kube.run(["get", "networkchaos", "-A", "-l", f"{LABEL}=true", "-o", "json"])
        objs = json.loads(out)["items"] if rc == 0 else None
        left = leftovers(kube)
        if objs == [] and left == []:
            clean = True
            break
        if clock.now() > deadline:
            break
        clock.sleep(5)
    if not clean and force:
        log("rollback --force: removing finalizers and recreating the pods that still carry a cut rule")
        for o in objs or []:
            kube.run(["-n", o["metadata"]["namespace"], "patch", "networkchaos", o["metadata"]["name"],
                      "--type=merge", "-p", '{"metadata":{"finalizers":null}}'])
        for ref in left or []:
            ns, pod = ref.split("/", 1)
            kube.run(["-n", ns, "delete", "pod", pod, "--wait=false"])
            kube.run(["-n", ns, "delete", "podnetworkchaos", pod, "--ignore-not-found", "--wait=false"])
        clean = True
    elif not clean:
        log(f"rollback incomplete: NetworkChaos={objs} PodNetworkChaos with a rule={left}. "
            "Run it again with --force (removes finalizers and recreates the affected pods).")
    rc, out, _ = kube.run(["get", "namespaces", "-l", f"{MARK}=true", "-o", "name"])
    for ref in out.split() if rc == 0 else []:
        ns = ref.split("/", 1)[1]
        kube.run(["annotate", "namespace", ns, f"{INJECT}-"])
        kube.run(["label", "namespace", ns, f"{MARK}-"])
    kube.run(["delete", "namespace", PROBE_NS, CONTROL_NS, "--ignore-not-found", "--wait=false"])
    log(f"rollback: {'clean' if clean else 'INCOMPLETE'}")
    return clean


def argocd_refresh(kube, d, clock, log):
    app = d["argocd_root_application"]
    before = kjson(kube, ["-n", "argocd", "get", "application", app]).get("status", {}).get("reconciledAt")
    rc, _, err = kube.run(["-n", "argocd", "annotate", "application", app, "argocd.argoproj.io/refresh=hard", "--overwrite"])
    if rc != 0:
        raise Fail(f"Argo CD refresh: {err.strip()}")
    deadline = clock.now() + 120
    while clock.now() < deadline:
        st = kjson(kube, ["-n", "argocd", "get", "application", app]).get("status", {})
        if st.get("reconciledAt") != before and st.get("sync", {}).get("status") == "Synced":
            log(f"Argo CD: {app} reconciled from the local Gitea with the cut active (reconciledAt {st['reconciledAt']}, Synced)")
            return
        clock.sleep(5)
    raise Fail(f"Argo CD: {app} did not reconcile within 120s with the cut active")


def run(kube, d, clock=Clock, log=print, argocd=True, report_path=None):
    cut, _ = cut_set(d)
    files = render(d)
    report = {"cluster": d["cluster_name"], "duration_s": d["_secs"], "rounds": [], "result": None}
    created = injected = False
    rc = RC_FAIL

    def checkpoint():
        # Partial writes are best effort: a full disk must not block recovery or rollback. The final write
        # (main) does not swallow errors.
        if report_path:
            try:
                write_report(report_path, report, clock, partial=True)
            except OSError as e:
                log(f"warning: partial report not written to {report_path}: {e}")
    try:
        preflight(kube, d, cut, log)
        created = True
        prc, _, err = kube.run(["apply", "-f", "-"], stdin=files["probes.yaml"])
        if prc != 0:
            raise Abort(f"probes: {err.strip()}")
        for ns in (PROBE_NS, CONTROL_NS):
            prc, _, err = kube.run(["-n", ns, "wait", "--for=condition=Ready", "pod/probe", "--timeout=120s"], timeout=150)
            if prc != 0:
                raise Abort(f"probe {ns} did not become Ready: {err.strip()}")
        for host in (d["region_probe"], d["internet_probe"]):
            ips = resolve(kube, PROBE_NS, host.rsplit(":", 1)[0])
            if not ips or any(not in_cut(ip, cut) for ip in ips):
                raise Abort(f"{host} resolves to {ips or 'nothing'}: it must fall entirely inside the cut set "
                            "(an interface endpoint inside operator_ips or extra_preserve_cidrs?)")
        last = {}
        rows, bad = observe(kube, d, "before", log, clock, last=last)
        report["rounds"] += rows
        checkpoint()
        if bad:
            raise Abort("baseline not green, cut not applied: " + ", ".join(f"{b['probe']} {b['target']}={b['got']}" for b in bad))
        if argocd:
            st = kjson(kube, ["-n", "argocd", "get", "application", d["argocd_root_application"]]).get("status", {})
            if st.get("sync", {}).get("status") != "Synced":
                raise Abort(f"baseline: {d['argocd_root_application']} is not Synced before the cut")
        snap = restarts(kube, d)
        injected = True
        set_namespaces(kube, d, log)
        arc, _, err = kube.run(["apply", "-f", "-"], stdin=files["networkchaos.yaml"])
        if arc != 0:
            raise Fail(f"NetworkChaos: {err.strip()}")
        t0, applied_at = clock.now(), clock.wall()
        # The controller counts the duration from an instant >= the apply, so the cut lasts at least until
        # applied_at + duration. A "during" sample must end before that (connect + clock slack).
        window_end = applied_at + d["_secs"] - (NC_WAIT_S + 1 + SKEW_S)
        while (conditions(kube) or {}).get("AllInjected") != "True":
            if clock.now() - t0 > INJECT_TIMEOUT:
                raise Fail(f"AllInjected did not arrive within {INJECT_TIMEOUT}s")
            clock.sleep(3)
        injected_at = stamp(report, "all_injected_at", clock)
        checkpoint()
        log(f"cut ACTIVE in {len(selector_namespaces(d))} namespaces, {len(cut)} CIDRs, duration {d['duration']}, "
            f"AllInjected {report['all_injected_at']}")
        refreshed = not argocd
        while True:
            # Only a sample that started after AllInjected counts as "during"; observe waits for the next round.
            rows, bad = observe(kube, d, "during", log, clock, after=injected_at, last=last, t=clock.now() - t0,
                                before=window_end, until=t0 + d["_secs"])
            report["rounds"] += rows
            checkpoint()
            if bad:
                raise Fail("during the cut: " + ", ".join(f"{b['probe']} {b['target']}={b['got']}" for b in bad))
            if not refreshed:
                argocd_refresh(kube, d, clock, log)
                refreshed = True
            # The next sample starts up to one interval later and lasts up to round_budget: it must end
            # before the end of the duration, or it would measure the cut being lifted.
            if clock.now() - t0 + d["interval_seconds"] + round_budget(d) + 15 >= d["_secs"]:
                break
        log("waiting for the automatic Chaos Mesh recovery (end of the duration)")
        while (conditions(kube) or {}).get("AllRecovered") != "True":
            if clock.now() - t0 > d["_secs"] + RECOVER_GRACE:
                raise Fail(f"automatic recovery did not happen within duration + {RECOVER_GRACE}s")
            clock.sleep(5)
        recovered_at = stamp(report, "all_recovered_at", clock)
        checkpoint()
        log(f"recovered by itself at t+{int(clock.now() - t0)}s, AllRecovered {report['all_recovered_at']}")
        rows, bad = observe(kube, d, "after", log, clock, after=recovered_at, last=last)
        report["rounds"] += rows
        checkpoint()
        if bad:
            raise Fail("after the recovery: " + ", ".join(f"{b['probe']} {b['target']}={b['got']}" for b in bad))
        new = {k: v - snap[k] for k, v in restarts(kube, d).items() if k in snap and v > snap[k]}
        if new:
            raise Fail(f"restart during the cut: {new}")
        rc, report["result"] = RC_PASS, "PASS"
    except (Abort, Fail, KeyboardInterrupt) as e:
        # An Abort after the injection is not inconclusive: the cut existed and something could not be proven.
        rc = RC_INCONCLUSIVE if isinstance(e, Abort) and not injected else RC_FAIL
        report["result"] = "INCONCLUSIVE" if rc == RC_INCONCLUSIVE else "FAIL"
        report["reason"] = str(e) or "interrupted"
        log(f"{report['result']}: {report['reason']}")
    finally:
        if created:
            report["rollback_clean"] = rollback(kube, clock, log=log)
    if created and not report["rollback_clean"] and rc == RC_PASS:
        rc, report["result"] = RC_FAIL, "FAIL"
    return rc, report


# ---------------------------------------------------------------- CLI

def _sigterm(*_):
    raise KeyboardInterrupt


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render"); r.add_argument("--inputs", required=True); r.add_argument("--out", required=True)
    r.add_argument("--choreography", action="store_true", help=f"requires the canonical scene duration ({CHOREOGRAPHY_DURATION})")
    c = sub.add_parser("check-chart"); c.add_argument("--render", required=True)
    for name in ("run", "rollback"):
        p = sub.add_parser(name)
        p.add_argument("--inputs", required=True); p.add_argument("--context"); p.add_argument("--kubeconfig")
        p.add_argument("--kubectl", default="kubectl")
    sub.choices["run"].add_argument("--report")
    sub.choices["run"].add_argument("--skip-argocd-refresh", action="store_true")
    sub.choices["run"].add_argument("--choreography", action="store_true",
                                    help=f"requires the canonical scene duration ({CHOREOGRAPHY_DURATION})")
    sub.choices["rollback"].add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "check-chart":
            text = sys.stdin.read() if a.render == "-" else Path(a.render).read_text()
            fails = check_chart(text)
            for f in fails:
                print(f"FAIL {f}")
            print(f"RESULT check-chart failures={len(fails)}")
            return RC_FAIL if fails else RC_PASS
        d = load_inputs(a.inputs)
        if getattr(a, "choreography", False):
            check_choreography(d)
        if a.cmd == "render":
            out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
            for name, body in render(d).items():
                (out / name).write_text(body)
            cut, pres = cut_set(d)
            print(f"RESULT render cut={len(cut)} preserved={len(pres)} duration={d['_secs']}s out={out}")
            return RC_PASS
        kube = Kube(a.kubectl, a.context, a.kubeconfig)
        signal.signal(signal.SIGTERM, _sigterm)
        if a.cmd == "rollback":
            return RC_PASS if rollback(kube, force=a.force) else RC_FAIL
        rc, rep = run(kube, d, argocd=not a.skip_argocd_refresh, report_path=a.report)
        if a.report:
            write_report(a.report, rep)
        print(f"RESULT egress-chaos {rep['result']} rollback_clean={rep.get('rollback_clean')}")
        return rc
    except InputError as e:
        print(f"ERROR input: {e}", file=sys.stderr)
        return RC_INPUT


if __name__ == "__main__":
    sys.exit(main())
