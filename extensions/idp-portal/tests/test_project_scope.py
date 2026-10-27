"""Escopo de projeto: Organization > Project > Environment > Namespace (issue #10, ADR-0009).

Fixam os critérios de aceite da issue nas três pontas que decidem:

- o núcleo `backend/platform_scope` (registry, papel, lifecycle, fail closed);
- a cluster-api (toda leitura e operação com namespace passa pelo escopo ANTES do API server);
- a platform-api (contexto do caller e pedido de provisionamento com escopo) e o job de CI que
  confere o namespace do manifest contra o gravado pelo servidor.

O fixture de dois projetos (team-a com alice, team-b com bob) existe só aqui: o registry real
tem um tenant, e é ele que `test_real_registry_*` valida. Nenhum tenant é inventado no deploy.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any

import pytest
from conftest import internal_artifact

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))

import platform_scope  # noqa: E402

ORIGIN = "https://portal.example.com"

TWO_PROJECTS = {
    "version": 1,
    "organization": {"id": "appmod-latam", "name": "AppMod LATAM",
                     "owner": {"team": "platform-team", "contact": "platform-admin"}},
    "environments": [{"id": "lab", "name": "Lab", "cluster": "appmod-agent-platform-lab", "region": "sa-east-1"}],
    "projects": [
        {"id": "team-a", "name": "Team A", "environment": "lab", "appProject": "team-a",
         "namespaces": ["ns-a"], "gitopsPath": "platform/instances", "argoApplications": ["team-a"],
         "owner": {"team": "team-a", "contact": "alice"},
         "members": [{"principal": "alice", "role": "contributor"}, {"principal": "carol", "role": "viewer"}],
         "quota": {"maxInstances": None, "enforced": False}, "lifecycle": {"state": "active"}},
        {"id": "team-b", "name": "Team B", "environment": "lab", "appProject": "team-b",
         "namespaces": ["ns-b"], "gitopsPath": "platform/instances", "argoApplications": [],
         "owner": {"team": "team-b", "contact": "bob"},
         "members": [{"principal": "bob", "role": "contributor"}, {"principal": "carol", "role": "viewer"}],
         "quota": {"maxInstances": None, "enforced": False}, "lifecycle": {"state": "active"}},
        {"id": "frozen", "name": "Frozen", "environment": "lab", "appProject": "frozen",
         "namespaces": ["ns-frozen"], "gitopsPath": "platform/instances",
         "owner": {"team": "team-a", "contact": "alice"},
         "members": [{"principal": "alice", "role": "contributor"}],
         "quota": {}, "lifecycle": {"state": "read-only"}},
        {"id": "gone", "name": "Gone", "environment": "lab", "appProject": "gone",
         "namespaces": ["ns-gone"], "gitopsPath": "platform/instances",
         "owner": {"team": "team-a", "contact": "alice"},
         "members": [{"principal": "alice", "role": "contributor"}],
         "quota": {}, "lifecycle": {"state": "retired"}},
    ],
}


@pytest.fixture()
def registry_file(tmp_path, monkeypatch):
    path = tmp_path / "registry.json"
    path.write_text(json.dumps(TWO_PROJECTS))
    monkeypatch.setenv("SCOPE_REGISTRY_PATH", str(path))
    monkeypatch.delenv("SCOPE_ENFORCEMENT", raising=False)
    return path


@pytest.fixture()
def registry(registry_file):
    return platform_scope.load_registry(registry_file)


def _with(**changes: Any) -> dict[str, Any]:
    document = json.loads(json.dumps(TWO_PROJECTS))
    for index, patch in changes.get("projects", {}).items():
        document["projects"][index].update(patch)
    return document


# ============================================================================ núcleo
def test_real_registry_parses_and_maps_the_existing_gitops_flow():
    registry = platform_scope.load_registry(ROOT / "platform/scope/registry.json")
    projects = {p.id: p for p in registry.projects}
    # Os dois workspaces que JÁ existem: AppProject + namespace + diretório GitOps.
    assert projects["agent-platform"].namespaces == ("appmod",)
    assert projects["agent-platform"].gitops_path == "platform/instances"
    assert projects["agent-builder"].app_project == "agent-builder"
    assert projects["agent-builder"].namespaces == ("kagent",)
    # Um tenant: nenhum projeto concede admin ao curinga e todo membro é o time inteiro.
    assert all(principal == "*" and role != "admin" for p in registry.projects for principal, role in p.members)


def test_real_registry_matches_the_argo_appproject_of_the_agent_builder():
    appproject = internal_artifact("platform/gitops/appproject-agent-builder.yaml").read_text()
    assert "name: agent-builder" in appproject and "namespace: kagent" in appproject


@pytest.mark.parametrize("patch, fragment", [
    ({0: {"namespaces": ["ns-b"]}}, "more than one project"),
    ({0: {"members": [{"principal": "*", "role": "admin"}]}}, "grants admin to '*'"),
    ({0: {"gitopsPath": "platform/../etc"}}, "not a mirrored GitOps directory"),
    ({0: {"environment": "prod"}}, "unknown environment"),
    ({0: {"lifecycle": {"state": "paused"}}}, "lifecycle.state"),
    ({0: {"quota": {"maxInstances": 0}}}, "quota.maxInstances"),
    ({1: {"id": "team-a"}}, "duplicate ids"),
    ({0: {"members": []}}, "members"),
    ({0: {"namespaces": ["NS_A"]}}, "DNS label"),
])
def test_invalid_registry_fails_closed_never_partially(patch, fragment):
    with pytest.raises(platform_scope.ScopeUnavailable) as caught:
        platform_scope.parse_registry(_with(projects=patch))
    assert fragment in caught.value.message
    assert caught.value.status == 503


def test_missing_or_broken_registry_is_503(tmp_path):
    with pytest.raises(platform_scope.ScopeUnavailable):
        platform_scope.load_registry(tmp_path / "absent.json")
    broken = tmp_path / "broken.json"
    broken.write_text("{not json")
    with pytest.raises(platform_scope.ScopeUnavailable):
        platform_scope.load_registry(broken)


def test_positive_control_own_namespace(registry):
    scope = platform_scope.resolve(registry, "alice", False, "team-a", "ns-a", "propose")
    assert (scope.project, scope.namespace, scope.role) == ("team-a", "ns-a", "contributor")
    assert scope.allows("ns-a") and not scope.allows("ns-b")


def test_negative_control_namespace_of_another_project(registry):
    with pytest.raises(platform_scope.ScopeError) as caught:
        platform_scope.resolve(registry, "alice", False, "team-a", "ns-b", "read")
    assert (caught.value.status, caught.value.code) == (403, "namespace_out_of_scope")


def test_foreign_project_answers_exactly_like_a_missing_one(registry):
    errors = []
    for project in ("team-b", "does-not-exist", "gone"):
        with pytest.raises(platform_scope.ScopeError) as caught:
            platform_scope.resolve(registry, "alice", False, project, "", "read")
        errors.append((caught.value.status, caught.value.code, caught.value.message))
    assert len(set(errors)) == 1 and errors[0][0] == 404


def test_viewer_reads_but_cannot_propose(registry):
    assert platform_scope.resolve(registry, "carol", False, "team-b", "", "read").namespace == "_all"
    with pytest.raises(platform_scope.ScopeError) as caught:
        platform_scope.resolve(registry, "carol", False, "team-b", "ns-b", "propose")
    assert (caught.value.status, caught.value.code) == (403, "role_insufficient")


def test_read_only_project_reads_but_never_writes(registry):
    assert platform_scope.resolve(registry, "alice", False, "frozen", "ns-frozen", "read").scoped
    with pytest.raises(platform_scope.ScopeError) as caught:
        platform_scope.resolve(registry, "alice", False, "frozen", "ns-frozen", "propose")
    assert caught.value.code == "project_read_only"


def test_operate_needs_admin_role_even_inside_the_own_project(registry):
    with pytest.raises(platform_scope.ScopeError):
        platform_scope.resolve(registry, "alice", False, "team-a", "ns-a", "operate")
    assert platform_scope.resolve(registry, "platform-admin", True, "team-a", "ns-a", "operate").role == "admin"


def test_compat_unscoped_only_for_callers_who_already_see_every_project(registry, monkeypatch):
    monkeypatch.setenv("SCOPE_ENFORCEMENT", "compat")
    assert not platform_scope.resolve(registry, "platform-admin", True, None, "_all", "read").scoped
    # carol vê team-a e team-b, mas não frozen: acesso parcial exige escopo explícito.
    for alias in ("alice", "bob", "carol"):
        with pytest.raises(platform_scope.ScopeError) as caught:
            platform_scope.resolve(registry, alias, False, None, "_all", "read")
        assert (caught.value.status, caught.value.code) == (400, "scope_required")


@pytest.mark.parametrize("value", ["strict", "STRICT", "off", "", "permissive"])
def test_strict_and_unknown_modes_require_the_project(registry, monkeypatch, value):
    monkeypatch.setenv("SCOPE_ENFORCEMENT", value)
    if value == "":
        monkeypatch.delenv("SCOPE_ENFORCEMENT")
        assert platform_scope.enforcement() == "compat"
        return
    assert platform_scope.enforcement() == "strict"
    with pytest.raises(platform_scope.ScopeError) as caught:
        platform_scope.resolve(registry, "platform-admin", True, None, "_all", "read")
    assert caught.value.code == "scope_required"


def test_multi_namespace_project_never_widens_all_to_the_cluster():
    document = _with(projects={0: {"namespaces": ["ns-a", "ns-a2"]}})
    registry = platform_scope.parse_registry(document)
    scope = platform_scope.resolve(registry, "alice", False, "team-a", "_all", "read")
    assert scope.namespaces == ("ns-a", "ns-a2")
    with pytest.raises(platform_scope.ScopeError) as caught:
        scope.single()
    assert caught.value.code == "namespace_required"


def test_context_lists_only_visible_projects_and_never_other_members(registry):
    ctx = platform_scope.context(registry, "alice", False, "compat")
    assert [p["id"] for p in ctx["projects"]] == ["team-a", "frozen"]
    assert ctx["projects"][0]["role"] == "contributor"
    assert "members" not in json.dumps(ctx) and "bob" not in json.dumps(ctx)
    assert ctx["kubeconfig"] == {"offered": False, "reason": "adr-0009"}
    assert platform_scope.context(registry, "mallory", False)["projects"] == []


# ============================================================================ cluster-api
class _Fake:
    def __init__(self, routes: dict[str, Any]) -> None:
        self.routes, self.calls = routes, []

    def __call__(self, method: str, path: str, body: Any = None, **_: Any) -> Any:
        self.calls.append((method, path))
        for prefix, value in sorted(self.routes.items(), key=lambda pair: -len(pair[0])):
            if path.startswith(prefix):
                return value
        return {"items": []}


def _pod(name: str, namespace: str) -> dict[str, Any]:
    return {"metadata": {"name": name, "namespace": namespace, "creationTimestamp": "2026-10-01T00:00:00Z"},
            "spec": {"containers": [{"name": "c"}], "nodeName": "n1"},
            "status": {"phase": "Running", "containerStatuses": [{"ready": True, "restartCount": 0}]}}


@pytest.fixture()
def cluster(monkeypatch, registry_file):
    monkeypatch.setenv("AUTHORIZED_ALIASES", "platform-admin,alice,bob,carol")
    monkeypatch.setenv("PLATFORM_ADMINS", "platform-admin")
    monkeypatch.setenv("ALLOWED_ORIGINS", ORIGIN)
    monkeypatch.setenv("CLUSTER_ENDPOINT", "https://example.invalid")
    monkeypatch.setenv("CLUSTER_CA_B64", "LS0tLS1CRUdJTi0tLS0t")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "sa-east-1")
    spec = importlib.util.spec_from_file_location("qa_scope_cluster_api", ROOT / "backend/cluster_api/lambda_function.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._k8s = _Fake({
        "/api/v1/namespaces/ns-a/pods": {"items": [_pod("a-1", "ns-a")]},
        "/api/v1/namespaces/ns-b/pods": {"items": [_pod("b-1", "ns-b")]},
        "/api/v1/pods": {"items": [_pod("a-1", "ns-a"), _pod("b-1", "ns-b"), _pod("dns", "kube-system")]},
        "/api/v1/namespaces": {"items": [{"metadata": {"name": n}} for n in ("ns-a", "ns-b", "kube-system")]},
        "/api/v1/nodes": {"items": []},
        "/version": {"gitVersion": "v1.33"},
    })
    return module


def _event(path: str, alias: str, params: dict[str, str] | None = None, method: str = "GET",
           body: Any = None) -> dict[str, Any]:
    return {"path": f"/prod{path}", "httpMethod": method, "queryStringParameters": params,
            "body": json.dumps(body) if body is not None else None, "headers": {"origin": ORIGIN},
            "requestContext": {"identity": {"userArn": f"arn:aws:sts::111122223333:assumed-role/PortalInvokeRole/{alias}"}}}


def _call(module, *args, **kwargs) -> tuple[int, dict[str, Any]]:
    response = module.handler(_event(*args, **kwargs), None)
    return response["statusCode"], json.loads(response["body"])


def test_scope_reaches_the_api_server_url_not_a_browser_filter(cluster):
    status, body = _call(cluster, "/cluster/pods", "alice", {"project": "team-a"})
    assert status == 200
    assert [p["name"] for p in body["pods"]] == ["a-1"]
    assert ("GET", "/api/v1/namespaces/ns-a/pods") in cluster._k8s.calls
    assert body["scope"] == {"project": "team-a", "namespace": "ns-a", "namespaces": ["ns-a"],
                             "role": "contributor", "environment": "lab"}


def test_project_a_resource_never_appears_under_project_b(cluster):
    _, as_a = _call(cluster, "/cluster/pods", "carol", {"project": "team-a"})
    _, as_b = _call(cluster, "/cluster/pods", "carol", {"project": "team-b"})
    assert {p["name"] for p in as_a["pods"]} == {"a-1"}
    assert {p["name"] for p in as_b["pods"]} == {"b-1"}


@pytest.mark.parametrize("params, status, code", [
    ({"project": "team-a", "ns": "ns-b"}, 403, "namespace_out_of_scope"),
    ({"project": "team-a", "ns": "kube-system"}, 403, "namespace_out_of_scope"),
    ({"project": "team-b"}, 404, "project_not_found"),
    ({"project": "nope"}, 404, "project_not_found"),
    ({"project": "../x"}, 400, "invalid_project"),
    ({"ns": "ns-b"}, 400, "scope_required"),
    (None, 400, "scope_required"),
])
def test_denials_happen_before_any_kubernetes_read(cluster, params, status, code):
    got, body = _call(cluster, "/cluster/pods", "alice", params)
    assert (got, body.get("code")) == (status, code)
    assert cluster._k8s.calls == []


def test_overview_and_platform_are_filtered_to_the_project(cluster):
    status, body = _call(cluster, "/cluster/overview", "alice", {"project": "team-a"})
    assert status == 200
    assert body["namespaces"] == ["ns-a"] and body["pods"]["total"] == 1
    cluster._k8s.routes.update({
        "/apis/kro.run/v1alpha1/resourcegraphdefinitions": {"items": []},
        "/apis/kro.run/v1alpha1": {"resources": [{"name": "staticsites", "verbs": ["list"]}]},
        "/apis/kro.run/v1alpha1/staticsites": {"items": [
            {"metadata": {"name": "site-a", "namespace": "ns-a"}, "kind": "StaticSite", "status": {}},
            {"metadata": {"name": "site-b", "namespace": "ns-b"}, "kind": "StaticSite", "status": {}}]},
    })
    _, view = _call(cluster, "/cluster/platform", "bob", {"project": "team-b"})
    assert [row["name"] for row in view["instances"]] == ["site-b"]


def test_admin_keeps_the_legacy_unscoped_view_in_compat(cluster):
    status, body = _call(cluster, "/cluster/pods", "platform-admin", {"ns": "_all"})
    assert status == 200 and len(body["pods"]) == 3 and "scope" not in body


def test_nodes_stay_outside_the_project_scope(cluster):
    assert _call(cluster, "/cluster/nodes", "alice")[0] == 200


def test_day2_write_is_confined_to_the_project_namespace(cluster):
    status, body = _call(cluster, "/cluster/delete-pod", "platform-admin", {"project": "team-a"}, "POST",
                         {"ns": "ns-b", "name": "b-1"})
    assert (status, body["code"]) == (403, "namespace_out_of_scope")
    assert not any(method == "DELETE" for method, _ in cluster._k8s.calls)
    status, _ = _call(cluster, "/cluster/delete-pod", "platform-admin", {"project": "team-a"}, "POST",
                      {"ns": "ns-a", "name": "a-1"})
    assert status == 200
    assert ("DELETE", "/api/v1/namespaces/ns-a/pods/a-1") in cluster._k8s.calls


def test_missing_registry_fails_closed_on_scoped_routes(cluster, monkeypatch, tmp_path):
    monkeypatch.setenv("SCOPE_REGISTRY_PATH", str(tmp_path / "absent.json"))
    status, body = _call(cluster, "/cluster/pods", "platform-admin", {"ns": "_all"})
    assert (status, body["code"]) == (503, "scope_registry_unavailable")
    assert cluster._k8s.calls == []


# ============================================================================ platform-api
class _Table:
    def __init__(self) -> None:
        self.items: dict[str, dict] = {}

    def put_item(self, TableName, Item, ConditionExpression):
        self.items[Item["requestId"]["S"]] = Item

    def get_item(self, TableName, Key, ConsistentRead):
        found = self.items.get(Key["requestId"]["S"])
        return {"Item": found} if found else {}


MANIFEST_A = "apiVersion: kro.run/v1alpha1\nkind: StaticSite\nmetadata:\n  name: site\n  namespace: ns-a\n"


@pytest.fixture()
def platform(monkeypatch, registry_file):
    monkeypatch.setenv("AUTHORIZED_ALIASES", "platform-admin,alice,bob,carol")
    monkeypatch.setenv("PLATFORM_ADMINS", "platform-admin")
    monkeypatch.setenv("ALLOWED_ORIGINS", ORIGIN)
    monkeypatch.setenv("PROVISION_TABLE", "provision-test")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "sa-east-1")
    spec = importlib.util.spec_from_file_location("qa_scope_platform_api", ROOT / "backend/platform_api/lambda_function.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["qa_scope_platform_api"] = module
    spec.loader.exec_module(module)
    module._dynamodb = _Table()
    return module


def _propose(module, alias: str, project: str | None, namespace: str | None, manifest: str = MANIFEST_A):
    body = {"kind": "infra", "name": "site", "capability": "web/static-site", "manifest": manifest}
    if namespace is not None:
        body["namespace"] = namespace
    return _call(module, "/platform/provision-requests", alias, {"project": project} if project else None, "POST", body)


def test_scope_context_route(platform):
    status, body = _call(platform, "/platform/scope", "bob")
    assert status == 200
    assert [(p["id"], p["role"]) for p in body["projects"]] == [("team-b", "contributor")]
    assert body["enforcement"] == "compat"


def test_scope_context_is_503_without_registry(platform, monkeypatch, tmp_path):
    monkeypatch.setenv("SCOPE_REGISTRY_PATH", str(tmp_path / "absent.json"))
    assert _call(platform, "/platform/scope", "bob")[0] == 503


def test_positive_create_in_own_namespace_records_the_server_scope(platform):
    status, body = _propose(platform, "alice", "team-a", "ns-a")
    assert status == 201
    stored = platform._dynamodb.items[body["requestId"]]
    assert (stored["project"]["S"], stored["namespace"]["S"]) == ("team-a", "ns-a")
    assert stored["path"]["S"] == "platform/instances/site.yaml"
    assert body["scope"]["project"] == "team-a"
    status, found = _call(platform, f"/platform/provision-requests/{body['requestId']}", "alice")
    assert status == 200 and (found["project"], found["namespace"]) == ("team-a", "ns-a")


@pytest.mark.parametrize("alias, project, namespace, status, code", [
    ("alice", "team-a", "ns-b", 403, "namespace_out_of_scope"),
    ("alice", "team-b", "ns-b", 404, "project_not_found"),
    ("carol", "team-a", "ns-a", 403, "role_insufficient"),
    ("alice", "frozen", "ns-frozen", 403, "project_read_only"),
    ("alice", None, "ns-a", 400, "scope_required"),
])
def test_negative_create_stores_nothing(platform, alias, project, namespace, status, code):
    got, body = _propose(platform, alias, project, namespace)
    assert (got, body.get("code")) == (status, code)
    assert platform._dynamodb.items == {}


def test_agent_and_tour_requests_need_a_scope_that_contains_their_namespace(platform):
    got, body = _call(platform, "/platform/provision-requests", "alice", {"project": "team-a"}, "POST", {"tour": True})
    assert (got, body["code"]) == (403, "namespace_out_of_scope")
    assert platform._dynamodb.items == {}


# ============================================================================ CI e bundle
def test_ci_refuses_a_manifest_outside_the_recorded_namespace():
    internal_artifact("scripts/open_provision_mrs.py")
    import open_provision_mrs as ci

    def item(manifest: str, namespace: str = "") -> dict[str, Any]:
        row = {"kind": {"S": "infra"}, "name": {"S": "site"}, "path": {"S": "platform/instances/site.yaml"},
               "manifest": {"S": manifest}}
        if namespace:
            row.update({"namespace": {"S": namespace}, "project": {"S": "team-a"}})
        return row

    assert ci.validate(item(MANIFEST_A, "ns-a")) == ""
    assert "outside the project scope" in ci.validate(item(MANIFEST_A.replace("ns-a", "ns-b"), "ns-a"))
    assert "outside the project scope" in ci.validate(item(MANIFEST_A.replace("  namespace: ns-a\n", ""), "ns-a"))
    # Pedido anterior à issue, sem namespace gravado: comportamento inalterado.
    assert ci.validate(item(MANIFEST_A.replace("ns-a", "anything"))) == ""


@pytest.mark.parametrize("script, bundle", [
    ("backend/cluster_api/build.sh", "backend/cluster_api/.build/cluster-api.zip"),
    ("backend/platform_api/build.sh", "backend/platform_api/.build/platform-api.zip"),
])
def test_both_bundles_ship_the_scope_module_and_registry(script, bundle):
    subprocess.run(["bash", str(ROOT / script)], check=True, capture_output=True, timeout=60)
    names = zipfile.ZipFile(ROOT / bundle).namelist()
    assert "platform_scope/__init__.py" in names
    assert "platform_scope/registry.json" in names
    registry = json.loads(zipfile.ZipFile(ROOT / bundle).read("platform_scope/registry.json"))
    assert registry == json.loads((ROOT / "platform/scope/registry.json").read_text())


# ============================================================================ compatibilidade real
def test_real_registry_keeps_the_current_flow_for_every_team_session(monkeypatch):
    """Com o registry real (um tenant, membros '*'), pedido sem `project` segue exatamente como antes."""
    monkeypatch.delenv("SCOPE_REGISTRY_PATH", raising=False)
    monkeypatch.delenv("SCOPE_ENFORCEMENT", raising=False)
    registry = platform_scope.load_registry()
    for alias in ("teammate", "jnagase"):
        assert not platform_scope.resolve(registry, alias, False, None, "_all", "read").scoped
        assert not platform_scope.resolve(registry, alias, False, None, "appmod", "propose").scoped
    # Day-2 continua só de admin, com ou sem escopo.
    with pytest.raises(platform_scope.ScopeError):
        platform_scope.resolve(registry, "teammate", False, None, "appmod", "operate")
    scope = platform_scope.resolve(registry, "teammate", False, "agent-platform", "", "propose")
    assert scope.single() == "appmod"


# ============================================================================ ownership-model
def _teams_doc() -> dict[str, Any]:
    document = json.loads(json.dumps(TWO_PROJECTS))
    document["organization"]["owner"]["team"] = "team-a"
    document["teams"] = [
        {"id": "team-a", "name": "Team A", "description": "owns a", "contacts": ["alice"],
         "slack": {"channel": "#team-a", "url": "https://slack.example.com/archives/PLATFORM"}, "oncall": ""},
        {"id": "team-b", "name": "Team B", "contacts": ["bob", "carol"], "slack": {}, "oncall": "https://oncall.example/team-b"},
    ]
    return document


def test_teams_are_first_class_and_exposed_in_the_context():
    registry = platform_scope.parse_registry(_teams_doc())
    assert [t.id for t in registry.teams] == ["team-a", "team-b"]
    assert registry.team("team-a").contacts == ("alice",)
    ctx = platform_scope.context(registry, "alice", False, "compat")
    assert ctx["teams"] == [
        {"id": "team-a", "name": "Team A", "description": "owns a", "contacts": ["alice"],
         "slack": {"channel": "#team-a", "url": "https://slack.example.com/archives/PLATFORM"}, "oncall": ""},
        {"id": "team-b", "name": "Team B", "description": "", "contacts": ["bob", "carol"],
         "slack": {"channel": "", "url": ""}, "oncall": "https://oncall.example/team-b"},
    ]
    # Registry sem `teams` continua válido: owner é texto e o contexto expõe lista vazia.
    assert platform_scope.context(platform_scope.parse_registry(TWO_PROJECTS), "alice", False, "compat")["teams"] == []


@pytest.mark.parametrize("patch", [
    lambda d: d["projects"][1]["owner"].__setitem__("team", "ghost"),
    lambda d: d["teams"].append({"id": "team-a", "name": "dup", "contacts": ["x"]}),
    lambda d: d["teams"][0].__setitem__("contacts", []),
    lambda d: d["teams"][0].__setitem__("slack", {"url": "http://insecure"}),
    lambda d: d["teams"][0].__setitem__("contacts", ["Not An Alias"]),
])
def test_invalid_teams_fail_closed(patch):
    document = _teams_doc()
    patch(document)
    with pytest.raises(platform_scope.ScopeUnavailable):
        platform_scope.parse_registry(document)


def test_real_registry_declares_the_owning_team():
    registry = platform_scope.load_registry(ROOT / "platform/scope/registry.json")
    team = registry.team("platform-team")
    assert team is not None and "platform-admin" in team.contacts and team.slack["url"].startswith("https://")
    assert all(registry.team(p.owner["team"]) is not None for p in registry.projects)
