"""environments-promotion: cadeia de ambientes no registry, pedido de promoção e spec publicável."""
from __future__ import annotations

import json
from typing import Any

import pytest

from test_cluster_api_inventory import api as cluster_api  # noqa: F401
from test_dev_platform_integration import Ddb, api, call, env  # noqa: F401
from test_platform_events import FakeDynamo, events
from test_project_scope import TWO_PROJECTS, platform_scope


def _doc(**patch: Any) -> dict[str, Any]:
    document = json.loads(json.dumps(TWO_PROJECTS))
    document["environments"] = [
        {"id": "lab", "name": "Lab", "cluster": "c", "region": "sa-east-1", "promotesTo": "staging"},
        {"id": "staging", "name": "Staging", "cluster": "c", "region": "sa-east-1"},
    ]
    document["projects"][1].update({"environment": "staging"})
    document["projects"][0].update({"promotesTo": "team-b"})
    for key, value in patch.items():
        if key == "env":
            for index, fields in value.items():
                document["environments"][index].update(fields)
        else:
            for index, fields in value.items():
                document["projects"][index].update(fields)
    return document


# ---------------------------------------------------------------- registry

def test_registry_exposes_the_promotion_chain_and_the_target_project():
    registry = platform_scope.parse_registry(_doc())
    assert registry.environments["lab"]["promotesTo"] == "staging" and registry.environments["staging"]["promotesTo"] is None
    assert registry.project("team-a").promotes_to == "team-b" and registry.project("team-b").promotes_to is None
    context = platform_scope.context(registry, "alice", True)
    assert [e["id"] for e in context["environments"]] == ["lab", "staging"]
    by_id = {p["id"]: p for p in context["projects"]}
    assert by_id["team-a"]["promotesTo"] == "team-b" and by_id["team-b"]["promotesTo"] is None


def test_real_registry_promotes_agent_platform_to_staging_on_the_same_cluster():
    registry = platform_scope.load_registry()
    assert registry.project("agent-platform").promotes_to == "agent-platform-staging"
    staging = registry.project("agent-platform-staging")
    assert staging.environment == "staging" and staging.namespaces == ("appmod-staging",)
    assert staging.gitops_path == "platform/instances" and staging.promotes_to is None
    assert registry.environments["lab"]["promotesTo"] == "staging"


@pytest.mark.parametrize("patch,fragment", [
    ({"env": {0: {"promotesTo": "prod"}}}, "unknown environment"),
    ({"env": {0: {"promotesTo": "lab"}}}, "unknown environment"),
    ({"env": {1: {"promotesTo": "lab"}}}, "cycle"),
    ({"projects": {0: {"promotesTo": "nobody"}}}, "unknown project"),
    ({"projects": {0: {"promotesTo": "team-a"}}}, "unknown project"),
    ({"projects": {0: {"promotesTo": "frozen"}}}, "must live in environment"),
    ({"projects": {1: {"gitopsPath": "platform/agents"}}}, "same gitopsPath"),
])
def test_broken_promotion_chain_rejects_the_whole_registry(patch, fragment):
    with pytest.raises(platform_scope.ScopeUnavailable) as failure:
        platform_scope.parse_registry(_doc(**patch))
    assert fragment in str(failure.value)


def test_registry_without_promotesto_is_still_valid_and_terminal():
    registry = platform_scope.parse_registry(TWO_PROJECTS)
    assert all(env["promotesTo"] is None for env in registry.environments.values())
    assert all(p.promotes_to is None for p in registry.projects)


# ---------------------------------------------------------------- pedido de promoção (platform-api)

MANIFEST = """apiVersion: kro.run/v1alpha1
kind: StaticSite
metadata:
  name: hello-site-staging
  namespace: appmod-staging
  labels:
    platform.appmod/owner: platform-team
    platform.appmod/environment: staging
    platform.appmod/promoted-from: hello-site
spec:
  name: hello-site-staging
"""


def _promote(api_module, promoted_from: str, project: str = "agent-platform-staging", namespace: str = "appmod-staging"):
    body = {"kind": "infra", "name": "hello-site-staging", "capability": "frontend/static-site",
            "manifest": MANIFEST, "namespace": namespace, "promotedFrom": promoted_from}
    return call(api_module, "POST", "/prod/platform/provision-requests", body=body,
                query={"project": project, "ns": namespace})


