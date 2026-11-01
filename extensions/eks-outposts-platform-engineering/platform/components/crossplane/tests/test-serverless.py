#!/usr/bin/env python3
"""test-serverless.py - OFFLINE contract of the serverless multi-tier recipe, with paired controls.

What it proves, without a cluster or AWS:
  layout     recipes/ is flat (the Application crossplane-recipes does not recurse) and holds the five
             XRDs and Compositions; no kro and no ACK anywhere in the component.
  schema     every base field and every patch path of every Composition exists in the CRD schema of the
             PINNED provider (tests/provider-schemas.json, generated from the digests in packages.yaml)
             or in the XRD of the nested XR. The PlatformBucket and PlatformTable Compositions of recipes/
             are the positive control of this validator.
  packages   each provider is pulled from harbor.local by digest, has the same digest and a mirror line in
             registry/images.txt, a ServiceAccount fixed by its DeploymentRuntimeConfig, and that
             ServiceAccount is the one the Pod Identity association of BOTH IaC flavors targets.
  render     a minimal patch-and-transform renderer runs the whole chain with a fixture XR and fake
             observed status, then asserts the security contract on the RENDERED objects: no IAM resource,
             the function runs with the shared runtime role of the XR, the distribution uses the shared OAC
             of the XR, OpenAPI with exactly the three routes and no credentials, invoke permission scoped to
             this API, bucket policy for this distribution, every regional resource in the XR region, tags,
             AWS name limits.
  region     no region literal in the serverless XRDs or Compositions: every regional managed resource takes
             spec.forProvider.region from spec.region (the hidden platform contract), and nothing else does.
  handler    the zip embedded in the Composition is the zip of serverless-handler/main.py, and the
             handler answers the three routes correctly with a stub DynamoDB client.
  controls   each mutation below is applied in memory and MUST make the contract fail with the expected
             message; a control that passes is a broken test, and fails the run.

Usage: test-serverless.py            (rc 0 = contract and every control pass)
"""
import base64
import copy
import hashlib
import importlib.util
import io
import json
import re
import sys
import types
import zipfile
from pathlib import Path

import jsonschema
import yaml

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
COMPONENT = HERE.parent
REPO = COMPONENT.parents[2]
RECIPES = COMPONENT / "recipes"
GROUP = "serverless.platform.sample.lab"
KINDS = {"XServerlessMultiTier", "XDynamoDBTable", "XLambdaFunction", "XApiRest", "XSpa"}
SERVERLESS_PROVIDERS = ("lambda", "apigateway", "cloudfront", "cloudwatchlogs")
REGION = "eu-south-2"        # fixture Region: a Region the docs never use proves the recipe is parameterized
PREFIX = "sample-plat-"
FUNCTION = "function-patch-and-transform"
# Fields of the top-level XR a team controls. Anything else reaching a resource is a leak of control.
TEAM_FIELDS = {"spec.name", "spec.team", "spec.size"}
# Hidden platform contract: copied by the operator from the identity IaC outputs and platform-contract.json.
PLATFORM_FIELDS = {"spec.roleArn", "spec.oacId", "spec.region"}
REGION_LITERAL = re.compile(r"\b(?:[a-z]{2}-(?:gov-|iso[a-z]*-)?[a-z]+-[0-9])\b")


# ----------------------------------------------------------------------------- loading
def load_ctx():
    docs = lambda f: [d for d in yaml.safe_load_all(f.read_text()) if d]
    build = _module(COMPONENT / "serverless-handler" / "build.py", "build")
    return {
        "recipe_files": sorted(p.name for p in RECIPES.iterdir()),
        "recipe_dirs": sorted(p.name for p in RECIPES.iterdir() if p.is_dir()),
        "xrds": docs(RECIPES / "serverless-xrds.yaml"),
        "recipe_text": (RECIPES / "serverless-xrds.yaml").read_text() + (RECIPES / "serverless-compositions.yaml").read_text(),
        "compositions": docs(RECIPES / "serverless-compositions.yaml"),
        "recipe_compositions": docs(RECIPES / "compositions.yaml"),
        "component_text": "\n".join(p.read_text() for p in sorted(COMPONENT.rglob("*.yaml"))),
        "packages": docs(COMPONENT / "packages" / "packages.yaml"),
        "images": (COMPONENT.parent / "registry" / "images.txt").read_text(),
        "schemas": json.loads((HERE / "provider-schemas.json").read_text()),
        "cfn": yaml.load((REPO / "infrastructure" / "cloudformation" / "crossplane-identity.yaml").read_text(),
                         Loader=_cfn_loader()),
        "tf": (REPO / "infrastructure" / "terraform" / "crossplane-identity.tf").read_text(),
        "handler_src": (COMPONENT / "serverless-handler" / "main.py").read_text(),
        "build": build,
    }


def _module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _cfn_loader():
    class L(yaml.SafeLoader):
        pass
    L.add_multi_constructor("!", lambda l, s, n: {s: l.construct_scalar(n) if isinstance(n, yaml.ScalarNode)
                                                   else l.construct_sequence(n) if isinstance(n, yaml.SequenceNode)
                                                   else l.construct_mapping(n)})
    return L


def resources(comp):
    for step in comp["spec"]["pipeline"]:
        for r in (step.get("input") or {}).get("resources", []):
            yield step, r


def patchset_patches(step, patch):
    if patch.get("type") == "PatchSet":
        ps = {p["name"]: p["patches"] for p in step["input"].get("patchSets", [])}
        return ps.get(patch["patchSetName"], [{"type": "MissingPatchSet", "name": patch["patchSetName"]}])
    return [patch]


def all_patches(step, r):
    for p in r.get("patches", []):
        yield from patchset_patches(step, p)


# ----------------------------------------------------------------------------- schema
def flatten(schema, prefix=""):
    out = {}
    if schema.get("type") == "object" and schema.get("properties"):
        for k, v in schema["properties"].items():
            p = f"{prefix}.{k}" if prefix else k
            vt = v.get("type")
            out[p] = "map" if vt == "object" and "additionalProperties" in v and not v.get("properties") else vt
            out.update(flatten(v, p))
    elif schema.get("type") == "array" and "items" in schema:
        out.update(flatten(schema["items"], prefix + "[]"))
    return out


def xrd_fields(xrds):
    out = {}
    for x in xrds:
        v = x["spec"]["versions"][0]
        out[x["spec"]["names"]["kind"]] = flatten(v["schema"]["openAPIV3Schema"])
    return out


