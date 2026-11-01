#!/usr/bin/env python3
"""test_retail_store.py - OFFLINE contract of the local Retail Store, with paired controls.

What it proves, without a cluster or AWS:
  manifest   three Deployments from harbor.local by digest, each digest mirrored by registry/images.txt; the Cart
             runs with CREATE_TABLE=false against DynamoDB Local; the table-init sidecar owns the Items table; no
             Job, no LoadBalancer or NodePort Service; the Cart syncs after the database.
  network    default deny plus DNS; the only ingress paths are UI -> Cart :8080 -> DynamoDB Local :8000; no egress
             leaves the namespace, so the store has no route to the Region or the Internet; every Service targetPort
             and NetworkPolicy port is a container port of the pod it selects.
  capacity   steady-state requests plus one rolling-update surge pod fit the ResourceQuota; no container exceeds
             the LimitRange maximum.
  delivery   exactly one ApplicationSet element, gated by enable_retail_store, applies apps/retail-store; the
             egress cut refuses retail-* namespaces as targets.
  sidecar    the table-init script RUNS against a fake aws and sleep: fresh database, existing table with an item,
             memory loss while the sidecar is alive, and a non-ResourceNotFound error.
  controls   each mutation below MUST make the contract fail; a control that passes is a broken test.

Usage: python3 platform/apps/retail-store/tests/test_retail_store.py   (rc 0 = contract and every control pass)
"""
import copy
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
APP = HERE.parent
ROOT = HERE.parents[3]
IMAGES = ROOT / "platform" / "components" / "registry" / "images.txt"
APPLICATIONSET = ROOT / "platform" / "gitops" / "applicationset.yaml"
EGRESS = ROOT / "platform" / "components" / "chaos-egress" / "egress_chaos.py"
NAMESPACE = "retail-store"
DEPLOYMENTS = ("retail-ui", "retail-cart", "retail-dynamodb")
DDB, SIDECAR = "retail-dynamodb", "table-init"
WAVE = "argocd.argoproj.io/sync-wave"
UNITS = {"Ki": 2**10, "Mi": 2**20, "Gi": 2**30, "m": 1e-3, "": 1}
CART_ENV = {"RETAIL_CART_PERSISTENCE_PROVIDER": "dynamodb", "RETAIL_CART_PERSISTENCE_DYNAMODB_TABLE_NAME": "Items",
            "RETAIL_CART_PERSISTENCE_DYNAMODB_CREATE_TABLE": "false",
            "RETAIL_CART_PERSISTENCE_DYNAMODB_ENDPOINT": "http://retail-dynamodb:8000"}


def load():
    docs = []
    for name in ("namespace.yaml", "retail-store.yaml"):
        docs += [d for d in yaml.safe_load_all((APP / name).read_text()) if d]
    return docs


def by(objs, kind):
    return {o["metadata"]["name"]: o for o in objs if o.get("kind") == kind}


def containers(dep):
    return (dep or {}).get("spec", {}).get("template", {}).get("spec", {}).get("containers") or []


def env_of(c):
    return {e["name"]: e.get("value") for e in c.get("env") or []}


def qty(v):
    m = re.fullmatch(r"([0-9.]+)(Ki|Mi|Gi|m)?", str(v))
    return float(m.group(1)) * UNITS[m.group(2) or ""]


def wave(o):
    return int(((o.get("metadata") or {}).get("annotations") or {}).get(WAVE, "0"))


def mirrored():
    out = {}
    for line in IMAGES.read_text().splitlines():
        if "|" in line:
            source, target = line.split("|", 1)
            out[target] = source.split("@", 1)[1] if "@" in source else None
    return out


