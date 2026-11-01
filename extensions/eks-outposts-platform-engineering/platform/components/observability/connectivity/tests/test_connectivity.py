#!/usr/bin/env python3
"""test_connectivity.py - contract between queries.yaml, the Grafana dashboard and the Chaos probe series.

Three modes:
  python3 platform/components/observability/connectivity/tests/test_connectivity.py
      offline: queries.yaml well formed, series vocabulary, dashboard with the four panels and every `expr`
      identical byte for byte to queries.yaml, provisioned datasource, the Argo CD element that applies the
      dashboard. Every rule has the mutation that fails it.
  VM_BINARY=<victoria-metrics-prod> python3 .../test_connectivity.py
      + runs the queries on a REAL vmsingle (loopback, temporary directory) with synthetic series: a fresh scene
      passes; a stale series, a missing control vantage and a missing namespace fail or return empty.
  python3 .../test_connectivity.py --live-url http://127.0.0.1:8428 [--require-probes] [--time <epoch>]
      runs every query on the cluster vmsingle (port-forward). Positive control BEFORE trusting a zero:
      kube_pod_info of demo-netpol must return a series; the same selector with a missing namespace must return
      nothing. --require-probes (during a Chaos run): both vantages, the three classes and fresh samples.
      Output `RESULT test_connectivity live failures=N`; rc 0 only with N=0.
  python3 .../test_connectivity.py --live-grafana http://127.0.0.1:3000 --context <ctx> [--kubeconfig <kc>]
          [--from-ms <ms> --to-ms <ms>] [--require-probes]
      FRAME contract on the live Grafana: the Connectivity State Timeline panel from the API has the same targets
      as the source and /api/ds/query returns a time field in the window (default: last 15 min). --require-probes
      also requires the cut/region, cut/internet, control/region and control/internet series. The admin password
      stays in memory.
"""
import argparse, json, os, re, secrets, shutil, socket, subprocess, sys, tempfile, time, unittest
import urllib.error, urllib.parse, urllib.request
from pathlib import Path

import yaml

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
ROOT = HERE.parents[4]
QUERIES = COMPONENT / "queries.yaml"
DASHBOARD = COMPONENT.parent / "dashboards" / "platform-connectivity-dashboard.yaml"
APPLICATIONSET = ROOT / "platform" / "gitops" / "applicationset.yaml"
# The pinned chart is not committed; scripts/fetch-charts.sh places it here. Without it, the datasource uid that
# victoria-metrics-k8s-stack 0.93.0 provisions by default is the expected value.
CHART_VALUES = ROOT / "platform/.runtime/charts/victoria-metrics-k8s-stack/0.93.0/victoria-metrics-k8s-stack/values.yaml"
DEFAULT_DATASOURCE_UIDS = {"VictoriaMetrics"}
EGRESS = ROOT / "platform/components/chaos-egress/egress_chaos.py"

PANELS = ["Connectivity State Timeline", "Local Services", "Scrape Integrity", "Unavailable seconds"]
STATE_PANELS = ("Connectivity State Timeline", "Local Services")   # show UP/DOWN: fresh samples only
VOCAB = {"vantage": {"cut", "control"}, "target_class": {"region", "internet", "local"}}
PROBE_LABELS = {"vantage", "target_class", "target_name"}
METRIC = re.compile(r"\b(platform_probe_[a-z_]+)(\{[^}]*\})?")
MATCHER = re.compile(r'([a-z_]+)\s*(=~|!~|!=|=)\s*"([^"]*)"')
PROBE_METRICS = {"platform_probe_success", "platform_probe_latency_seconds", "platform_probe_sample_timestamp_seconds"}


def load_queries(path=QUERIES):
    return yaml.safe_load(Path(path).read_text())


def load_dashboard(path=DASHBOARD):
    cm = yaml.safe_load(Path(path).read_text())
    return cm, json.loads(next(iter(cm["data"].values())))


def provisioned_uids():
    if not CHART_VALUES.is_file():
        return set(DEFAULT_DATASOURCE_UIDS)
    vals = yaml.safe_load(CHART_VALUES.read_text())
    return {d["uid"] for d in vals["defaultDatasources"]["victoriametrics"]["datasources"]}


def egress_stale_after():
    m = re.search(r"^STALE_AFTER_S = (\d+)", EGRESS.read_text(), re.M)
    return int(m.group(1)) if m else None