def norm_path(path):
    """spec.a[0].b -> spec.a[].b ; tags[team] -> (tags, map key) ; metadata.* is free-form."""
    m = re.fullmatch(r"(.+)\[([^\]\d][^\]]*)\]", path)
    if m:
        return re.sub(r"\[\d+\]", "[]", m.group(1)), True
    return re.sub(r"\[\d+\]", "[]", path), False


def path_ok(fields, path):
    if path.startswith("metadata."):
        return path.split("[")[0] in ("metadata.annotations", "metadata.labels", "metadata.name")
    p, is_key = norm_path(path)
    if is_key:
        return fields.get(p) == "map"
    if p in fields:
        return True
    # spec.environment.USERS_TABLE: a dotted key inside a map field (additionalProperties).
    parts = p.split(".")
    return any(fields.get(".".join(parts[:i])) == "map" for i in range(1, len(parts)))


def base_paths(obj, prefix=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{prefix}.{k}" if prefix else k
            if p.startswith("metadata") or p in ("apiVersion", "kind"):
                continue
            yield p, v
            if not (isinstance(v, dict) and p.endswith(("tags", "environment", "matchLabels"))):
                yield from base_paths(v, p)
    elif isinstance(obj, list):
        for v in obj:
            yield from base_paths(v, prefix + "[]")


def check_schema(ctx, comps, label, fails):
    xf = xrd_fields(ctx["xrds"])
    kinds = ctx["schemas"]["kinds"]
    for comp in comps:
        owner = comp["spec"]["compositeTypeRef"]["kind"]
        owner_fields = xf.get(owner)
        for step, r in resources(comp):
            api, kind = r["base"]["apiVersion"], r["base"]["kind"]
            where = f"{label} {comp['metadata']['name']}/{r['name']}"
            if api.startswith(GROUP + "/"):
                target = xf.get(kind)
            else:
                key = f"{api}/{kind}"
                target = (kinds.get(key) or {}).get("fields")
                if target is None:
                    fails.append(f"schema {where}: {key} absent from provider-schemas.json (provider not pinned?)")
                    continue
            if target is None:
                fails.append(f"schema {where}: nested kind {kind} has no XRD")
                continue
            for p, _ in base_paths(r["base"]):
                if not path_ok(target, p) and p.split(".")[0] in ("spec",):
                    fails.append(f"schema {where}: base field {p} not in the {kind} schema")
            for p in all_patches(step, r):
                t = p.get("type")
                if t == "MissingPatchSet":
                    fails.append(f"schema {where}: patchSet {p['name']} not declared")
                    continue
                if t in ("FromCompositeFieldPath", "CombineFromComposite"):
                    srcs = [p["fromFieldPath"]] if t == "FromCompositeFieldPath" else [v["fromFieldPath"] for v in p["combine"]["variables"]]
                    for s in srcs:
                        if owner_fields is not None and not path_ok(owner_fields, s):
                            fails.append(f"schema {where}: source {s} not in the {owner} XRD")
                    if not path_ok(target, p["toFieldPath"]):
                        fails.append(f"schema {where}: target {p['toFieldPath']} not in the {kind} schema")
                elif t == "ToCompositeFieldPath":
                    if not path_ok(target, p["fromFieldPath"]):
                        fails.append(f"schema {where}: source {p['fromFieldPath']} not in the {kind} schema")
                    if owner_fields is not None and not path_ok(owner_fields, p["toFieldPath"]):
                        fails.append(f"schema {where}: target {p['toFieldPath']} not declared in the {owner} XRD status")


# ----------------------------------------------------------------------------- render (subset of P&T)
def _split(path):
    out = []
    for part in re.findall(r"[^.\[\]]+|\[[^\]]+\]", path):
        out.append(int(part[1:-1]) if part.startswith("[") and part[1:-1].isdigit()
                   else part[1:-1] if part.startswith("[") else part)
    return out


def get(obj, path):
    for k in _split(path):
        try:
            obj = obj[k]
        except (KeyError, IndexError, TypeError):
            return None
    return obj


def put(obj, path, val):
    keys = _split(path)
    for i, k in enumerate(keys[:-1]):
        nxt = [] if isinstance(keys[i + 1], int) else {}
        if isinstance(k, int):
            while len(obj) <= k:
                obj.append({})
            obj = obj[k]
        else:
            obj = obj.setdefault(k, nxt)
    obj[keys[-1]] = val


def gofmt(fmt, args):
    if "%[" in fmt:
        return re.sub(r"%\[(\d+)\]s", lambda m: str(args[int(m.group(1)) - 1]), fmt)
    it = iter(args)
    return re.sub(r"%s", lambda m: str(next(it)), fmt)


def transform(val, ts):
    for t in ts or []:
        if t["type"] == "map":
            val = t["map"][val]
        elif t["type"] == "string":
            s = t["string"]
            if s["type"] == "Format":
                val = gofmt(s["fmt"], [val])
            elif s["type"] == "Regexp":
                m = re.search(s["regexp"]["match"], val)
                if not m:
                    raise ValueError(f"Regexp {s['regexp']['match']} did not match {val}")
                val = m.group(s["regexp"].get("group", 0))
            elif s["type"] == "Convert" and s["convert"] == "ToSha256":
                val = hashlib.sha256(val.encode()).hexdigest()
            else:
                raise ValueError(f"transform not emulated: {s}")
        else:
            raise ValueError(f"transform not emulated: {t}")
    return val


def render(comp, xr, observed):
    """desired {name: obj}, XR with status merged. observed = {resource name: composed status dict}."""
    xr = copy.deepcopy(xr)
    desired = {}
    # ToComposite first (observed state of the previous reconcile), then the desired state, like P&T.
    for step, r in resources(comp):
        for p in all_patches(step, r):
            if p["type"] == "ToCompositeFieldPath" and r["name"] in observed:
                v = get(observed[r["name"]], p["fromFieldPath"])
                if v is not None:
                    put(xr, p["toFieldPath"], transform(v, p.get("transforms")))
    for step, r in resources(comp):
        obj, skip = copy.deepcopy(r["base"]), False
        for p in all_patches(step, r):
            required = (p.get("policy") or {}).get("fromFieldPath") == "Required"
            if p["type"] == "FromCompositeFieldPath":
                v = get(xr, p["fromFieldPath"])
                if v is None:
                    skip = skip or required
                    continue
                put(obj, p["toFieldPath"], transform(v, p.get("transforms")))
            elif p["type"] == "CombineFromComposite":
                vs = [get(xr, v["fromFieldPath"]) for v in p["combine"]["variables"]]
                if any(v is None for v in vs):
                    skip = skip or required
                    continue
                put(obj, p["toFieldPath"], gofmt(p["combine"]["string"]["fmt"], vs))
        if not skip:
            desired[r["name"]] = obj
    return desired, xr


ACCOUNT, CLUSTER, APP, TEAM = "1" * 12, "platform-outposts", "shop", "team-demo"
ROLE = f"arn:aws:iam::{ACCOUNT}:role/{PREFIX}runtime-{CLUSTER}"
OAC = "E2OAC0000FIXTURE"
TOP = {"name": APP, "team": TEAM, "size": "small", "roleArn": ROLE, "oacId": OAC, "region": REGION}


def full_render(ctx):
    """Runs the five Compositions with fake observed status until the chain is complete."""
    comps = {c["spec"]["compositeTypeRef"]["kind"]: c for c in ctx["compositions"]}
    arn = lambda svc, res, region=REGION: f"arn:aws:{svc}:{region}:{ACCOUNT}:{res}"
    top = {"apiVersion": f"{GROUP}/v1alpha1", "kind": "XServerlessMultiTier",
           "spec": dict(TOP)}
    observed, out = {}, {}
    for _ in range(6):  # each round = one reconcile; the chain is 5 deep
        desired, top_x = render(comps["XServerlessMultiTier"], top, observed)
        out = {"top": (desired, top_x)}
        for name, nested in desired.items():
            if not nested["apiVersion"].startswith(GROUP):
                continue
            kind = nested["kind"]
            n_obs = {}
            spec = nested["spec"]
            if kind == "XDynamoDBTable":
                n_obs = {"table": {"status": {"atProvider": {"arn": arn("dynamodb", f"table/{spec['tableName']}"), "id": spec["tableName"]}}}}
            elif kind == "XLambdaFunction":
                fn = spec["functionName"]
                fa = arn("lambda", f"function:{fn}")
                n_obs = {"code": {"status": {"atProvider": {"key": "function.zip"}}},
                         "function": {"status": {"atProvider": {"arn": fa, "id": fn,
                                      "invokeArn": f"arn:aws:apigateway:{REGION}:lambda:path/2015-03-31/functions/{fa}/invocations"}}}}
            elif kind == "XApiRest":
                n_obs = {"restapi": {"status": {"atProvider": {"id": "a1b2c3d4e5", "executionArn": arn("execute-api", "a1b2c3d4e5")}}},
                         "stage": {"status": {"atProvider": {"invokeUrl": f"https://a1b2c3d4e5.execute-api.{REGION}.amazonaws.com/v1"}}}}
            elif kind == "XSpa":
                n_obs = {"web-bucket": {"status": {"atProvider": {"id": spec["bucketName"], "bucketRegionalDomainName": f"{spec['bucketName']}.s3.{REGION}.amazonaws.com"}}},
                         "distribution": {"status": {"atProvider": {"arn": f"arn:aws:cloudfront::{ACCOUNT}:distribution/E1DIST000", "domainName": "d111111abcdef8.cloudfront.net"}}}}
            nd, nx = render(comps[kind], nested, n_obs)
            nd2, nx2 = render(comps[kind], nx, n_obs)  # second pass: status now feeds Required patches
            out[name] = (nd2, nx2)
            observed[name] = {"status": nx2.get("status", {})}
    return out


def xrd_spec_schema(ctx, kind):
    x = next(x for x in ctx["xrds"] if x["spec"]["names"]["kind"] == kind)
    return x["spec"]["versions"][0]["schema"]["openAPIV3Schema"]["properties"]["spec"]


# Team input that the top-level XRD must refuse before anything reaches AWS (fail closed at the API).
BAD_TOP = [
    (dict(TOP, name="Shop"), "uppercase name"),
    (dict(TOP, name="s" * 25), "name longer than 24 (bucket and role limits)"),
    (dict(TOP, size="xlarge"), "size outside the enum"),
    ({k: v for k, v in TOP.items() if k != "roleArn"}, "no roleArn (hidden platform contract)"),
    (dict(TOP, roleArn=f"arn:aws:iam::{ACCOUNT}:role/admin"), "roleArn of another role"),
    ({k: v for k, v in TOP.items() if k != "oacId"}, "no oacId (hidden platform contract)"),
    (dict(TOP, oacId="../oac"), "oacId with path characters"),
    ({k: v for k, v in TOP.items() if k != "region"}, "no region (hidden platform contract)"),
    (dict(TOP, region="us-west-2;x"), "region outside the Region pattern"),
]


def check_render(ctx, fails):
    top_schema = xrd_spec_schema(ctx, "XServerlessMultiTier")
    if list(jsonschema.Draft7Validator(top_schema).iter_errors(dict(TOP))):
        fails.append("xrd XServerlessMultiTier: refuses the fixture XR")
    for spec, why in BAD_TOP:
        if not list(jsonschema.Draft7Validator(top_schema).iter_errors(spec)):
            fails.append(f"xrd XServerlessMultiTier: accepts {why}: {spec}")
    try:
        out = full_render(ctx)
    except Exception as e:  # a transform that cannot run is a contract failure, not a crash
        fails.append(f"render: {type(e).__name__}: {e}")
        return
    top_d, top_x = out["top"]
    want_top = {"database-users", "database-posts", "lambda", "api", "lambda-permission", "frontend"}
    if set(top_d) != want_top:
        fails.append(f"render: XServerlessMultiTier rendered {sorted(top_d)}, expected {sorted(want_top)} (a Required input never arrived?)")
        return
    # No identity is composed: the cluster runs no provider-aws-iam.
    for part, (d, _) in out.items():
        for rn, obj in d.items():
            if obj["apiVersion"].startswith("iam."):
                fails.append(f"render: {part}/{rn} is an IAM {obj['kind']}; the runtime role comes from the identity IaC")

    api_d, _ = out["api"]
    try:
        body = json.loads(out["top"][0]["api"]["spec"]["openApiSpecification"])
    except ValueError as e:
        fails.append(f"render: OpenAPI body is not JSON: {e}")
        body = {"paths": {}}
    ops = sorted((p, m) for p, ms in body["paths"].items() for m in ms)
    if ops != [("/health", "get"), ("/items", "get"), ("/items", "post")]:
        fails.append(f"render: OpenAPI operations {ops}")
    lam_x = out["lambda"][1]
    for p, m in ops:
        integ = body["paths"][p][m].get("x-amazon-apigateway-integration", {})
        if integ.get("uri") != lam_x["status"].get("invokeArn") or "credentials" in integ or integ.get("type") != "aws_proxy":
            fails.append(f"render: {m.upper()} {p} integration {integ} is not aws_proxy to this function without credentials")
    if api_d.get("restapi", {}).get("spec", {}).get("forProvider", {}).get("body") != out["top"][0]["api"]["spec"]["openApiSpecification"]:
        fails.append("render: RestAPI body is not the rendered OpenAPI")
    if not api_d.get("deployment", {}).get("spec", {}).get("forProvider", {}).get("triggers", {}).get("redeployment"):
        fails.append("render: Deployment without the body hash trigger")
    # The API has no authorizer (accepted in this sample): stage throttling is its only abuse control.
    ms = api_d.get("method-settings", {}).get("spec", {}).get("forProvider", {})
    st = ms.get("settings") if isinstance(ms.get("settings"), dict) else {}
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    rate, burst = num(st.get("throttlingRateLimit")), num(st.get("throttlingBurstLimit"))
    if ms.get("methodPath") != "*/*" or rate is None or burst is None or not 0 < rate <= 10 or not 0 < burst <= 20:
        fails.append(f"render: stage throttling of the API without authorizer is not */* at <= 10 rps and burst <= 20 "
                     f"(methodPath={ms.get('methodPath')!r} rate={rate!r} burst={burst!r})")

    perm = top_d["lambda-permission"]["spec"]["forProvider"]
    if perm.get("sourceArn") != f"arn:aws:execute-api:{REGION}:{ACCOUNT}:a1b2c3d4e5/v1/*" or perm.get("principal") != "apigateway.amazonaws.com":
        fails.append(f"render: invoke permission {perm} not scoped to this API and stage")

    lam_d = out["lambda"][0]
    fn = lam_d["function"]["spec"]["forProvider"]
    if fn.get("environment", {}).get("variables") != {"USERS_TABLE": f"{PREFIX}{APP}-users", "POSTS_TABLE": f"{PREFIX}{APP}-posts"}:
        fails.append(f"render: function environment {fn.get('environment')}")
    if fn.get("s3Bucket") != f"{PREFIX}{APP}-code" or fn.get("s3Key") != "function.zip" or fn.get("role") != ROLE:
        fails.append(f"render: function code/role {fn.get('s3Bucket')}/{fn.get('s3Key')} {fn.get('role')}")

    spa_d, spa_x = out["frontend"]
    try:
        bp = json.loads(spa_d["web-bucket-policy"]["spec"]["forProvider"]["policy"])
        allow = [s for s in bp["Statement"] if s["Effect"] == "Allow"]
        deny = [s for s in bp["Statement"] if s["Effect"] == "Deny"]
        if (len(allow) != 1 or allow[0]["Principal"] != {"Service": "cloudfront.amazonaws.com"}
                or allow[0]["Condition"] != {"StringEquals": {"AWS:SourceArn": f"arn:aws:cloudfront::{ACCOUNT}:distribution/E1DIST000"}}
                or allow[0]["Action"] != "s3:GetObject"):
            fails.append(f"render: bucket policy allow {allow} is not GetObject for this distribution only")
        if not deny or deny[0]["Condition"] != {"Bool": {"aws:SecureTransport": "false"}}:
            fails.append("render: bucket policy without DenyInsecureTransport")
    except (KeyError, ValueError) as e:
        fails.append(f"render: bucket policy not rendered or not JSON: {e}")
    origin = ((spa_d.get("distribution", {}).get("spec", {}).get("forProvider", {}).get("origin") or [{}])[0])
    if origin.get("originAccessControlId") != OAC:
        fails.append(f"render: distribution origin OAC {origin.get('originAccessControlId')!r} is not the shared OAC of the XR")
    if f"https://a1b2c3d4e5.execute-api.{REGION}.amazonaws.com/v1/health" not in (spa_d.get("index", {}).get("spec", {}).get("forProvider", {}).get("content") or ""):
        fails.append("render: index.html does not call this API /health")
    if top_x["status"].get("api", {}).get("healthUrl") != f"https://a1b2c3d4e5.execute-api.{REGION}.amazonaws.com/v1/health":
        fails.append(f"render: status.api.healthUrl {top_x['status'].get('api')}")
    if top_x["status"].get("frontend", {}).get("url") != "https://d111111abcdef8.cloudfront.net":
        fails.append(f"render: status.frontend.url {top_x['status'].get('frontend')}")

    # Every nested XR the parent renders is accepted by its own XRD (patterns, enums, required).
    for rn, obj in top_d.items():
        if obj["apiVersion"].startswith(GROUP):
            for e in jsonschema.Draft7Validator(xrd_spec_schema(ctx, obj["kind"])).iter_errors(obj["spec"]):
                fails.append(f"render: rendered {obj['kind']} {rn} refused by its XRD at {list(e.path)}: {e.message[:120]}")

    # Every AWS object: prefix, name limits, platform tag (CloudFront CreateDistribution requires it).
    limits = {"Bucket": 63, "Role": 64, "Function": 64, "Table": 255, "Group": 512}
    for part, (d, _) in out.items():
        for rn, obj in d.items():
            if obj["apiVersion"].startswith(GROUP):
                continue
            ext = (obj.get("metadata", {}).get("annotations") or {}).get("crossplane.io/external-name")
            # An inline policy name lives inside its (prefixed) role, not in the account namespace.
            if ext and PREFIX not in ext and obj["kind"] != "RolePolicy":
                fails.append(f"render: {part}/{rn} external-name {ext} outside the prefix")
            if ext and obj["kind"] in limits and len(ext) > limits[obj["kind"]]:
                fails.append(f"render: {part}/{rn} name {ext} longer than {limits[obj['kind']]}")
            fp = obj["spec"].get("forProvider", {})
            if "tags" in fp and fp["tags"].get("platform") != "sample-plat":
                fails.append(f"render: {part}/{rn} without tag platform=sample-plat")
            key = f"{obj['apiVersion']}/{obj['kind']}"
            if "spec.forProvider.region" in (ctx["schemas"]["kinds"].get(key) or {}).get("fields", {}) and fp.get("region") != REGION:
                fails.append(f"render: {part}/{rn} region {fp.get('region')!r} != the XR region {REGION}")


# ----------------------------------------------------------------------------- static contract
def check_contract(ctx, fails):
    # Layout: flat, five XRDs, five Compositions, PT is the only function.
    if ctx["recipe_dirs"]:
        fails.append(f"layout: recipes/ has subdirectories {ctx['recipe_dirs']}; the Application does not recurse")
    for f in ("serverless-xrds.yaml", "serverless-compositions.yaml"):
        if f not in ctx["recipe_files"]:
            fails.append(f"layout: recipes/{f} missing")
    xk = {x["spec"]["names"]["kind"]: x for x in ctx["xrds"]}
    if set(xk) != KINDS:
        fails.append(f"xrd: kinds {sorted(xk)} != {sorted(KINDS)}")
    comp_by = {c["metadata"]["name"]: c for c in ctx["compositions"]}
    for k, x in xk.items():
        if x["apiVersion"] != "apiextensions.crossplane.io/v2" or x["spec"].get("scope") != "Namespaced" or x["spec"]["group"] != GROUP:
            fails.append(f"xrd {k}: must be apiextensions v2, Namespaced, group {GROUP}")
        ref = (x["spec"].get("defaultCompositionRef") or {}).get("name")
        if ref not in comp_by or comp_by[ref]["spec"]["compositeTypeRef"]["kind"] != k:
            fails.append(f"xrd {k}: defaultCompositionRef {ref!r} is not a Composition of {k}")
    fn_names = {d["metadata"]["name"] for d in ctx["packages"] if d["kind"] == "Function"}
    for c in ctx["compositions"]:
        for step in c["spec"]["pipeline"]:
            if step["functionRef"]["name"] != FUNCTION or FUNCTION not in fn_names:
                fails.append(f"composition {c['metadata']['name']}: function {step['functionRef']['name']} is not the pinned {FUNCTION}")
    if re.search(r"kro\.run|services\.k8s\.aws|ack-[a-z]+-controller", ctx["component_text"]):
        fails.append("scope: kro or ACK reference inside the Crossplane component")
    lits = sorted(set(REGION_LITERAL.findall(ctx["recipe_text"])))
    if lits:
        fails.append(f"region: literal Region {lits} in the serverless XRDs/Compositions (literals={len(lits)})")

    # Every managed resource: shared ProviderConfig, fixed region, region never from the XR, prefix names,
    # team fields only where a team field may go, Required on every status input.
    kinds = ctx["schemas"]["kinds"]
    for c in ctx["compositions"]:
        owner = c["spec"]["compositeTypeRef"]["kind"]
        for step, r in resources(c):
            api = r["base"]["apiVersion"]
            where = f"{c['metadata']['name']}/{r['name']}"
            pats = list(all_patches(step, r))
            for p in pats:
                srcs = ([p.get("fromFieldPath")] if p["type"] == "FromCompositeFieldPath"
                        else [v["fromFieldPath"] for v in p["combine"]["variables"]] if p["type"] == "CombineFromComposite" else [])
                for s in srcs:
                    if owner == "XServerlessMultiTier" and s.startswith("spec.") and s not in TEAM_FIELDS | PLATFORM_FIELDS:
                        fails.append(f"contract {where}: reads {s}, which is not a team field nor the platform contract")
                    if s.startswith("status.") and (p.get("policy") or {}).get("fromFieldPath") != "Required":
                        fails.append(f"contract {where}: input {s} from status without policy Required")
                if p.get("toFieldPath", "").endswith("region") and srcs != ["spec.region"]:
                    fails.append(f"contract {where}: {p['toFieldPath']} patched from {srcs}, not from spec.region")
                if p.get("toFieldPath", "").endswith("permissionsBoundary"):
                    fails.append(f"contract {where}: permissionsBoundary patched (no IAM in the recipe)")
            if api.startswith("iam."):
                fails.append(f"contract {where}: IAM {r['base']['kind']} composed; identity comes from the identity IaC")
            if r["base"]["kind"] == "OriginAccessControl":
                fails.append(f"contract {where}: CloudFront OAC composed; the OAC is fixed by the identity IaC")
            if api.startswith(GROUP):
                if owner == "XServerlessMultiTier" and not any(p.get("toFieldPath") == "spec.region" for p in pats):
                    fails.append(f"contract {where}: nested XR without spec.region from the parent")
                continue
            fields = (kinds.get(f"{api}/{r['base']['kind']}") or {}).get("fields", {})
            if r["base"].get("spec", {}).get("providerConfigRef") != {"kind": "ClusterProviderConfig", "name": "platform-pod-identity"}:
                fails.append(f"contract {where}: providerConfigRef is not ClusterProviderConfig/platform-pod-identity")
            fp = r["base"]["spec"].get("forProvider") or {}
            if "region" in fp:
                fails.append(f"contract {where}: region literal {fp.get('region')!r} in the base (the region comes from spec.region)")
            if "spec.forProvider.region" in fields and not any(p.get("toFieldPath") == "spec.forProvider.region" for p in pats):
                fails.append(f"contract {where}: no spec.forProvider.region patch from spec.region")
            if "spec.forProvider.tags" in fields and (fp.get("tags") or {}).get("platform") != "sample-plat":
                fails.append(f"contract {where}: base without tag platform=sample-plat")
    lit = {(c["spec"]["compositeTypeRef"]["kind"], r["name"]): r["base"]["spec"].get("forProvider", {})
           for c in ctx["compositions"] for _, r in resources(c) if "spec" in r["base"]}
    obj = lambda v: v if isinstance(v, dict) else {}       # a mutated shape is a failure, never a crash
    first = lambda v: v[0] if isinstance(v, list) and v and isinstance(v[0], dict) else {}
    for xr, b in (("XLambdaFunction", "code-bucket"), ("XSpa", "web-bucket")):
        pab = lit.get((xr, f"{b}-public-access-block"), {})
        if not all(pab.get(k) is True for k in ("blockPublicAcls", "blockPublicPolicy", "ignorePublicAcls", "restrictPublicBuckets")):
            fails.append(f"security {xr}/{b}: public access block not fully on")
        if obj(first(lit.get((xr, f"{b}-encryption"), {}).get("rule")).get("applyServerSideEncryptionByDefault")).get("sseAlgorithm") != "AES256":
            fails.append(f"security {xr}/{b}: SSE-S3 missing")
        if obj(lit.get((xr, f"{b}-ownership"), {}).get("rule")).get("objectOwnership") != "BucketOwnerEnforced":
            fails.append(f"security {xr}/{b}: ACLs not disabled (BucketOwnerEnforced)")
    t = lit.get(("XDynamoDBTable", "table"), {})
    if t.get("billingMode") != "PAY_PER_REQUEST" or t.get("pointInTimeRecovery") != {"enabled": True} or t.get("serverSideEncryption") != {"enabled": True}:
        fails.append("security XDynamoDBTable: on-demand, PITR and SSE must be literals")
    d = lit.get(("XSpa", "distribution"), {})
    if obj(d.get("defaultCacheBehavior")).get("viewerProtocolPolicy") != "redirect-to-https":
        fails.append("security XSpa: viewer protocol is not redirect-to-https")
    if obj(lit.get(("XApiRest", "restapi"), {}).get("endpointConfiguration")).get("types") != ["REGIONAL"]:
        fails.append("security XApiRest: endpoint is not REGIONAL")


def check_packages(ctx, fails):
    prov = {d["metadata"]["name"]: d for d in ctx["packages"] if d["kind"] == "Provider"}
    drc = {d["metadata"]["name"]: d for d in ctx["packages"] if d["kind"] == "DeploymentRuntimeConfig"}
    images = {}
    for line in ctx["images"].splitlines():
        if "|" in line and not line.lstrip().startswith("#"):
            src, dst = line.split("|", 1)
            images[src.strip()] = dst.strip()
    for name in [f"provider-aws-{k}" for k in SERVERLESS_PROVIDERS] + ["provider-aws-s3", "provider-aws-dynamodb"]:
        p = prov.get(name)
        if not p:
            fails.append(f"packages: {name} missing")
            continue
        m = re.fullmatch(r"harbor\.local/(crossplane-contrib/[a-z0-9-]+):(v[0-9.]+)@(sha256:[0-9a-f]{64})", p["spec"]["package"])
        if not m:
            fails.append(f"packages: {name} not pulled from harbor.local by digest: {p['spec']['package']}")
            continue
        repo, tag, dig = m.groups()
        src = f"xpkg.crossplane.io/{repo}:{tag}@{dig}"
        if images.get(src) != f"{repo}:{tag}":
            fails.append(f"packages: {name} has no mirror line {src}|{repo}:{tag} in registry/images.txt")
        if ctx["schemas"]["packages"].get(name) != src:
            fails.append(f"packages: {name} {src} != provider-schemas.json {ctx['schemas']['packages'].get(name)} (regenerate the fixture)")
        if p["spec"].get("skipDependencyResolution") is not True:
            fails.append(f"packages: {name} would resolve dependencies from the upstream registry")
        rc = (p["spec"].get("runtimeConfigRef") or {}).get("name")
        sa = get(drc.get(rc, {}), "spec.serviceAccountTemplate.metadata.name")
        if sa != name:
            fails.append(f"packages: {name} ServiceAccount {sa!r} is not fixed to {name}")
    if "provider-aws-iam" in prov or "provider-aws-iam" in drc or any("provider-aws-iam:" in s for s in images):
        fails.append("packages: provider-aws-iam present (the recipe composes no identity)")
    # The fixed ServiceAccounts are the targets of Pod Identity in BOTH flavors.
    par = {k: v.get("Default") for k, v in ctx["cfn"]["Parameters"].items()}
    cfn_sas = {par.get(r["Properties"]["ServiceAccount"]["Ref"]) for r in ctx["cfn"]["Resources"].values()
               if r["Type"] == "AWS::EKS::PodIdentityAssociation"}
    tf_sas = set(re.findall(r'=\s*"(provider-aws-[a-z0-9]+)"', ctx["tf"]))
    want = {f"provider-aws-{k}" for k in SERVERLESS_PROVIDERS} | {"provider-aws-s3", "provider-aws-dynamodb"}
    for side, got in (("CFN", cfn_sas), ("TF", tf_sas)):
        if got != want:
            fails.append(f"identity: {side} associations target {sorted(got)} != provider ServiceAccounts {sorted(want)}")


# ----------------------------------------------------------------------------- handler
class _FakeDDB:
    def __init__(self, fail=False):
        self.calls, self.items, self.fail = [], {}, fail

    def get_item(self, **kw):
        self.calls.append(("get_item", kw["TableName"]))
        if self.fail:
            raise RuntimeError("AccessDeniedException")
        return {}

    def scan(self, **kw):
        self.calls.append(("scan", kw["TableName"], kw.get("Limit")))
        return {"Items": list(self.items.values())}

    def put_item(self, **kw):
        self.calls.append(("put_item", kw["TableName"]))
        self.items[kw["Item"]["pk"]["S"]] = kw["Item"]


def _handler(src, fake):
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda name: fake
    saved = sys.modules.get("boto3")
    sys.modules["boto3"] = boto3
    try:
        mod = types.ModuleType("main")
        exec(compile(src, "main.py", "exec"), mod.__dict__)
    finally:
        if saved is None:
            sys.modules.pop("boto3", None)
        else:
            sys.modules["boto3"] = saved
    return mod


def check_handler(ctx, fails):
    text = ctx["compositions_text"] if "compositions_text" in ctx else (RECIPES / "serverless-compositions.yaml").read_text()
    b = ctx["build"]
    try:
        got = b.embedded(text)
    except SystemExit as e:
        fails.append(f"handler: {e}")
        return
    z = io.BytesIO()
    with zipfile.ZipFile(z, "w", compression=zipfile.ZIP_STORED) as zf:
        info = zipfile.ZipInfo("main.py", date_time=(1980, 1, 1, 0, 0, 0))
        info.external_attr, info.create_system = 0o644 << 16, 3
        zf.writestr(info, ctx["handler_src"].encode())
    want_b64 = base64.b64encode(z.getvalue()).decode()
    if got["contentBase64"] != want_b64:
        fails.append("handler: the zip embedded in the Composition is not the zip of serverless-handler/main.py")
    if got["sourceCodeHash"] != base64.b64encode(hashlib.sha256(z.getvalue()).digest()).decode():
        fails.append("handler: sourceCodeHash is not base64(SHA-256) of the embedded zip")
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(got["contentBase64"]))) as zf:
        if zf.namelist() != ["main.py"]:
            fails.append(f"handler: zip holds {zf.namelist()}, expected only main.py")
    import os
    os.environ["USERS_TABLE"], os.environ["POSTS_TABLE"] = "t-users", "t-posts"
    fake = _FakeDDB()
    h = _handler(ctx["handler_src"], fake).handler
    r = h({"httpMethod": "GET", "resource": "/health"}, None)
    if r["statusCode"] != 200 or [c[1] for c in fake.calls] != ["t-users", "t-posts"]:
        fails.append(f"handler: GET /health {r['statusCode']} calls {fake.calls}")
    r = h({"httpMethod": "POST", "resource": "/items", "body": json.dumps({"id": "a-1", "text": "hi"})}, None)
    if r["statusCode"] != 201 or fake.calls[-1] != ("put_item", "t-posts"):
        fails.append(f"handler: POST /items {r['statusCode']} {fake.calls[-1:]}")
    for bad in ({"id": "../x", "text": "y"}, {"id": "a", "text": "y" * 281}, {"id": 1, "text": "y"}):
        r = h({"httpMethod": "POST", "resource": "/items", "body": json.dumps(bad)}, None)
        if r["statusCode"] != 400:
            fails.append(f"handler: POST /items {bad} answered {r['statusCode']}, expected 400")
    r = h({"httpMethod": "GET", "resource": "/items"}, None)
    if r["statusCode"] != 200 or json.loads(r["body"])["items"] != [{"id": "a-1", "text": "hi"}] or fake.calls[-1] != ("scan", "t-posts", 20):
        fails.append(f"handler: GET /items {r}")
    if h({"httpMethod": "DELETE", "resource": "/items"}, None)["statusCode"] != 404:
        fails.append("handler: unknown route is not 404")
    r = _handler(ctx["handler_src"], _FakeDDB(fail=True)).handler({"httpMethod": "GET", "resource": "/health"}, None)
    if r["statusCode"] != 503 or json.loads(r["body"]).get("error") != "RuntimeError":
        fails.append(f"handler: /health with a failing table answered {r}")