def contract(objs, appset_text, mirror):
    fails = []
    deps, svcs, nps = by(objs, "Deployment"), by(objs, "Service"), by(objs, "NetworkPolicy")
    if sorted(deps) != sorted(DEPLOYMENTS):
        fails.append(f"Deployments {sorted(deps)} != {sorted(DEPLOYMENTS)}")
    if by(objs, "Job") or by(objs, "CronJob"):
        fails.append("a Job exists: the table-init sidecar owns the Items table")
    for o in objs:
        if o["kind"] != "Namespace" and o["metadata"].get("namespace") not in (None, NAMESPACE):
            fails.append(f"{o['kind']}/{o['metadata']['name']} targets namespace {o['metadata'].get('namespace')}")
    for name, dep in deps.items():
        for c in containers(dep):
            m = re.fullmatch(r"harbor\.local/(apps/[a-z0-9-]+:[0-9.]+)@(sha256:[0-9a-f]{64})", c.get("image", ""))
            if not m:
                fails.append(f"{name}/{c.get('name')}: image {c.get('image')} is not harbor.local/apps by digest")
            elif mirror.get(m.group(1)) != m.group(2):
                fails.append(f"{name}/{c.get('name')}: {m.group(1)} has no mirror line with digest {m.group(2)[:19]}")
            if not (c.get("resources") or {}).get("limits", {}).get("memory"):
                fails.append(f"{name}/{c.get('name')}: no memory limit")
    cart = containers(deps.get("retail-cart"))
    if not cart or any(env_of(cart[0]).get(k) != v for k, v in CART_ENV.items()):
        fails.append(f"Cart env differs from {CART_ENV}")
    ddb = deps.get(DDB)
    if [c.get("name") for c in containers(ddb)] != ["dynamodb", SIDECAR]:
        fails.append(f"{DDB} containers {[c.get('name') for c in containers(ddb)]} != ['dynamodb', '{SIDECAR}']")
    elif (ddb["spec"].get("strategy") or {}).get("type") != "Recreate":
        fails.append(f"{DDB} without strategy Recreate")
    if deps.get("retail-cart") and ddb and wave(deps["retail-cart"]) <= wave(ddb):
        fails.append("the Cart does not sync after the database (it reads Items at startup)")
    sidecar = next((c for c in containers(ddb) if c.get("name") == SIDECAR), {})
    script = " ".join(str(x) for x in (sidecar.get("command") or []) + (sidecar.get("args") or []))
    for need in ("describe-table", "ResourceNotFoundException", "create-table", "http://127.0.0.1:8000", "while true", "table-ready"):
        if need not in script:
            fails.append(f"sidecar script without {need!r}")
    for bad in ("delete-table", "update-table", "put-item", "delete-item", "batch-write-item", "retail-dynamodb:8000"):
        if bad in script:
            fails.append(f"sidecar script contains {bad!r}")
    if not ((sidecar.get("readinessProbe") or {}).get("exec") and "table-ready" in json.dumps(sidecar.get("readinessProbe"))):
        fails.append("sidecar readiness does not depend on the table")
    for name, svc in svcs.items():
        if svc["spec"].get("type", "ClusterIP") != "ClusterIP":
            fails.append(f"Service {name} type {svc['spec'].get('type')}: the store is reached through kubectl port-forward")
    quota = (by(objs, "ResourceQuota").get("retail-quota") or {}).get("spec", {}).get("hard", {})
    if quota.get("services.loadbalancers") != "0" or quota.get("services.nodeports") != "0":
        fails.append(f"quota allows external Services: {quota}")
    if sorted(nps) != ["allow-dns-egress", "default-deny-all", "retail-cart", "retail-dynamodb", "retail-ui"]:
        fails.append(f"NetworkPolicies {sorted(nps)}")
    dns = {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}},
           "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}
    for name, np in nps.items():
        for rule in np["spec"].get("egress") or []:
            for peer in rule.get("to") or [{}]:
                if peer != dns and set(peer) != {"podSelector"}:
                    fails.append(f"NetworkPolicy {name}: egress peer {peer} leaves the namespace")
    ingress = {name: [p for r in np["spec"].get("ingress") or [] for p in r.get("from") or [{}]] for name, np in nps.items()}
    want = {"retail-cart": [{"podSelector": {"matchLabels": {"app.kubernetes.io/name": "retail-ui"}}}],
            "retail-dynamodb": [{"podSelector": {"matchLabels": {"app.kubernetes.io/name": "retail-cart"}}}]}
    for name, peers in ingress.items():
        if peers and peers != want.get(name):
            fails.append(f"NetworkPolicy {name}: ingress {peers}")
    limit = by(objs, "LimitRange").get("retail-defaults", {}).get("spec", {}).get("limits", [{}])[0].get("max", {}).get("memory")
    req_cpu = req_mem = lim_mem = 0.0
    surge = 0.0
    for dep in deps.values():
        cpu = sum(qty((c.get("resources") or {}).get("requests", {}).get("cpu", "0")) for c in containers(dep))
        mem = sum(qty((c.get("resources") or {}).get("requests", {}).get("memory", "0")) for c in containers(dep))
        req_cpu, req_mem = req_cpu + cpu, req_mem + mem
        lim_mem += sum(qty((c.get("resources") or {}).get("limits", {}).get("memory", "0")) for c in containers(dep))
        surge = max(surge, mem)
        for c in containers(dep):
            if limit and qty((c.get("resources") or {}).get("limits", {}).get("memory", "0")) > qty(limit):
                fails.append(f"{dep['metadata']['name']}/{c['name']}: memory limit above the LimitRange max {limit}")
    if quota and (req_cpu > qty(quota["requests.cpu"]) or req_mem + surge > qty(quota["requests.memory"])
                  or lim_mem + surge > qty(quota["limits.memory"])):
        fails.append(f"requests cpu={req_cpu} memory={req_mem + surge} limits={lim_mem + surge} exceed the quota {quota}")
    fails += port_pairs(deps, svcs, nps)
    elements = re.findall(r"\{app: retail-store, kind: directory, namespace: retail-store, wave: \"[0-9-]+\", path: apps/retail-store\}", appset_text)
    gate = re.search(r"enable_platform: \"true\", enable_retail_store: \"true\"\}\}\}\n\s+- list: \{elements: \[\{app: retail-store,", appset_text)
    if len(elements) != 1 or not gate:
        fails.append("ApplicationSet does not apply apps/retail-store exactly once behind enable_retail_store")
    return fails