def producer_namespaces():
    """Namespaces of the probe Services that egress_chaos.render() really emits for the example inputs."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("egress_chaos_producer", EGRESS)
    ec = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ec)
    rendered = ec.render(ec.load_inputs(str(EGRESS.parent / "inputs.example.json")))
    return {d["metadata"]["namespace"] for d in yaml.safe_load_all(rendered["probes.yaml"]) if d and d.get("kind") == "Service"}


# ---------------------------------------------------------------- offline contract

def check_queries(q, produced=None):
    """Findings on queries.yaml itself; an empty list means ok."""
    fails = []
    produced = producer_namespaces() if produced is None else produced
    for x in q.get("queries", []):
        for sel in re.findall(r'namespace=~"(egress-chaos[^"]*)"', x.get("expr", "")):
            if set(sel.split("|")) != produced:
                fails.append(f"{x.get('id')}: selects namespaces {sorted(sel.split('|'))}, the producer emits {sorted(produced)}")
    ids = [x.get("id") for x in q.get("queries", [])]
    if len(ids) != len(set(ids)):
        fails.append(f"duplicate id in queries.yaml: {sorted(i for i in ids if ids.count(i) > 1)}")
    stale = q.get("stale_after_seconds")
    if stale != egress_stale_after():
        fails.append(f"stale_after_seconds={stale} != STALE_AFTER_S of egress_chaos.py ({egress_stale_after()})")
    for x in q.get("queries", []):
        e, i = x.get("expr", ""), x.get("id")
        if not e or "\n" in e or e != e.strip():
            fails.append(f"{i}: expr empty, multiline or with surrounding whitespace")
        if x.get("kind") not in ("panel", "annotation", "explore"):
            fails.append(f"{i}: kind {x.get('kind')!r}")
        if x.get("kind") == "panel" and x.get("panel") not in PANELS:
            fails.append(f"{i}: panel {x.get('panel')!r} outside {PANELS}")
        if x.get("live", {}).get("require") not in ("probes", "always", "optional"):
            fails.append(f"{i}: invalid live.require")
        for metric, sel in METRIC.findall(e):
            if metric not in PROBE_METRICS:
                fails.append(f"{i}: metric outside the vocabulary: {metric}")
            for k, op, v in MATCHER.findall(sel or ""):
                if k not in PROBE_LABELS:
                    fails.append(f"{i}: label {k} outside the probe vocabulary")
                elif op == "=" and k in VOCAB and v not in VOCAB[k]:
                    fails.append(f"{i}: {k}={v!r} outside {sorted(VOCAB[k])}")
        if x.get("panel") in STATE_PANELS and "platform_probe_success" in e \
                and not ("platform_probe_sample_timestamp_seconds" in e and f"< {stale}" in e):
            fails.append(f"{i}: state without the freshness filter < {stale}s (a stale series would show as a state)")
    by_panel = {p: [x for x in q.get("queries", []) if x.get("panel") == p] for p in PANELS}
    for p, xs in by_panel.items():
        if not xs:
            fails.append(f"no query for panel {p!r}")
    return fails


def check_dashboard(cm, dash, q):
    """Findings on the dashboard against queries.yaml; an empty list means ok."""
    fails = []
    meta = cm.get("metadata", {})
    if (meta.get("name"), meta.get("namespace")) != ("platform-connectivity-dashboard", "monitoring"):
        fails.append(f"ConfigMap {meta.get('namespace')}/{meta.get('name')}: the sidecar only watches monitoring")
    if meta.get("labels", {}).get("grafana_dashboard") != "1":
        fails.append("ConfigMap without grafana_dashboard: \"1\" (the sidecar does not load it)")
    if dash.get("title") != "Platform connectivity during disconnection":
        fails.append(f"title {dash.get('title')!r}")
    uids = provisioned_uids()
    byid = {x["id"]: x for x in q["queries"]}
    panels = dash.get("panels", [])
    if [p.get("title") for p in panels] != PANELS:
        fails.append(f"panels {[p.get('title') for p in panels]} != {PANELS}")
    for p in panels:
        want = [x["id"] for x in q["queries"] if x.get("panel") == p.get("title")]
        got = [t.get("refId") for t in p.get("targets", [])]
        if got != want:
            fails.append(f"panel {p.get('title')!r}: refIds {got} != {want}")
        for ds in [p.get("datasource")] + [t.get("datasource") for t in p.get("targets", [])]:
            if not ds or ds.get("uid") not in uids:
                fails.append(f"panel {p.get('title')!r}: datasource {ds} not provisioned ({sorted(uids)})")
        for t in p.get("targets", []):
            if t.get("refId") in byid and t.get("expr") != byid[t["refId"]]["expr"]:
                fails.append(f"panel {p.get('title')!r} {t['refId']}: expr differs from queries.yaml")
        if p.get("type") == "state-timeline":
            texts = {o.get("text") for m in p.get("fieldConfig", {}).get("defaults", {}).get("mappings", [])
                     for o in m.get("options", {}).values()}
            if not {"UP", "DOWN"} <= texts:
                fails.append(f"panel {p.get('title')!r}: state without UP/DOWN text (color alone is not enough)")
            # Grafana 13: with color.mode=thresholds the state-timeline writes the threshold label ("< 1", "1+")
            # on the bar and in the legend instead of the value mapping text.
            if p.get("fieldConfig", {}).get("defaults", {}).get("color", {}).get("mode") == "thresholds":
                fails.append(f"panel {p.get('title')!r}: color.mode=thresholds hides UP/DOWN behind '< 1'/'1+'")
            if p.get("options", {}).get("showValue") != "always":
                fails.append(f"panel {p.get('title')!r}: showValue != always (the text disappears)")
            # Grafana 13: if EVERY state-timeline target depends on the probes, a window without a run returns only
            # frames without fields and the panel shows "Data does not have a time field" instead of data.
            if all(byid.get(t.get("refId"), {}).get("live", {}).get("require") == "probes" for t in p.get("targets", [])):
                fails.append(f"panel {p.get('title')!r}: every target depends on the probes; outside a run the frame has no "
                             "time field")
    anns = [a for a in dash.get("annotations", {}).get("list", []) if a.get("expr")]
    want = [x["id"] for x in q["queries"] if x["kind"] == "annotation"]
    if [a.get("name") for a in anns] != want:
        fails.append(f"annotations {[a.get('name') for a in anns]} != {want}")
    for a in anns:
        if a.get("name") in byid and a.get("expr") != byid[a["name"]]["expr"]:
            fails.append(f"annotation {a['name']}: expr differs from queries.yaml")
        if not a.get("datasource") or a["datasource"].get("uid") not in uids:
            fails.append(f"annotation {a.get('name')}: datasource not provisioned")
    if not any(a.get("useValueForTime") for a in anns if a.get("name") == "retail_namespace_created"):
        fails.append("retail_namespace_created without useValueForTime (the mark would land at the sample instant)")
    return fails


# ---------------------------------------------------------------- FRAME contract (what the panel receives)

TIMELINE = "Connectivity State Timeline"
TIMELINE_PAIRS = {("cut", "region"), ("cut", "internet"), ("control", "region"), ("control", "internet")}


def frames_from_matrix(ref, result):
    """Frames as the Grafana 13 Prometheus datasource returns them from /api/ds/query: an empty result becomes ONE
    frame without fields; every series becomes a [time, number] frame with the labels on the value field."""
    if not result:
        return [{"schema": {"refId": ref, "fields": []}, "data": {"values": []}}]
    return [{"schema": {"refId": ref, "fields": [{"name": "Time", "type": "time"},
                                                 {"name": "Value", "type": "number", "labels": s["metric"]}]},
             "data": {"values": [[float(t) * 1000 for t, _ in s["values"]], [float(v) for _, v in s["values"]]]}}
            for s in result]


def check_timeline_frames(results, require_pairs=False):
    """Findings on what the state-timeline receives ({refId: {"frames": [...]}}); an empty list means ok.
    Same rule as the panel: without any frame with a time field, it shows 'Data does not have a time field'."""
    fails, pairs = [], set()
    timed = 0
    for ref, r in results.items():
        for f in r.get("frames", []):
            types = [x.get("type") for x in f["schema"].get("fields", [])]
            vals = f.get("data", {}).get("values", [])
            if "time" in types and "number" in types and vals and vals[0]:
                timed += 1
                if ref == "connectivity_state":
                    lab = next(x.get("labels") or {} for x in f["schema"]["fields"] if x.get("type") == "number")
                    pairs.add((lab.get("vantage"), lab.get("target_class")))
    if not timed:
        fails.append("Data does not have a time field: no frame with a time and a value field")
    if require_pairs and not TIMELINE_PAIRS <= pairs:
        fails.append(f"connectivity_state without the series {sorted(TIMELINE_PAIRS - pairs)}")
    return fails


def grafana_frames(url, auth, targets, frm_ms, to_ms):
    qs = [dict(t, intervalMs=10000, maxDataPoints=1000) for t in targets]
    req = urllib.request.Request(url.rstrip("/") + "/api/ds/query",
                                 data=json.dumps({"queries": qs, "from": str(frm_ms), "to": str(to_ms)}).encode(),
                                 headers={"Authorization": auth, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["results"]


def live_grafana(url, context, kubeconfig=None, frm_ms=None, to_ms=None, require_pairs=False, log=print):
    """Panel 1 live: dashboard model from the API (must be the source one) and datasource frames in the window.
    The admin password goes from the Secret monitoring/grafana-admin straight to memory; never argv, log or file."""
    import base64
    cmd = ["kubectl"] + (["--kubeconfig", kubeconfig] if kubeconfig else []) + [
        "--context", context, "-n", "monitoring", "get", "secret", "grafana-admin", "-o", "json"]
    data = json.loads(subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=True).stdout)["data"]
    pw = base64.b64decode(data.get("admin-password") or next(v for k, v in data.items() if "pass" in k.lower())).decode()
    auth = "Basic " + base64.b64encode(b"admin:" + pw.encode()).decode()
    req = urllib.request.Request(url.rstrip("/") + "/api/dashboards/uid/platform-connectivity", headers={"Authorization": auth})
    with urllib.request.urlopen(req, timeout=30) as r:
        live_dash = json.loads(r.read())["dashboard"]
    fails = []
    lp = next(p for p in live_dash["panels"] if p["title"] == TIMELINE)
    sp = next(p for p in load_dashboard()[1]["panels"] if p["title"] == TIMELINE)
    strip = lambda ts: [{k: t.get(k) for k in ("refId", "expr", "legendFormat", "instant", "range", "format")} for t in ts]
    if strip(lp["targets"]) != strip(sp["targets"]):
        fails.append("live panel 1 differs from the source (Argo CD or the sidecar did not apply it yet)")
    to_ms = to_ms or int(time.time() * 1000)
    frm_ms = frm_ms or to_ms - 900_000
    res = grafana_frames(url, auth, [dict(t, datasource=t.get("datasource") or lp["datasource"]) for t in lp["targets"]],
                         frm_ms, to_ms)
    for ref, r in res.items():
        log(f"grafana {ref} status={r.get('status')} frames="
            f"{[[x.get('type') for x in f['schema'].get('fields', [])] for f in r.get('frames', [])]}")
    fails += check_timeline_frames(res, require_pairs)
    log(f"RESULT test_connectivity grafana failures={len(fails)}")
    for f in fails:
        log(f"FAIL {f}")
    return fails


# ---------------------------------------------------------------- run against a vmsingle

def vm_query(url, expr, at=None):
    data = {"query": expr, "nocache": "1"}
    if at is not None:
        data["time"] = str(at)
    req = urllib.request.Request(url.rstrip("/") + "/api/v1/query", data=urllib.parse.urlencode(data).encode())
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        with e:
            return {"status": "error", "error": f"HTTP {e.code}: {e.read()[:200]!r}"}
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {"status": "error", "error": str(e)}
    return body


def live(url, q, require_probes=False, at=None, log=print):
    """Runs queries.yaml on the vmsingle. Returns the list of findings."""
    fails = []
    byid = {x["id"]: x for x in q["queries"]}
    # 1. positive control: without it, no later empty result proves anything
    pos = vm_query(url, byid["pod_ip_node"]["expr"], at)
    n = len(pos.get("data", {}).get("result", [])) if pos.get("status") == "success" else 0
    log(f"positive control pod_ip_node(demo-netpol) status={pos.get('status')} series={n}")
    if n == 0:
        return [f"positive control empty or failed ({pos.get('error', 'zero series')}): no later zero is trustworthy"]
    # 2. the same selector with a missing namespace: must return nothing
    ghost = "ns-absent-" + secrets.token_hex(4)
    neg = vm_query(url, byid["pod_ip_node"]["expr"].replace('namespace="demo-netpol"', f'namespace="{ghost}"'), at)
    nn = len(neg.get("data", {}).get("result", [])) if neg.get("status") == "success" else -1
    log(f"negative control pod_ip_node({ghost}) status={neg.get('status')} series={nn}")
    if nn != 0:
        fails.append(f"missing namespace returned {nn} series: the query does not filter")
    got = {}
    for x in q["queries"]:
        r = vm_query(url, x["expr"], at)
        res = r.get("data", {}).get("result", []) if r.get("status") == "success" else []
        got[x["id"]] = res
        log(f"query {x['id']} status={r.get('status')} series={len(res)}")
        if r.get("status") != "success":
            fails.append(f"{x['id']}: {r.get('error')}")
            continue
        need = x["live"]["require"]
        if res and any(set(x["live"]["by"]) - set(s["metric"]) for s in res):
            fails.append(f"{x['id']}: series without the labels {x['live']['by']}")
        if not res and (need == "always" or (need == "probes" and require_probes)):
            fails.append(f"{x['id']}: empty")
    if require_probes:
        stale = q["stale_after_seconds"]
        pairs = {(s["metric"].get("vantage"), s["metric"].get("target_class")) for s in got["connectivity_state"]}
        want = {(v, c) for v in VOCAB["vantage"] for c in VOCAB["target_class"]}
        if pairs != want:
            fails.append(f"connectivity_state without {sorted(want - pairs)} (missing or stale)")
        for s in got["sample_age"]:
            age = float(s["value"][1])
            if age >= stale:
                fails.append(f"stale series: {s['metric'].get('vantage')}/{s['metric'].get('target_class')} at {age:.0f}s")
        vs = {s["metric"].get("vantage") for s in got["vantage_series"]}
        if "control" not in vs:
            fails.append("control vantage missing: without it, DOWN in cut does not prove a cut")
        ups = {s["metric"].get("vantage"): s["value"][1] for s in got["scrape_up"]}
        if ups != {"cut": "1", "control": "1"}:
            fails.append(f"scrape up per vantage = {ups}, expected cut=1 control=1")
    log(f"RESULT test_connectivity live failures={len(fails)}")
    for f in fails:
        log(f"FAIL {f}")
    return fails


# ---------------------------------------------------------------- tests

class Queries(unittest.TestCase):
    def setUp(self):
        self.q = load_queries()

    def test_well_formed_and_aligned_with_the_producer(self):
        self.assertEqual(check_queries(self.q), [])
        self.assertEqual(self.q["stale_after_seconds"], egress_stale_after())

    def test_each_mutation_fails(self):
        import copy
        def mut(f):
            m = copy.deepcopy(self.q)
            f(m)
            return check_queries(m)
        first = lambda m, i: next(x for x in m["queries"] if x["id"] == i)
        cases = {
            "vantage outside the vocabulary": lambda m: first(m, "local_services_probe").update(
                expr=first(m, "local_services_probe")["expr"].replace('vantage="cut"', 'vantage="inside"')),
            "class outside the vocabulary": lambda m: first(m, "local_services_probe").update(
                expr=first(m, "local_services_probe")["expr"].replace('target_class="local"', 'target_class="onprem"')),
            "state without freshness": lambda m: first(m, "connectivity_state").update(
                expr="min by (vantage, target_class) (platform_probe_success)"),
            "diverging stale": lambda m: m.update(stale_after_seconds=120),
            "panel without query": lambda m: m.update(queries=[x for x in m["queries"] if x.get("panel") != "Scrape Integrity"]),
            "duplicate id": lambda m: m["queries"].append(dict(first(m, "namespaces"))),
            "multiline expr": lambda m: first(m, "namespaces").update(expr="count by (namespace)\n(kube_pod_info)"),
        }
        for name, f in cases.items():
            self.assertTrue(mut(f), name)

    def test_probe_namespace_renamed_in_the_producer_fails(self):
        produced = producer_namespaces()
        self.assertEqual(produced, {"egress-chaos-probe", "egress-chaos-control"})
        self.assertTrue(any("the producer emits" in f for f in check_queries(self.q, produced={"egress-chaos-cut", "egress-chaos-control"})))


class Dashboard(unittest.TestCase):
    def setUp(self):
        self.q = load_queries()
        self.cm, self.dash = load_dashboard()

    def test_contract(self):
        self.assertEqual(check_dashboard(self.cm, self.dash, self.q), [])

    def test_removing_scrape_integrity_fails(self):
        import copy
        d = copy.deepcopy(self.dash)
        d["panels"] = [p for p in d["panels"] if p["title"] != "Scrape Integrity"]
        self.assertTrue(any("panels" in f for f in check_dashboard(self.cm, d, self.q)))

    def test_each_mutation_fails(self):
        import copy
        def mut(f):
            d, cm = copy.deepcopy(self.dash), copy.deepcopy(self.cm)
            f(d, cm)
            return check_dashboard(cm, d, self.q)
        p = lambda d, t: next(x for x in d["panels"] if x["title"] == t)
        cases = {
            "expr with one extra character": lambda d, cm: p(d, "Local Services")["targets"][0].update(
                expr=p(d, "Local Services")["targets"][0]["expr"] + " "),
            "missing datasource": lambda d, cm: p(d, "Unavailable seconds")["targets"][0].update(
                datasource={"type": "prometheus", "uid": "Prometheus"}),
            "state by color only": lambda d, cm: p(d, "Connectivity State Timeline")["fieldConfig"]["defaults"].update(mappings=[]),
            "color by threshold": lambda d, cm: p(d, "Local Services")["fieldConfig"]["defaults"].update(color={"mode": "thresholds"}),
            "hidden text": lambda d, cm: p(d, "Connectivity State Timeline")["options"].update(showValue="never"),
            "query moved to another panel": lambda d, cm: p(d, "Scrape Integrity")["targets"].pop(),
            "diverging annotation": lambda d, cm: d["annotations"]["list"][-1].update(expr="up"),
            "wrong namespace": lambda d, cm: cm["metadata"].update(namespace="default"),
            "without the sidecar label": lambda d, cm: cm["metadata"]["labels"].clear(),
            "timeline with probe targets only": lambda d, cm: p(d, "Connectivity State Timeline").update(
                targets=p(d, "Connectivity State Timeline")["targets"][:1]),
        }
        for name, f in cases.items():
            self.assertTrue(mut(f), name)

    def test_an_applicationset_element_applies_the_dashboard(self):
        # The dashboard reaches Grafana only through the directory Application that the ApplicationSet renders.
        text = APPLICATIONSET.read_text()
        self.assertEqual(len(re.findall(r"\{app: platform-dashboards, kind: directory, namespace: monitoring, wave: \"[0-9-]+\", "
                                        r"path: components/observability/dashboards\}", text)), 1)
        self.assertEqual(sorted(p.name for p in DASHBOARD.parent.iterdir()), [DASHBOARD.name])

    def test_timeline_without_time_anchor_fails_for_that_reason(self):
        import copy
        d = copy.deepcopy(self.dash)
        p = next(x for x in d["panels"] if x["title"] == TIMELINE)
        p["targets"] = p["targets"][:1]
        self.assertTrue(any("every target depends on the probes" in f for f in check_dashboard(self.cm, d, self.q)))


class FrameContract(unittest.TestCase):
    """Frames synthesized in the Grafana 13 datasource shape (see frames_from_matrix), 6 points per series."""

    @staticmethod
    def series(labels, value):
        return {"metric": labels, "values": [[1800000000 + 10 * i, value] for i in range(6)]}

    def run_window(self):
        pairs = [{"vantage": v, "target_class": c} for v in ("control", "cut") for c in ("internet", "local", "region")]
        state = [self.series(p, "0" if p["vantage"] == "cut" and p["target_class"] != "local" else "1") for p in pairs]
        return {"connectivity_state": {"frames": frames_from_matrix("connectivity_state", state)},
                "probe_samples_fresh": {"frames": frames_from_matrix("probe_samples_fresh", [self.series({}, "1")])}}

    def idle_window(self, anchor=True):
        res = {"connectivity_state": {"frames": frames_from_matrix("connectivity_state", [])}}
        if anchor:
            res["probe_samples_fresh"] = {"frames": frames_from_matrix("probe_samples_fresh", [self.series({}, "0")])}
        return res

    def test_run_window_has_time_and_the_four_pairs(self):
        self.assertEqual(check_timeline_frames(self.run_window(), require_pairs=True), [])

    def test_idle_window_without_the_anchor_reproduces_the_defect(self):
        res = self.idle_window(anchor=False)
        self.assertEqual([f["schema"]["fields"] for f in res["connectivity_state"]["frames"]], [[]])
        self.assertEqual(check_timeline_frames(res), ["Data does not have a time field: no frame with a time and a value field"])

    def test_idle_window_with_the_anchor_keeps_a_time_field(self):
        res = self.idle_window()
        self.assertEqual(check_timeline_frames(res), [])
        # outside a run the four rows do not exist, and the run contract fails
        self.assertTrue(check_timeline_frames(res, require_pairs=True))

    def test_run_window_missing_a_pair_fails(self):
        res = self.run_window()
        res["connectivity_state"]["frames"] = [f for f in res["connectivity_state"]["frames"]
                                               if f["schema"]["fields"][1]["labels"] != {"vantage": "cut", "target_class": "region"}]
        self.assertEqual(check_timeline_frames(res, require_pairs=True),
                         ["connectivity_state without the series [('cut', 'region')]"])


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


TARGETS = [("region", "sts.us-west-2.amazonaws.com:443"), ("internet", "github.com:443"),
           ("local", "gitea-http.git-local.svc.cluster.local:3000")]


def scene(t_end, stale_cut=False, no_control=False):
    """Synthetic 10 min series ending at t_end, as vmagent would store them: cut of Region/Internet in the cut vantage
    between t_end-300 and t_end-60; sample_timestamp of the 20 s round (or frozen, if stale_cut)."""
    lines = []
    for ts in range(t_end - 600, t_end + 1, 10):
        for v, ns in (("cut", "egress-chaos-probe"), ("control", "egress-chaos-control")):
            if v == "control" and no_control:
                continue
            base = f'namespace="{ns}",pod="probe",job="probe-metrics",instance="10.40.1.9:9797"'
            lines.append(f'up{{vantage="{v}",{base}}} 1 {ts * 1000}')
            for c, n in TARGETS:
                lab = f'vantage="{v}",target_class="{c}",target_name="{n}",{base}'
                down = v == "cut" and c != "local" and t_end - 300 <= ts < t_end - 60
                sample = (t_end - 400) if (stale_cut and v == "cut") else ts - ts % 20
                lines += [f'platform_probe_success{{{lab}}} {0 if down else 1} {ts * 1000}',
                          f'platform_probe_latency_seconds{{{lab}}} {4.0 if down else 0.01} {ts * 1000}',
                          f'platform_probe_sample_timestamp_seconds{{{lab}}} {sample} {ts * 1000}']
        lines.append(f'kube_pod_info{{namespace="demo-netpol",pod="frontend-1",pod_ip="10.40.1.50",node="n1"}} 1 {ts * 1000}')
        # kube-state-metrics emits available and ready for every Deployment; the Retail Store exists only after its sync
        deps = [("demo-netpol", "frontend")] + ([("retail-store", x) for x in ("retail-ui", "retail-cart", "retail-dynamodb")]
                                                  if ts >= t_end - 200 else [])
        for ns, dep in deps:
            for m in ("kube_deployment_status_replicas_available", "kube_deployment_status_replicas_ready"):
                lines.append(f'{m}{{namespace="{ns}",deployment="{dep}"}} 1 {ts * 1000}')
        if ts >= t_end - 200:
            lines.append(f'kube_namespace_created{{namespace="retail-store"}} {t_end - 200} {ts * 1000}')
    return "\n".join(lines) + "\n"


@unittest.skipUnless(os.environ.get("VM_BINARY"), "VM_BINARY not set (real vmsingle, loopback only)")
class RealVictoriaMetrics(unittest.TestCase):
    """The queries of queries.yaml on a REAL vmsingle: each scene at its own instant, 1 h apart."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="vm-conn-")
        cls.url = f"http://127.0.0.1:{free_port()}"
        cls.proc = subprocess.Popen([os.environ["VM_BINARY"], f"-httpListenAddr={cls.url[7:]}", f"-storageDataPath={cls.tmp}",
                                     "-memory.allowedPercent=5", "-retentionPeriod=1d", "-search.latencyOffset=0s"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(cls.url + "/health", timeout=2) as r:
                    if r.read().strip() == b"OK":
                        break
            except OSError:
                time.sleep(0.3)
        now = int(time.time()) // 60 * 60
        cls.at = {"fresh": now - 3 * 3600, "stale": now - 2 * 3600, "nocontrol": now - 3600}
        body = scene(cls.at["fresh"]) + scene(cls.at["stale"], stale_cut=True) + scene(cls.at["nocontrol"], no_control=True)
        urllib.request.urlopen(urllib.request.Request(cls.url + "/api/v1/import/prometheus", data=body.encode()), timeout=30).read()
        urllib.request.urlopen(cls.url + "/internal/force_flush", timeout=30).read()
        cls.q = load_queries()

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=20)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_live(self, name):
        out = []
        return live(self.url, self.q, require_probes=True, at=self.at[name], log=out.append), out

    def test_fresh_scene_passes_every_query(self):
        fails, out = self.run_live("fresh")
        self.assertEqual(fails, [], "\n".join(out))
        r = lambda i: vm_query(self.url, next(x["expr"] for x in self.q["queries"] if x["id"] == i), self.at["fresh"])["data"]["result"]
        # the scene has 240 s of cut on Region and Internet in cut; control and local stay at 0, visible
        down = {(s["metric"]["vantage"], s["metric"]["target_class"]): float(s["value"][1]) for s in r("unavailable_seconds")}
        self.assertEqual(down[("cut", "region")], 240.0, down)
        self.assertEqual(down[("cut", "internet")], 240.0, down)
        self.assertEqual({k: v for k, v in down.items() if k[0] == "control" or k[1] == "local"},
                         {("control", "region"): 0, ("control", "internet"): 0, ("control", "local"): 0, ("cut", "local"): 0})
        self.assertEqual(len(r("region_transition")), 0)       # 60 s after recovery, nothing changed in the last minute
        self.assertEqual({(s["metric"]["namespace"], s["metric"]["deployment"]) for s in r("local_workloads_ready")},
                         {("retail-store", "retail-ui"), ("retail-store", "retail-cart"), ("retail-store", "retail-dynamodb")})
        self.assertEqual([s["metric"]["namespace"] for s in r("retail_ready")], ["retail-store"])
        # pair: before the sync the Retail Store does not exist and no Ready mark appears
        e = next(x["expr"] for x in self.q["queries"] if x["id"] == "retail_ready")
        self.assertEqual(vm_query(self.url, e, self.at["fresh"] - 300)["data"]["result"], [])
        self.assertEqual([float(s["value"][1]) for s in r("retail_namespace_created")], [(self.at["fresh"] - 200) * 1000.0])

    def test_region_transition_marks_the_cut(self):
        e = next(x["expr"] for x in self.q["queries"] if x["id"] == "region_transition")
        hit = vm_query(self.url, e, self.at["fresh"] - 290)["data"]["result"]
        self.assertEqual(len(hit), 1)                         # 10 s after the cut starts

    def test_stale_series_fails(self):
        fails, out = self.run_live("stale")
        self.assertTrue(any("stale series: cut" in f for f in fails), "\n".join(out))
        self.assertTrue(any("connectivity_state without" in f and "'cut'" in f for f in fails), "\n".join(out))

    def test_missing_control_fails(self):
        fails, out = self.run_live("nocontrol")
        self.assertTrue(any("control vantage missing" in f for f in fails), "\n".join(out))
        self.assertTrue(any("scrape up" in f for f in fails), "\n".join(out))

    def test_positive_control_gates_any_zero(self):
        out = []
        fails = live(self.url, self.q, at=self.at["fresh"] - 86400 * 2, log=out.append)  # before any data exists
        self.assertEqual(len(fails), 1)
        self.assertIn("positive control", fails[0])

    def timeline(self, start, end):
        exprs = {x["id"]: x["expr"] for x in self.q["queries"] if x.get("panel") == TIMELINE}
        out = {}
        for ref, e in exprs.items():
            q = urllib.parse.urlencode({"query": e, "start": start, "end": end, "step": 10, "nocache": 1})
            with urllib.request.urlopen(f"{self.url}/api/v1/query_range?{q}", timeout=20) as r:
                out[ref] = {"frames": frames_from_matrix(ref, json.loads(r.read())["data"]["result"])}
        return out

    def test_timeline_frames_in_the_run_window(self):
        t = self.at["fresh"]
        res = self.timeline(t - 600, t)
        self.assertEqual(check_timeline_frames(res, require_pairs=True), [])
        vals = {v for f in res["probe_samples_fresh"]["frames"] for v in f["data"]["values"][1]}
        self.assertEqual(vals, {1.0})

    def test_timeline_frames_in_an_idle_window(self):
        t = self.at["fresh"] - 86400                      # without any probe sample
        res = self.timeline(t - 900, t)
        self.assertEqual(check_timeline_frames(res), [])
        self.assertEqual({v for f in res["probe_samples_fresh"]["frames"] for v in f["data"]["values"][1]}, {0.0})
        # the same window with connectivity_state only reproduces the Grafana defect
        self.assertTrue(check_timeline_frames({"connectivity_state": res["connectivity_state"]}))


def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--live-url")
    ap.add_argument("--require-probes", action="store_true")
    ap.add_argument("--time", type=float)
    ap.add_argument("--live-grafana")
    ap.add_argument("--context")
    ap.add_argument("--kubeconfig")
    ap.add_argument("--from-ms", type=int)
    ap.add_argument("--to-ms", type=int)
    a, rest = ap.parse_known_args()
    if a.live_grafana:
        if not a.context:
            ap.error("--live-grafana requires --context")
        return 1 if live_grafana(a.live_grafana, a.context, a.kubeconfig, a.from_ms, a.to_ms, a.require_probes) else 0
    if a.live_url:
        return 1 if live(a.live_url, load_queries(), a.require_probes, a.time) else 0
    unittest.main(argv=[sys.argv[0], *rest])


if __name__ == "__main__":
    sys.exit(main())