def run_all(ctx):
    fails = []
    check_contract(ctx, fails)
    check_schema(ctx, ctx["compositions"], "serverless", fails)
    check_packages(ctx, fails)
    check_render(ctx, fails)
    check_handler(ctx, fails)
    return fails


# ----------------------------------------------------------------------------- controls
def _res(ctx, comp, name):
    c = next(c for c in ctx["compositions"] if c["metadata"]["name"] == comp)
    return next(r for _, r in resources(c) if r["name"] == name)


def _patch(ctx, comp, name, to):
    return next(p for p in _res(ctx, comp, name)["patches"] if p.get("toFieldPath") == to)


def m_cluster_scoped_array_shape(ctx):  # the cluster-scoped API shape; the namespaced CRD uses an object
    _res(ctx, "xapirest", "restapi")["base"]["spec"]["forProvider"]["endpointConfiguration"] = [{"types": ["REGIONAL"]}]


def m_unknown_target(ctx):
    _patch(ctx, "xlambdafunction", "function", "spec.forProvider.s3Key")["toFieldPath"] = "spec.forProvider.s3ObjectKey"


def m_iam_role_back(ctx):  # the removed design: the provider creates the function role
    c = next(c for c in ctx["compositions"] if c["metadata"]["name"] == "xserverlessmultitier")
    c["spec"]["pipeline"][0]["input"]["resources"].append({"name": "lambda-role", "base": {
        "apiVersion": "iam.aws.m.upbound.io/v1beta1", "kind": "Role",
        "spec": {"providerConfigRef": {"kind": "ClusterProviderConfig", "name": "platform-pod-identity"}, "forProvider": {}}}})