def test_promotion_request_lands_in_the_target_project_and_records_promotion_requested(api):
    fake = FakeDynamo()
    api._events = events.EventStore(fake, "events")
    status, body = _promote(api, "agent-platform/appmod/hello-site")
    assert status in (200, 201), body
    assert body["path"] == "platform/instances/hello-site-staging.yaml"
    (item,) = api._dynamodb.by_kind("infra")
    assert Ddb._s(item, "promotedFrom") == "agent-platform/appmod/hello-site"
    assert Ddb._s(item, "project") == "agent-platform-staging" and Ddb._s(item, "namespace") == "appmod-staging"
    recorded = [item for (pk, _sk), item in fake.items.items() if pk == "event"]
    assert [row["action"]["S"] for row in recorded] == ["promotion.requested"]
    assert recorded[0]["detail"]["S"] == "from agent-platform/appmod/hello-site to agent-platform-staging/appmod-staging/hello-site-staging"
    assert recorded[0]["project"]["S"] == "agent-platform-staging"


@pytest.mark.parametrize("promoted_from,status,code", [
    ("agent-builder/kagent/x", 403, "promotion_target_mismatch"),   # agent-builder não promove para ninguém
    ("agent-platform/kagent/x", 403, "promotion_source_unknown"),   # namespace não é do projeto de origem
    ("nobody/appmod/x", 403, "promotion_source_unknown"),
    ("Agent/Platform/x", 400, None),                                # formato
])
def test_promotion_source_is_validated_against_the_registry_before_any_write(api, promoted_from, status, code):
    api._events = events.EventStore(FakeDynamo(), "events")
    got, body = _promote(api, promoted_from)
    assert got == status, body
    if code:
        assert body["code"] == code
    assert api._dynamodb.by_kind("infra") == []


def test_promotion_into_a_project_that_is_not_the_chain_target_is_refused(api):
    # agent-platform promove para agent-platform-staging; pedir no próprio agent-platform é alvo errado.
    api._events = events.EventStore(FakeDynamo(), "events")
    status, body = _promote(api, "agent-platform/appmod/hello-site", project="agent-platform", namespace="appmod")
    assert status == 403 and body["code"] == "promotion_target_mismatch"
    assert api._dynamodb.by_kind("infra") == []


def test_plain_request_without_promotedfrom_keeps_recording_provision_requested(api):
    fake = FakeDynamo()
    api._events = events.EventStore(fake, "events")
    body = {"kind": "infra", "name": "hello-site-staging", "capability": "frontend/static-site", "manifest": MANIFEST, "namespace": "appmod-staging"}
    status, _ = call(api, "POST", "/prod/platform/provision-requests", body=body, query={"project": "agent-platform-staging", "ns": "appmod-staging"})
    assert status in (200, 201)
    assert [item["action"]["S"] for (pk, _sk), item in fake.items.items() if pk == "event"] == ["provision.requested"]


# ---------------------------------------------------------------- spec publicável (cluster-api)

def test_safe_spec_keeps_declarative_inputs_and_drops_anything_that_looks_like_a_credential(cluster_api):
    spec = {
        "name": "hello", "replicas": 2, "public": True, "ratio": 0.5,
        "tags": [{"key": "env", "value": "lab"}, {"key": "password", "value": "x"}],
        "database": {"engine": "postgres", "password": "hunter2", "masterUserSecret": {"arn": "arn:aws:secretsmanager:x"}},
        "token": "AKIAIOSFODNN7EXAMPLE",
        "nested": {"a": {"b": {"c": {"d": {"e": {"f": {"g": "too deep"}}}}}}},
    }
    safe = cluster_api._safe_spec(spec)
    assert safe["name"] == "hello" and safe["replicas"] == 2 and safe["public"] is True and safe["ratio"] == 0.5
    assert safe["tags"] == [{"key": "env", "value": "lab"}, {"key": "password", "value": "x"}]
    assert "password" not in safe["database"] and "masterUserSecret" not in safe["database"]
    assert safe["database"] == {"engine": "postgres"}
    assert "token" not in safe
    assert json.dumps(safe).count("too deep") == 0
    assert cluster_api._safe_spec("AKIAIOSFODNN7EXAMPLE") is None and cluster_api._safe_spec(None) is None
