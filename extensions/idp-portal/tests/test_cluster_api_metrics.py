"""Métricas de CPU/memória da cluster-api (backlog cluster-metrics), sem tocar AWS nem K8s.

Fixam o contrato de GET /cluster/pod-metrics e GET /cluster/node-metrics:

- a versão de metrics.k8s.io sai da discovery (v1 é stable desde o 1.37; o lab 1.36 serve v1beta1);
- cada falha vira um estado NOMEADO e `pods`/`nodes` null, nunca lista vazia;
- quantity e duration do Kubernetes são lidas como a doc define, e valor ilegível é null, não 0;
- labels do pod (que a PodMetrics carrega) não saem;
- o escopo de projeto chega à URL do API server antes da leitura, como em /cluster/pods;
- a saída bate com tests/fixtures/cluster-metrics/contract.json (fonte única, dono: integrador).
"""
from __future__ import annotations

import datetime
import importlib.util
import io
import json
import sys
import urllib.error
from pathlib import Path
from typing import Any

import pytest
from conftest import internal_artifact

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT / "tests/fixtures/cluster-metrics/contract.json").read_text())
ORIGIN = "https://portal.example.com"
GROUP = {"kind": "APIGroup", "name": "metrics.k8s.io",
         "versions": [{"groupVersion": "metrics.k8s.io/v1beta1", "version": "v1beta1"}],
         "preferredVersion": {"groupVersion": "metrics.k8s.io/v1beta1", "version": "v1beta1"}}
REGISTRY = {
    "version": 1,
    "organization": {"id": "appmod-latam", "name": "AppMod LATAM",
                     "owner": {"team": "platform-team", "contact": "platform-admin"}},
    "environments": [{"id": "lab", "name": "Lab", "cluster": "appmod-agent-platform-lab", "region": "sa-east-1"}],
    "projects": [
        {"id": "team-a", "name": "Team A", "environment": "lab", "appProject": "team-a",
         "namespaces": ["ns-a"], "gitopsPath": "platform/instances", "argoApplications": [],
         "owner": {"team": "team-a", "contact": "alice"},
         "members": [{"principal": "alice", "role": "viewer"}],
         "quota": {}, "lifecycle": {"state": "active"}},
        {"id": "team-b", "name": "Team B", "environment": "lab", "appProject": "team-b",
         "namespaces": ["ns-b"], "gitopsPath": "platform/instances", "argoApplications": [],
         "owner": {"team": "team-b", "contact": "bob"},
         "members": [{"principal": "bob", "role": "viewer"}],
         "quota": {}, "lifecycle": {"state": "active"}},
    ],
}


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://example.invalid", code, "x", {}, io.BytesIO(b"{}"))


class Fake:
    """API server falso: rota exata -> payload, ou exceção para levantar."""

    def __init__(self, routes: dict[str, Any]) -> None:
        self.routes, self.calls = routes, []

    def __call__(self, method: str, path: str, *_: Any, **__: Any) -> Any:
        self.calls.append((method, path))
        if path not in self.routes:
            raise AssertionError(f"unexpected kubernetes call {method} {path}")
        value = self.routes[path]
        if isinstance(value, BaseException):
            raise value
        return value


def stamp(seconds_ago: int) -> str:
    moment = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=seconds_ago)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def pod_metrics(name: str, namespace: str, containers: list[tuple[str, str, str]], seconds_ago: int = 20,
                **extra: Any) -> dict[str, Any]:
    return {"metadata": {"name": name, "namespace": namespace, "creationTimestamp": stamp(1),
                         "labels": {"app": name, "platform.appmod/api-token": "glpat-abcdefghijklmnop12345"}},
            "timestamp": stamp(seconds_ago), "window": "30s",
            "containers": [{"name": c, "usage": {"cpu": cpu, "memory": mem}} for c, cpu, mem in containers],
            **extra}