def m_oac_back(ctx):
    c = next(c for c in ctx["compositions"] if c["metadata"]["name"] == "xspa")
    c["spec"]["pipeline"][0]["input"]["resources"].append({"name": "oac", "base": {
        "apiVersion": "cloudfront.aws.m.upbound.io/v1beta1", "kind": "OriginAccessControl",
        "spec": {"providerConfigRef": {"kind": "ClusterProviderConfig", "name": "platform-pod-identity"}, "forProvider": {}}}})


def m_region_literal(ctx):
    _res(ctx, "xdynamodbtable", "table")["base"]["spec"]["forProvider"]["region"] = "us-west-2"
    ctx["recipe_text"] += "\n                  region: us-west-2\n"


def m_region_patch_missing(ctx):
    r = _res(ctx, "xapirest", "stage")
    r["patches"] = [p for p in r["patches"] if p.get("patchSetName") != "region"]


def m_role_from_team(ctx):
    x = next(x for x in ctx["xrds"] if x["spec"]["names"]["kind"] == "XServerlessMultiTier")
    x["spec"]["versions"][0]["schema"]["openAPIV3Schema"]["properties"]["spec"]["properties"]["extraRole"] = {"type": "string"}
    _patch(ctx, "xserverlessmultitier", "lambda", "spec.roleArn")["fromFieldPath"] = "spec.extraRole"