def port_pairs(deps, svcs, nps):
    """Every Service targetPort and every NetworkPolicy port towards or into a Retail pod is a container port of it."""
    fails, ports, named = [], {}, {}
    for dep in deps.values():
        app = dep["spec"]["template"]["metadata"]["labels"].get("app.kubernetes.io/name")
        for c in containers(dep):
            for p in c.get("ports") or []:
                ports.setdefault(app, set()).add(p["containerPort"])
                named[(app, p.get("name"))] = p["containerPort"]
    for name, svc in svcs.items():
        app = (svc["spec"].get("selector") or {}).get("app.kubernetes.io/name")
        for p in svc["spec"].get("ports") or []:
            t = p.get("targetPort", p.get("port"))
            t = named.get((app, t)) if isinstance(t, str) else t
            if t not in ports.get(app, set()):
                fails.append(f"Service {name}: targetPort {p.get('targetPort')} is not a container port of {app}")
    for name, np in nps.items():
        me = (np["spec"]["podSelector"].get("matchLabels") or {}).get("app.kubernetes.io/name")
        for rule in np["spec"].get("egress") or []:
            for peer in rule.get("to") or []:
                tgt = ((peer.get("podSelector") or {}).get("matchLabels") or {}).get("app.kubernetes.io/name")
                if tgt and "namespaceSelector" not in peer:
                    for p in rule.get("ports") or []:
                        if p.get("port") not in ports.get(tgt, set()):
                            fails.append(f"NetworkPolicy {name}: egress port {p.get('port')} is not a container port of {tgt}")
        for rule in np["spec"].get("ingress") or []:
            for p in rule.get("ports") or []:
                if me and p.get("port") not in ports.get(me, set()):
                    fails.append(f"NetworkPolicy {name}: ingress port {p.get('port')} is not a container port of {me}")
    return fails