@pytest.fixture()
def api(monkeypatch, tmp_path):
    registry = tmp_path / "registry.json"
    registry.write_text(json.dumps(REGISTRY))
    monkeypatch.setenv("SCOPE_REGISTRY_PATH", str(registry))
    monkeypatch.delenv("SCOPE_ENFORCEMENT", raising=False)
    monkeypatch.setenv("AUTHORIZED_ALIASES", "platform-admin,alice,bob")
    monkeypatch.setenv("PLATFORM_ADMINS", "platform-admin")
    monkeypatch.setenv("ALLOWED_ORIGINS", ORIGIN)
    monkeypatch.setenv("CLUSTER_ENDPOINT", "https://example.invalid")
    monkeypatch.setenv("CLUSTER_CA_B64", "LS0tLS1CRUdJTi0tLS0t")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "sa-east-1")
    spec = importlib.util.spec_from_file_location("qa_metrics_cluster_api", ROOT / "backend/cluster_api/lambda_function.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["qa_metrics_cluster_api"] = module
    spec.loader.exec_module(module)
    module._k8s = Fake({})
    return module


def call(api, path: str, alias: str = "platform-admin", params: dict[str, str] | None = None) -> tuple[int, dict[str, Any]]:
    event = {"path": f"/prod{path}", "httpMethod": "GET", "queryStringParameters": params, "body": None,
             "headers": {"origin": ORIGIN},
             "requestContext": {"identity": {"userArn": f"arn:aws:sts::111122223333:assumed-role/PortalInvokeRole/{alias}"}}}
    response = api.handler(event, None)
    return response["statusCode"], json.loads(response["body"])


# ============================================================================ unidades da doc
@pytest.mark.parametrize("raw, millicores", [
    ("487558164n", 488), ("9559630n", 10), ("250m", 250), ("1", 1000), ("1.5", 1500),
    ("2500u", 3), ("1e3", 1_000_000), ("0", 0),
])
def test_cpu_quantity_becomes_millicores(api, raw, millicores):
    assert api._millicores(raw) == millicores


@pytest.mark.parametrize("raw, size", [
    ("732212Ki", 732212 * 1024), ("22244Ki", 22244 * 1024), ("1Gi", 2 ** 30), ("128974848", 128974848),
    ("129M", 129_000_000), ("1.5Mi", 1572864),
])
def test_memory_quantity_becomes_bytes(api, raw, size):
    assert api._bytes(raw) == size


@pytest.mark.parametrize("raw", [None, "", "-1", "abc", "1Kb", "1 Mi", "1..0", 5, "Mi"])
def test_unreadable_quantity_is_none_never_zero(api, raw):
    assert api._millicores(raw) is None and api._bytes(raw) is None


@pytest.mark.parametrize("raw, seconds", [("30s", 30.0), ("1m0s", 60.0), ("10.5s", 10.5), ("500ms", 0.5),
                                          ("1h2m3s", 3723.0)])
def test_window_is_a_go_duration(api, raw, seconds):
    assert api._window_seconds(raw) == seconds


@pytest.mark.parametrize("raw", [None, "", "30", "s", "30s junk", "-30s"])
def test_unreadable_window_is_none(api, raw):
    assert api._window_seconds(raw) is None


# ============================================================================ disponível
def test_pod_metrics_reads_the_served_version_and_sums_containers(api):
    api._k8s = Fake({
        "/apis/metrics.k8s.io": GROUP,
        "/apis/metrics.k8s.io/v1beta1/pods": {"items": [
            pod_metrics("web-1", "appmod", [("app", "250m", "64Mi"), ("sidecar", "5000000n", "16Mi")]),
            pod_metrics("old-1", "appmod", [("app", "1m", "1Mi")], seconds_ago=900),
        ]},
    })
    status, body = call(api, "/cluster/pod-metrics", params={"ns": "_all"})
    assert status == 200
    assert body["metrics"] == {"status": "available", "reason": "", "apiVersion": "metrics.k8s.io/v1beta1"}
    old, web = body["pods"]
    assert (web["name"], web["cpuMillicores"], web["memoryBytes"]) == ("web-1", 255, 80 * 2 ** 20)
    assert [c["name"] for c in web["containers"]] == ["app", "sidecar"]
    assert web["windowSeconds"] == 30.0 and web["stale"] is False
    assert old["stale"] is True
    assert body["truncated"] is False and body["dropped"] == 0


def test_v1_is_used_when_the_cluster_prefers_it(api):
    api._k8s = Fake({
        "/apis/metrics.k8s.io": {"versions": [{"version": "v1"}, {"version": "v1beta1"}],
                                 "preferredVersion": {"version": "v1"}},
        "/apis/metrics.k8s.io/v1/namespaces/appmod/pods": {"items": []},
    })
    status, body = call(api, "/cluster/pod-metrics", params={"ns": "appmod"})
    assert status == 200 and body["metrics"]["apiVersion"] == "metrics.k8s.io/v1" and body["pods"] == []


def test_unknown_preferred_version_falls_back_to_a_known_served_one(api):
    api._k8s = Fake({
        "/apis/metrics.k8s.io": {"versions": [{"version": "v2alpha1"}, {"version": "v1beta1"}],
                                 "preferredVersion": {"version": "v2alpha1"}},
        "/apis/metrics.k8s.io/v1beta1/pods": {"items": []},
    })
    assert call(api, "/cluster/pod-metrics", params={"ns": "_all"})[1]["metrics"]["apiVersion"] == "metrics.k8s.io/v1beta1"


def test_only_unknown_versions_is_an_error_not_a_guess(api):
    api._k8s = Fake({"/apis/metrics.k8s.io": {"versions": [{"version": "v2"}], "preferredVersion": {"version": "v2"}}})
    status, body = call(api, "/cluster/pod-metrics", params={"ns": "_all"})
    assert (status, body["metrics"]["status"], body["metrics"]["reason"]) == (502, "error", "unsupported_metrics_version")
    assert body["pods"] is None


def test_pod_total_is_null_when_one_container_is_unreadable(api):
    api._k8s = Fake({
        "/apis/metrics.k8s.io": GROUP,
        "/apis/metrics.k8s.io/v1beta1/pods": {"items": [pod_metrics("p", "appmod", [("a", "10m", "1Mi"), ("b", "bogus", "1Mi")])]},
    })
    [row] = call(api, "/cluster/pod-metrics", params={"ns": "_all"})[1]["pods"]
    assert row["cpuMillicores"] is None and row["memoryBytes"] == 2 * 2 ** 20
    assert row["containers"][1] == {"name": "b", "cpuMillicores": None, "memoryBytes": 2 ** 20}


def test_output_is_sanitized_labels_never_leave(api):
    api._k8s = Fake({
        "/apis/metrics.k8s.io": GROUP,
        "/apis/metrics.k8s.io/v1beta1/pods": {"items": [
            pod_metrics("web-1", "appmod", [("app", "1m", "1Mi"), ("../evil", "1m", "1Mi")], extra_field="x"),
            pod_metrics("../escape", "appmod", [("app", "1m", "1Mi")]),
            pod_metrics("ok", "Bad_NS", [("app", "1m", "1Mi")]),
        ]},
    })
    _, body = call(api, "/cluster/pod-metrics", params={"ns": "_all"})
    raw = json.dumps(body)
    assert "labels" not in raw and "glpat-" not in raw and "extra_field" not in raw and "evil" not in raw
    assert [row["name"] for row in body["pods"]] == ["web-1"] and body["dropped"] == 2
    assert set(body["pods"][0]) == set(CONTRACT["examples"]["pods_available"]["body"]["pods"][0])


def test_row_cap_is_reported_as_truncated(api, monkeypatch):
    monkeypatch.setattr(api, "METRICS_ROWS_MAX", 1)
    api._k8s = Fake({
        "/apis/metrics.k8s.io": GROUP,
        "/apis/metrics.k8s.io/v1beta1/pods": {"items": [pod_metrics("a", "x", [("c", "1m", "1Mi")]),
                                                         pod_metrics("b", "x", [("c", "1m", "1Mi")])]},
    })
    _, body = call(api, "/cluster/pod-metrics", params={"ns": "_all"})
    assert body["truncated"] is True and len(body["pods"]) == 1


# ============================================================================ estados de falha
@pytest.mark.parametrize("failure, http, state, reason", [
    (http_error(404), 200, "not_installed", "metrics_api_not_registered"),
    (http_error(503), 503, "unavailable", "metrics_api_service_unavailable"),
    (http_error(403), 502, "forbidden", "http_403"),
    (http_error(500), 502, "error", "http_500"),
    (urllib.error.URLError("down"), 502, "error", "unreachable"),
    (TimeoutError(), 502, "error", "unreachable"),
    (ValueError("bad json"), 502, "error", "unreadable"),
])
def test_discovery_failure_is_a_named_state_and_never_an_empty_list(api, failure, http, state, reason):
    api._k8s = Fake({"/apis/metrics.k8s.io": failure})
    for path, key in (("/cluster/pod-metrics", "pods"), ("/cluster/node-metrics", "nodes")):
        status, body = call(api, path, params={"ns": "_all"})
        assert (status, body["metrics"]["status"], body["metrics"]["reason"]) == (http, state, reason)
        assert body[key] is None
        assert ("error" in body) is (http != 200)


@pytest.mark.parametrize("failure, http, state, reason", [
    (http_error(503), 503, "unavailable", "metrics_api_service_unavailable"),
    # Discovery leu: o grupo existe. 404 na coleção é erro, nunca "não instalado".
    (http_error(404), 502, "error", "http_404"),
    (http_error(403), 502, "forbidden", "http_403"),
])
def test_collection_failure_after_discovery(api, failure, http, state, reason):
    api._k8s = Fake({"/apis/metrics.k8s.io": GROUP, "/apis/metrics.k8s.io/v1beta1/namespaces/appmod/pods": failure})
    status, body = call(api, "/cluster/pod-metrics", params={"ns": "appmod"})
    assert (status, body["metrics"]["status"], body["metrics"]["reason"]) == (http, state, reason)
    assert body["metrics"]["apiVersion"] == "metrics.k8s.io/v1beta1" and body["pods"] is None


@pytest.mark.parametrize("payload", [[], "x", {"items": "nope"}])
def test_malformed_collection_is_unreadable(api, payload):
    api._k8s = Fake({"/apis/metrics.k8s.io": GROUP, "/apis/metrics.k8s.io/v1beta1/pods": payload})
    status, body = call(api, "/cluster/pod-metrics", params={"ns": "_all"})
    assert (status, body["metrics"]["reason"], body["pods"]) == (502, "unreadable", None)


def test_signal_carries_state_and_counts_only(api, capsys):
    api._k8s = Fake({"/apis/metrics.k8s.io": GROUP,
                     "/apis/metrics.k8s.io/v1beta1/pods": {"items": [pod_metrics("secret-pod-name", "appmod", [("c", "1m", "1Mi")])]}})
    call(api, "/cluster/pod-metrics", params={"ns": "_all"})
    [line] = [json.loads(row) for row in capsys.readouterr().out.splitlines() if "cluster_api_metrics" in row]
    assert line == {"event": "cluster_api_metrics", "collection": "pods", "status": "available", "reason": "", "rows": 1}


# ============================================================================ nodes
NODE = "ip-10-0-1-2.sa-east-1.compute.internal"


def test_node_metrics_percent_of_allocatable_like_kubectl_top(api):
    api._k8s = Fake({
        "/apis/metrics.k8s.io": GROUP,
        "/apis/metrics.k8s.io/v1beta1/nodes": {"items": [
            {"metadata": {"name": NODE, "labels": {"x": "y"}}, "timestamp": stamp(10), "window": "20.05s",
             "usage": {"cpu": "487558164n", "memory": "732212Ki"}}]},
        "/api/v1/nodes": {"items": [{"metadata": {"name": NODE},
                                     "status": {"allocatable": {"cpu": "1930m", "memory": "3388304Ki"}}}]},
    })
    status, body = call(api, "/cluster/node-metrics")
    assert status == 200 and body["allocatableReadable"] is True
    [row] = body["nodes"]
    assert (row["cpuMillicores"], row["cpuPercent"]) == (488, 25)
    assert (row["memoryBytes"], row["memoryPercent"]) == (732212 * 1024, 22)
    assert row["windowSeconds"] == 20.05 and "labels" not in json.dumps(body)


def test_node_percent_is_null_when_allocatable_cannot_be_read(api):
    api._k8s = Fake({
        "/apis/metrics.k8s.io": GROUP,
        "/apis/metrics.k8s.io/v1beta1/nodes": {"items": [{"metadata": {"name": NODE}, "timestamp": stamp(5),
                                                           "window": "30s", "usage": {"cpu": "1", "memory": "1Gi"}}]},
        "/api/v1/nodes": http_error(403),
    })
    status, body = call(api, "/cluster/node-metrics")
    assert status == 200 and body["allocatableReadable"] is False
    assert body["nodes"][0]["cpuPercent"] is None and body["nodes"][0]["cpuMillicores"] == 1000


# ============================================================================ authz e escopo
def test_unauthorized_alias_is_refused_before_any_read(api):
    assert call(api, "/cluster/pod-metrics", alias="mallory")[0] == 403
    assert call(api, "/cluster/node-metrics", alias="mallory")[0] == 403
    assert api._k8s.calls == []


def test_project_scope_reaches_the_metrics_url(api):
    api._k8s = Fake({"/apis/metrics.k8s.io": GROUP,
                     "/apis/metrics.k8s.io/v1beta1/namespaces/ns-a/pods": {"items": [pod_metrics("a-1", "ns-a", [("c", "1m", "1Mi")])]}})
    status, body = call(api, "/cluster/pod-metrics", alias="alice", params={"project": "team-a"})
    assert status == 200 and [row["name"] for row in body["pods"]] == ["a-1"]
    assert ("GET", "/apis/metrics.k8s.io/v1beta1/namespaces/ns-a/pods") in api._k8s.calls
    assert body["scope"]["project"] == "team-a" and body["namespace"] == "ns-a"


@pytest.mark.parametrize("params, status, code", [
    ({"project": "team-a", "ns": "ns-b"}, 403, "namespace_out_of_scope"),
    ({"project": "team-b"}, 404, "project_not_found"),
    ({"ns": "ns-a"}, 400, "scope_required"),
    (None, 400, "scope_required"),
])
def test_scope_denials_happen_before_any_metrics_read(api, params, status, code):
    got, body = call(api, "/cluster/pod-metrics", alias="alice", params=params)
    assert (got, body.get("code")) == (status, code)
    assert api._k8s.calls == []


def test_admin_unscoped_read_still_validates_the_namespace(api):
    status, _ = call(api, "/cluster/pod-metrics", params={"ns": "../kube-system"})
    assert status == 400 and api._k8s.calls == []


def test_node_metrics_stay_outside_the_project_scope_like_nodes(api):
    api._k8s = Fake({"/apis/metrics.k8s.io": GROUP, "/apis/metrics.k8s.io/v1beta1/nodes": {"items": []},
                     "/api/v1/nodes": {"items": []}})
    status, body = call(api, "/cluster/node-metrics", alias="alice")
    assert status == 200 and body["nodes"] == [] and "scope" not in body


def test_rbac_grants_metrics_read_only():
    rbac = internal_artifact("platform/cluster-api/cluster-rbac.yaml").read_text()
    block = rbac[rbac.index("apiGroups: [metrics.k8s.io]"):].split("\n  - ", 1)[0]
    assert "resources: [pods, nodes]" in block and "verbs: [get, list]" in block
    assert rbac.count("metrics.k8s.io]") == 1


def test_timestamp_is_rewritten_canonical_and_missing_one_is_stale(api):
    api._k8s = Fake({
        "/apis/metrics.k8s.io": GROUP,
        "/apis/metrics.k8s.io/v1beta1/pods": {"items": [
            {**pod_metrics("a", "x", [("c", "1m", "1Mi")]), "timestamp": "2026-10-23T12:59:40.123456+00:00"},
            {**pod_metrics("b", "x", [("c", "1m", "1Mi")]), "timestamp": "<script>"},
        ]},
    })
    a, b = call(api, "/cluster/pod-metrics", params={"ns": "_all"})[1]["pods"]
    assert a["timestamp"] == "2026-10-23T12:59:40Z"
    assert b["timestamp"] is None and b["stale"] is True


@pytest.mark.parametrize("seconds_ago, stale", [(299, False), (301, True)])
def test_stale_boundary_is_300_seconds(api, seconds_ago, stale):
    api._k8s = Fake({"/apis/metrics.k8s.io": GROUP,
                     "/apis/metrics.k8s.io/v1beta1/pods": {"items": [pod_metrics("a", "x", [("c", "1m", "1Mi")], seconds_ago)]}})
    assert call(api, "/cluster/pod-metrics", params={"ns": "_all"})[1]["pods"][0]["stale"] is stale


def test_default_row_cap_is_2000(api):
    assert api.METRICS_ROWS_MAX == 2000 and api.METRICS_STALE_SECONDS == 300
    items = [pod_metrics(f"p-{i:04d}", "x", [("c", "1m", "1Mi")]) for i in range(2001)]
    api._k8s = Fake({"/apis/metrics.k8s.io": GROUP, "/apis/metrics.k8s.io/v1beta1/pods": {"items": items}})
    body = call(api, "/cluster/pod-metrics", params={"ns": "_all"})[1]
    assert body["truncated"] is True and len(body["pods"]) == 2000 and body["pods"][-1]["name"] == "p-1999"


@pytest.mark.parametrize("listing", [[], "x", {"items": "nope"}, {"items": ["x", {"metadata": None}]}])
def test_malformed_node_listing_never_crashes_the_percent(api, listing):
    api._k8s = Fake({"/apis/metrics.k8s.io": GROUP, "/apis/metrics.k8s.io/v1beta1/nodes": {"items": [
        {"metadata": {"name": NODE}, "timestamp": stamp(5), "window": "30s", "usage": {"cpu": "1", "memory": "1Gi"}}]},
        "/api/v1/nodes": listing})
    status, body = call(api, "/cluster/node-metrics")
    assert status == 200 and body["nodes"][0]["cpuPercent"] is None


def test_oversized_quantity_is_unreadable(api):
    assert api._bytes("1" * 65) is None and api._bytes("1" * 64) is not None


# ============================================================================ contrato (contract.json)
READ_AT = CONTRACT["examples"]["pods_available"]["body"]["readAt"]
POD = CONTRACT["examples"]["pods_available"]["body"]["pods"][0]
NODE_ROW = CONTRACT["examples"]["nodes_available"]["body"]["nodes"][0]
# Entradas do API server que, lidas no instante READ_AT, produzem exatamente cada exemplo do contrato.
SCENARIOS = {
    "pods_available": {"/apis/metrics.k8s.io": GROUP, "/apis/metrics.k8s.io/v1beta1/namespaces/team-a/pods": {"items": [
        {"metadata": {"name": POD["name"], "namespace": POD["namespace"], "labels": {"app": "x"},
                      "annotations": {"secret": "glpat-abcdefghijklmnop12345"}},
         "timestamp": POD["timestamp"], "window": "15s",
         "containers": [{"name": "web", "usage": {"cpu": "12000000n", "memory": "40Mi"}}]}]}},
    "pods_not_installed": {"/apis/metrics.k8s.io": http_error(404)},
    "pods_unavailable": {"/apis/metrics.k8s.io": http_error(503)},
    "nodes_available": {"/apis/metrics.k8s.io": GROUP, "/apis/metrics.k8s.io/v1beta1/nodes": {"items": [
        {"metadata": {"name": NODE_ROW["name"], "labels": {"x": "y"}}, "timestamp": NODE_ROW["timestamp"],
         "window": "20s", "usage": {"cpu": "420m", "memory": "2Gi"}}]},
        "/api/v1/nodes": {"items": [{"metadata": {"name": NODE_ROW["name"]},
                                     "status": {"allocatable": {"cpu": "1930m", "memory": "6606Mi"}}}]}},
    "nodes_forbidden": {"/apis/metrics.k8s.io": http_error(403)},
}


def test_every_contract_example_has_a_scenario():
    assert set(SCENARIOS) == set(CONTRACT["examples"])


def test_contract_states_match_the_http_codes_of_the_code(api):
    assert {state: spec["http"] for state, spec in CONTRACT["states"].items()} == api._METRICS_HTTP_STATUS
    for state, spec in CONTRACT["states"].items():
        assert spec["collection"] == ("array" if state == api.METRICS_AVAILABLE else "null")


@pytest.mark.parametrize("route", sorted(CONTRACT["routes"]))
def test_contract_routes_and_scoping(api, route):
    spec = CONTRACT["routes"][route]
    assert spec["method"] == "GET"
    api._k8s = Fake({"/apis/metrics.k8s.io": GROUP, "/apis/metrics.k8s.io/v1beta1/pods": {"items": []},
                     "/apis/metrics.k8s.io/v1beta1/nodes": {"items": []}, "/api/v1/nodes": {"items": []}})
    status, body = call(api, spec["path"], alias="alice")
    if spec["scoped"]:
        # Escopo de projeto: sem `project` o viewer é recusado antes de qualquer leitura.
        assert (status, body.get("code"), api._k8s.calls) == (400, "scope_required", [])
        assert set(spec["query"]) == {"ns", "project"}
    else:
        assert status == 200 and body[spec["collectionKey"]] == [] and "scope" not in body
        assert spec["query"] == []


@pytest.mark.parametrize("name", sorted(CONTRACT["examples"]))
def test_lambda_reproduces_every_contract_example(api, monkeypatch, name):
    example = CONTRACT["examples"][name]
    route = CONTRACT["routes"][name.split("_", 1)[0]]
    monkeypatch.setattr(api.time, "time", lambda: float(READ_AT))
    api._k8s = Fake(SCENARIOS[name])
    params = {"ns": example["body"]["namespace"]} if route["scoped"] else None
    status, body = call(api, route["path"], params=params)
    assert status == example["http"]
    assert body == _expected_at_read_at(example["body"], route["collectionKey"])


# DELTA CONHECIDO NO CONTRATO (reportado ao integrador, contrato intocado): readAt 1792764000 é
# 14:00:00Z e os timestamps das amostras são 12:59:4xZ, ~3620 s antes. Pela regra do próprio
# contrato ("stale when ... older than 300 seconds") a amostra lida em readAt é stale=true, mas o
# exemplo diz false. O código segue a REGRA; o resto do exemplo é comparado byte a byte.
def _expected_at_read_at(body: dict[str, Any], key: str) -> dict[str, Any]:
    expected = json.loads(json.dumps(body))
    for row in expected.get(key) or []:
        age = READ_AT - api_epoch(row["timestamp"])
        row["stale"] = age > CONTRACT_STALE_SECONDS
    return expected


CONTRACT_STALE_SECONDS = 300


def api_epoch(text: str) -> int:
    return int(datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp())


@pytest.mark.parametrize("name", ["pods_available", "nodes_available"])
def test_contract_example_stale_value_holds_when_read_fresh(api, monkeypatch, name):
    """Lida 20 s após a amostra, a linha volta com o `stale` que o exemplo do contrato mostra."""
    example = CONTRACT["examples"][name]
    route = CONTRACT["routes"][name.split("_", 1)[0]]
    row = example["body"][route["collectionKey"]][0]
    monkeypatch.setattr(api.time, "time", lambda: float(api_epoch(row["timestamp"]) + 20))
    api._k8s = Fake(SCENARIOS[name])
    params = {"ns": example["body"]["namespace"]} if route["scoped"] else None
    [got] = call(api, route["path"], params=params)[1][route["collectionKey"]]
    assert got == row


@pytest.mark.parametrize("name", sorted(CONTRACT["examples"]))
def test_contract_rules_hold_on_every_example_output(api, monkeypatch, name):
    route = CONTRACT["routes"][name.split("_", 1)[0]]
    monkeypatch.setattr(api.time, "time", lambda: float(READ_AT))
    api._k8s = Fake(SCENARIOS[name])
    params = {"ns": "team-a"} if route["scoped"] else None
    status, body = call(api, route["path"], params=params)
    state = body["metrics"]["status"]
    key = route["collectionKey"]
    assert state in CONTRACT["states"] and status == CONTRACT["states"][state]["http"]
    available = state == api.METRICS_AVAILABLE
    assert isinstance(body[key], list) if available else body[key] is None
    assert ("truncated" in body) is available
    assert ("error" in body) is (state in {"unavailable", "forbidden", "error"})
    assert ("error" not in body) or (isinstance(body["error"], str) and body["error"])
    raw = json.dumps(body)
    assert "labels" not in raw and "annotations" not in raw and "glpat-" not in raw


def test_non_dict_metadata_or_usage_drops_or_nulls_instead_of_failing(api):
    api._k8s = Fake({"/apis/metrics.k8s.io": GROUP, "/apis/metrics.k8s.io/v1beta1/pods": {"items": [
        {"metadata": "x", "containers": []},
        {**pod_metrics("ok", "x", []), "containers": [{"name": "c", "usage": "x"}]}]}})
    status, body = call(api, "/cluster/pod-metrics", params={"ns": "_all"})
    assert status == 200 and body["dropped"] == 1
    assert body["pods"][0]["containers"] == [{"name": "c", "cpuMillicores": None, "memoryBytes": None}]