def m_role_pattern_open(ctx):
    x = next(x for x in ctx["xrds"] if x["spec"]["names"]["kind"] == "XServerlessMultiTier")
    x["spec"]["versions"][0]["schema"]["openAPIV3Schema"]["properties"]["spec"]["properties"]["roleArn"].pop("pattern")


def m_iam_provider_back(ctx):
    ctx["packages"].append({"apiVersion": "pkg.crossplane.io/v1", "kind": "Provider", "metadata": {"name": "provider-aws-iam"},
                            "spec": {"package": "harbor.local/crossplane-contrib/provider-aws-iam:v2.9.0"}})


def m_openapi_credentials(ctx):
    p = _patch(ctx, "xserverlessmultitier", "api", "spec.openApiSpecification")
    p["combine"]["string"]["fmt"] = p["combine"]["string"]["fmt"].replace(
        '"uri": "%[1]s"}', '"uri": "%[1]s", "credentials": "arn:aws:iam::*:role/admin"}', 1)


def m_permission_any_api(ctx):
    _patch(ctx, "xserverlessmultitier", "lambda-permission", "spec.forProvider.sourceArn")["transforms"][0]["string"]["fmt"] = f"arn:aws:execute-api:{REGION}:*:*"


def m_region_from_xr(ctx):
    _res(ctx, "xdynamodbtable", "table")["patches"].append(
        {"type": "FromCompositeFieldPath", "fromFieldPath": "spec.app", "toFieldPath": "spec.forProvider.region"})