FAKE_AWS = r"""
import json, os, sys
from pathlib import Path
st_path = os.environ["FAKE_DDB"]
st = json.loads(Path(st_path).read_text())
a = sys.argv[1:]
def save():
    Path(st_path).write_text(json.dumps(st))
def opt(name, many=False):
    if name not in a:
        return [] if many else None
    i = a.index(name) + 1
    if not many:
        return a[i]
    out = []
    while i < len(a) and not a[i].startswith("--"):
        out.append(a[i]); i += 1
    return out
def die(call, msg, rc):
    st["calls"].append(call); save(); print(msg, file=sys.stderr); sys.exit(rc)
sub = next((x for x in a if x in ("describe-table", "create-table", "delete-table", "update-table", "put-item",
                                  "delete-item", "batch-write-item", "wait")), None)
if a[:1] != ["dynamodb"] or sub is None:
    die(f"other:{a}", "fake aws: dynamodb only", 252)
if not os.environ.get("AWS_ACCESS_KEY_ID") or not (os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")):
    die(f"{sub}:nocreds", "Unable to locate credentials.", 253)
ep = opt("--endpoint-url")
if ep != "http://127.0.0.1:8000" or st["down"] > 0:
    st["down"] = max(0, st["down"] - 1)
    die(f"{sub}:down", f'Could not connect to the endpoint URL: "{ep}/"', 255)
if st.get("denied"):
    die(f"{sub}:err", "An error occurred (UnrecognizedClientException) when calling the DescribeTable operation: bad", 254)
t = opt("--table-name")
nf = "An error occurred (ResourceNotFoundException) when calling the {} operation: Cannot do operations on a non-existent table"
if sub == "describe-table":
    if t not in st["tables"]:
        die("describe:rnf", nf.format("DescribeTable"), 254)
    st["calls"].append("describe:ok"); save(); print("ACTIVE"); sys.exit(0)
if sub == "create-table":
    if t in st["tables"]:
        die("create:inuse", "An error occurred (ResourceInUseException) when calling the CreateTable operation: Cannot create preexisting table", 254)
    st["tables"][t] = {"attrs": opt("--attribute-definitions", True), "keys": opt("--key-schema", True),
                       "gsi": opt("--global-secondary-indexes", True), "items": []}
    st["calls"].append("create"); save(); print(t); sys.exit(0)
if sub == "delete-table":
    st["tables"].pop(t, None)
st["calls"].append(sub.split("-")[0]); save(); sys.exit(0)
"""
FAKE_SLEEP = r"""
import json, os, signal, sys
from pathlib import Path
st_path = os.environ["FAKE_DDB"]
st = json.loads(Path(st_path).read_text())
st["rounds"] += 1
if st.get("wipe_at") == st["rounds"]:
    st["tables"] = {}
    st["calls"].append("WIPE")
Path(st_path).write_text(json.dumps(st))
if st["rounds"] >= st["max_rounds"]:
    os.kill(os.getppid(), signal.SIGTERM)
"""
CART_SCHEMA = {"attrs": ["AttributeName=id,AttributeType=S", "AttributeName=customerId,AttributeType=S"],
               "keys": ["AttributeName=id,KeyType=HASH"],
               "gsi": ["IndexName=idx_global_customerId,KeySchema=[{AttributeName=customerId,KeyType=HASH}],"
                       "Projection={ProjectionType=ALL},ProvisionedThroughput={ReadCapacityUnits=1,WriteCapacityUnits=1}"]}
PROBE_ITEM = {"id": "probe-item", "customerId": "probe-cart"}


def run_sidecar(c, w, state):
    """Runs the sidecar like the kubelet (command + args, container env only, PATH with fake aws and sleep) until the
    SIGTERM of round max_rounds; then runs both probes with the same env. Returns (rc, log, state, ready, live)."""
    bindir = w / "bin"
    if not bindir.exists():
        bindir.mkdir(parents=True)
        for name, body in (("aws", FAKE_AWS), ("sleep", FAKE_SLEEP)):
            (bindir / name).write_text(f"#!{sys.executable}\n" + body)
            (bindir / name).chmod(0o755)
    sp = w / "ddb.json"
    sp.write_text(json.dumps({"down": 0, "tables": {}, "calls": [], "rounds": 0, "max_rounds": 4, **state}))
    env = {e["name"]: e.get("value", "") for e in c.get("env") or []}
    env.update(PATH=f"{bindir}:/usr/bin:/bin", FAKE_DDB=str(sp), INIT_STATE_DIR=str(w / "init"))
    try:
        r = subprocess.run((c.get("command") or []) + (c.get("args") or []), env=env, capture_output=True, text=True,
                           timeout=30, cwd=w)
        rc, log = r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired as e:
        rc, log = "timeout", f"{e.stdout or ''}{e.stderr or ''}"
    probe = lambda p: subprocess.run(c[p]["exec"]["command"], env=env, capture_output=True, timeout=10).returncode \
        if (c.get(p) or {}).get("exec") else 99
    return rc, log, json.loads(sp.read_text()), probe("readinessProbe"), probe("livenessProbe")


def guarded_creates(calls):
    return all(i > 0 and calls[i - 1] == "describe:rnf" for i, x in enumerate(calls) if x.startswith("create"))