def m_public_bucket(ctx):
    _res(ctx, "xspa", "web-bucket-public-access-block")["base"]["spec"]["forProvider"]["blockPublicPolicy"] = False


def m_untagged(ctx):
    _res(ctx, "xspa", "distribution")["base"]["spec"]["forProvider"]["tags"].pop("platform")


def m_code_drift(ctx):
    ctx["handler_src"] += "\n# drift\n"


def m_kro(ctx):
    ctx["component_text"] += "\napiVersion: kro.run/v1alpha1\n"


def m_digest_drift(ctx):
    p = next(d for d in ctx["packages"] if d["kind"] == "Provider" and d["metadata"]["name"] == "provider-aws-lambda")
    p["spec"]["package"] = p["spec"]["package"][:-4] + "0000"


def m_upstream_pull(ctx):
    p = next(d for d in ctx["packages"] if d["kind"] == "Provider" and d["metadata"]["name"] == "provider-aws-apigateway")
    p["spec"]["package"] = p["spec"]["package"].replace("harbor.local/", "xpkg.crossplane.io/")


def m_sa_unbound(ctx):
    d = next(d for d in ctx["packages"] if d["kind"] == "DeploymentRuntimeConfig" and d["metadata"]["name"] == "provider-aws-cloudfront")
    d["spec"]["serviceAccountTemplate"]["metadata"]["name"] = "provider-aws-cdn"


def m_iac_missing_association(ctx):
    ctx["cfn"]["Resources"].pop("LogsAssociation")


def m_nested_pattern(ctx):  # the parent derives a name its child refuses
    _patch(ctx, "xserverlessmultitier", "lambda", "spec.functionName")["transforms"][0]["string"]["fmt"] = "%s-api"


def m_open_name(ctx):
    x = next(x for x in ctx["xrds"] if x["spec"]["names"]["kind"] == "XServerlessMultiTier")
    x["spec"]["versions"][0]["schema"]["openAPIV3Schema"]["properties"]["spec"]["properties"]["name"].pop("pattern")


def m_nested_dir(ctx):
    ctx["recipe_dirs"] = ["serverless"]


def m_throttle_open(ctx):  # the only abuse control of the API without authorizer
    _res(ctx, "xapirest", "method-settings")["base"]["spec"]["forProvider"]["settings"]["throttlingRateLimit"] = 10000


CONTROLS = [
    (m_cluster_scoped_array_shape, "schema serverless xapirest/restapi: base field spec.forProvider.endpointConfiguration[].types not in the RestAPI schema"),
    (m_unknown_target, "schema serverless xlambdafunction/function: target spec.forProvider.s3ObjectKey not in the Function schema"),
    (m_iam_role_back, "contract xserverlessmultitier/lambda-role: IAM Role composed"),
    (m_oac_back, "contract xspa/oac: CloudFront OAC composed"),
    (m_region_literal, "contract xdynamodbtable/table: region literal 'us-west-2' in the base"),
    (m_region_patch_missing, "contract xapirest/stage: no spec.forProvider.region patch from spec.region"),
    (m_role_from_team, "contract xserverlessmultitier/lambda: reads spec.extraRole, which is not a team field nor the platform contract"),
    (m_role_pattern_open, "xrd XServerlessMultiTier: accepts roleArn of another role"),
    (m_iam_provider_back, "packages: provider-aws-iam present"),
    (m_openapi_credentials, "render: GET /health integration"),
    (m_permission_any_api, "render: invoke permission"),
    (m_region_from_xr, "contract xdynamodbtable/table: spec.forProvider.region patched from ['spec.app'], not from spec.region"),
    (m_public_bucket, "security XSpa/web-bucket: public access block not fully on"),
    (m_untagged, "contract xspa/distribution: base without tag platform=sample-plat"),
    (m_code_drift, "handler: the zip embedded in the Composition is not the zip of serverless-handler/main.py"),
    (m_kro, "scope: kro or ACK reference inside the Crossplane component"),
    (m_digest_drift, "packages: provider-aws-lambda has no mirror line"),
    (m_upstream_pull, "packages: provider-aws-apigateway not pulled from harbor.local by digest"),
    (m_sa_unbound, "packages: provider-aws-cloudfront ServiceAccount 'provider-aws-cdn' is not fixed to provider-aws-cloudfront"),
    (m_iac_missing_association, "identity: CFN associations target"),
    (m_nested_dir, "layout: recipes/ has subdirectories"),
    (m_nested_pattern, "render: rendered XLambdaFunction lambda refused by its XRD at ['functionName']"),
    (m_open_name, "xrd XServerlessMultiTier: accepts uppercase name"),
    (m_throttle_open, "render: stage throttling of the API without authorizer"),
]