def reconcile(c, w):
    """Findings of the sidecar EXECUTED in four scenarios against the fake aws."""
    w.mkdir(parents=True, exist_ok=True)
    fails, destructive = [], ("delete", "update", "put", "batch")

    def common(tag, rc, log, st, rounds):
        f = []
        if rc not in (0, -15, 143) or st["rounds"] < rounds:
            f.append(f"{tag}: the sidecar exited by itself (rc={rc} rounds={st['rounds']}/{rounds}): {log.strip()[-200:]}")
        if any(x.split(":")[0] in destructive for x in st["calls"]):
            f.append(f"{tag}: destructive call {st['calls']}")
        if not guarded_creates(st["calls"]):
            f.append(f"{tag}: create-table without a ResourceNotFound describe right before it: {st['calls']}")
        return f

    rc, log, st, ready, live = run_sidecar(c, w / "fresh", {"down": 2})
    fails += common("fresh", rc, log, st, 4)
    tab = st["tables"].get("Items")
    if not tab or {k: tab[k] for k in CART_SCHEMA} != CART_SCHEMA or "result=created" not in log:
        fails.append(f"fresh: Items not created with the Cart schema: {tab} {log.strip()[-200:]}")
    if st["calls"].count("create") != 1 or ready != 0 or live != 0:
        fails.append(f"fresh: creates={st['calls'].count('create')} ready_rc={ready} live_rc={live} (expected 1, 0, 0)")
    seeded = {"Items": dict(CART_SCHEMA, items=[PROBE_ITEM])}
    rc, log, st, ready, live = run_sidecar(c, w / "existing", {"tables": copy.deepcopy(seeded), "max_rounds": 3})
    fails += common("existing", rc, log, st, 3)
    if any(x.startswith("create") for x in st["calls"]) or PROBE_ITEM not in (st["tables"].get("Items") or {}).get("items", []) \
            or ready != 0:
        fails.append(f"existing: an existing table was not a no-op with the item kept and the pod Ready: {st['calls']} ready_rc={ready}")
    rc, log, st, ready, live = run_sidecar(c, w / "wiped", {"tables": copy.deepcopy(seeded), "max_rounds": 5, "wipe_at": 2})
    fails += common("wiped", rc, log, st, 5)
    after = st["calls"][st["calls"].index("WIPE") + 1:] if "WIPE" in st["calls"] else []
    if after.count("create") != 1 or "Items" not in st["tables"] or ready != 0:
        fails.append(f"wiped: the database lost its memory and the sidecar did not recreate Items ({after}, ready_rc={ready})")
    rc, log, st, ready, live = run_sidecar(c, w / "denied", {"denied": True, "max_rounds": 3})
    fails += common("denied", rc, log, st, 3)
    if any(x.startswith("create") for x in st["calls"]) or ready == 0 or live != 0:
        fails.append(f"denied: a non-ResourceNotFound error created a table or left the pod Ready ({st['calls']} ready_rc={ready})")
    return fails


def sidecar_of(objs):
    return next(c for c in containers(by(objs, "Deployment")[DDB]) if c["name"] == SIDECAR)


def m_create_table(objs, _a, _m):
    for e in containers(by(objs, "Deployment")["retail-cart"])[0]["env"]:
        if e["name"] == "RETAIL_CART_PERSISTENCE_DYNAMODB_CREATE_TABLE":
            e["value"] = "true"


def m_public_image(objs, _a, _m):
    containers(by(objs, "Deployment")["retail-ui"])[0]["image"] = "public.ecr.aws/aws-containers/retail-store-sample-ui:1.6.3"


def m_unmirrored(_o, _a, mirror):
    mirror.pop("apps/aws-cli:2.39.1")


def m_egress_out(objs, _a, _m):
    by(objs, "NetworkPolicy")["retail-cart"]["spec"]["egress"].append({"to": [{"ipBlock": {"cidr": "0.0.0.0/0"}}]})


def m_ingress_open(objs, _a, _m):
    by(objs, "NetworkPolicy")[DDB]["spec"]["ingress"][0]["from"].append({"namespaceSelector": {}})


def m_load_balancer(objs, _a, _m):
    by(objs, "Service")["retail-ui"]["spec"]["type"] = "LoadBalancer"


def m_quota(objs, _a, _m):
    by(objs, "ResourceQuota")["retail-quota"]["spec"]["hard"]["services.loadbalancers"] = "1"


def m_job(objs, _a, _m):
    objs.append({"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": "retail-table-init"}, "spec": {}})


def m_no_sidecar(objs, _a, _m):
    dep = by(objs, "Deployment")[DDB]
    dep["spec"]["template"]["spec"]["containers"] = containers(dep)[:1]


def m_delete_table(objs, _a, _m):
    c = sidecar_of(objs)
    c["args"] = [c["args"][0].replace("pause \"$RECONCILE_SECONDS\"", "ddb delete-table --table-name Items; pause \"$RECONCILE_SECONDS\"")]


def m_same_wave(objs, _a, _m):
    by(objs, "Deployment")["retail-cart"]["metadata"]["annotations"][WAVE] = "0"