def main():
    base = load_ctx()
    rc = 0
    fails = run_all(base)
    for f in fails:
        print(f"FAIL {f}")
    # Positive control of the schema validator: the PlatformBucket and PlatformTable Compositions.
    recipes_positive = []
    check_schema(base, base["recipe_compositions"], "recipes_positive", recipes_positive)
    for f in recipes_positive:
        print(f"FAIL positive control (PlatformBucket and PlatformTable Compositions): {f}")
    n_mr = sum(1 for c in base["compositions"] for _, r in resources(c) if not r["base"]["apiVersion"].startswith(GROUP))
    n_patch = sum(1 for c in base["compositions"] for s, r in resources(c) for _ in all_patches(s, r))
    if fails or recipes_positive:
        rc = 1
    else:
        print(f"PASS contract: {len(KINDS)} XRDs, {len(base['compositions'])} Compositions, {n_mr} managed resources "
              f"and {n_patch} patches valid against {len(base['schemas']['kinds'])} pinned CRD schemas; "
              f"PlatformBucket and PlatformTable Compositions as positive control; render, packages, identity and handler green; "
              f"provider_iam=absent region=parameterized literals=0")
    ok = 0
    for mut, expect in CONTROLS:
        ctx = copy.deepcopy({k: v for k, v in base.items() if k != "build"})
        ctx["build"] = base["build"]
        mut(ctx)
        try:
            got = run_all(ctx)
        except Exception as e:  # a crash is not a detection: the control fails
            got = [f"crash {type(e).__name__}: {e}"]
        if any(expect in g for g in got):
            ok += 1
            print(f"PASS control {mut.__name__[2:]}: {next(g for g in got if expect in g)[:140]}")
        else:
            rc = 1
            print(f"FAIL control {mut.__name__[2:]}: expected a failure containing {expect!r}, got {got[:3]}")
    print(f"RESULT test-serverless contract={'ok' if not (fails or recipes_positive) else 'FAIL'} controls={ok}/{len(CONTROLS)}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