def m_memory(objs, _a, _m):
    containers(by(objs, "Deployment")["retail-cart"])[0]["resources"]["limits"]["memory"] = "3Gi"


def m_readiness(objs, _a, _m):
    sidecar_of(objs)["readinessProbe"] = {"exec": {"command": ["/bin/true"]}}


def m_appset(_o, appset, _m):
    return appset.replace("enable_retail_store", "enable_platform_store")


def m_namespace(objs, _a, _m):
    by(objs, "Service")["retail-cart"]["metadata"]["namespace"] = "default"


def m_cart_port(objs, _a, _m):
    containers(by(objs, "Deployment")["retail-cart"])[0]["ports"][0]["containerPort"] = 8081


def m_ui_egress_port(objs, _a, _m):
    by(objs, "NetworkPolicy")["retail-ui"]["spec"]["egress"][0]["ports"][0]["port"] = 8081


CONTROLS = [m_create_table, m_public_image, m_unmirrored, m_egress_out, m_ingress_open, m_load_balancer, m_quota, m_job,
            m_no_sidecar, m_delete_table, m_same_wave, m_memory, m_readiness, m_appset, m_namespace, m_cart_port,
            m_ui_egress_port]


def m_exits_after_create(objs):
    c = sidecar_of(objs)
    marker = 'say "table=Items result=created"\n'
    assert c["args"][0].count(marker) == 1, "the sidecar script changed shape: adjust the controls"
    c["args"] = [c["args"][0].replace(marker, 'say "table=Items result=created"; exit 0\n', 1)]
    return lambda f: any("exited by itself" in x for x in f) and any(x.startswith("wiped:") for x in f)


def m_unconditional_create(objs):
    sidecar_of(objs)["args"] = ["while true; do aws dynamodb --endpoint-url http://127.0.0.1:8000 create-table "
                                "--table-name Items --attribute-definitions AttributeName=id,AttributeType=S "
                                "--key-schema AttributeName=id,KeyType=HASH --provisioned-throughput "
                                "ReadCapacityUnits=1,WriteCapacityUnits=1; sleep 10 & wait $!; done"]
    return lambda f: any("without a ResourceNotFound describe" in x for x in f)


def m_blind_readiness(objs):
    sidecar_of(objs)["readinessProbe"]["exec"]["command"] = ["/bin/bash", "-c", "true"]
    return lambda f: any(x.startswith("denied:") for x in f)


RUN_CONTROLS = [m_exits_after_create, m_unconditional_create, m_blind_readiness]


def egress_refuses_retail():
    spec = importlib.util.spec_from_file_location("egress_chaos", EGRESS)
    ec = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ec)
    example = json.loads((EGRESS.parent / "inputs.example.json").read_text())
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "in.json"
        p.write_text(json.dumps({**example, "target_namespaces": ["argocd", NAMESPACE]}))
        try:
            ec.load_inputs(p)
        except ec.InputError:
            return True
    return False


def main():
    objs, appset, mirror = load(), APPLICATIONSET.read_text(), mirrored()
    fails = contract(objs, appset, mirror)
    if not egress_refuses_retail():
        fails.append(f"egress_chaos.py accepts {NAMESPACE} as a cut target")
    with tempfile.TemporaryDirectory() as tmp:
        fails += reconcile(sidecar_of(objs), Path(tmp) / "base")
        for f in fails:
            print(f"FAIL {f}")
        ok = 0
        for mut in CONTROLS:
            o, m = copy.deepcopy(objs), dict(mirror)
            a = mut(o, appset, m) or appset
            got = contract(o, a, m)
            print(f"{'PASS' if got else 'FAIL'} control {mut.__name__[2:]}: {(got or ['not detected'])[0][:120]}")
            ok += bool(got)
        for mut in RUN_CONTROLS:
            o = copy.deepcopy(objs)
            reason = mut(o)
            got = reconcile(sidecar_of(o), Path(tmp) / mut.__name__)
            hit = bool(got) and reason(got)
            print(f"{'PASS' if hit else 'FAIL'} control {mut.__name__[2:]}: {(got or ['not detected'])[0][:120]}")
            ok += hit
    total = len(CONTROLS) + len(RUN_CONTROLS)
    print(f"RESULT test_retail_store contract={'ok' if not fails else 'FAIL'} controls={ok}/{total}")
    return 0 if not fails and ok == total else 1


if __name__ == "__main__":
    sys.exit(main())
