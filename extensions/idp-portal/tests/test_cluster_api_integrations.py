"""integrations-health: uma linha por ferramenta, com o que foi medido; falha de leitura é `failed`, nunca ok."""
from __future__ import annotations

import json

from test_cluster_api_inventory import _Fake, api, event  # noqa: F401
from test_platform_events import FakeDynamo, events


def _app(sync: str, health: str) -> dict:
    return {"metadata": {"name": "x"}, "status": {"sync": {"status": sync}, "health": {"status": health}}}


def _deploy(ready: int, want: int) -> dict:
    return {"spec": {"replicas": want}, "status": {"readyReplicas": ready}}


def _cluster(api_module, **overrides):
    base = {
        "/version": {"gitVersion": "v1.36.4-eks"},
        "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications": {"items": [_app("Synced", "Healthy"), _app("Synced", "Healthy")]},
        "/apis/kro.run/v1alpha1/resourcegraphdefinitions": {"items": [{"status": {"state": "Active"}}, {"status": {"state": "Active"}}]},
        "/apis/metrics.k8s.io/v1beta1": {"kind": "APIResourceList"},
        "/apis/apps/v1/namespaces/argo-workflows/deployments/argo-workflows-workflow-controller": _deploy(1, 1),
        "/apis/apps/v1/namespaces/kagent/deployments/kagent-controller": _deploy(1, 1),
        "/apis/apps/v1/namespaces/langfuse/deployments/langfuse-web": _deploy(1, 1),
        "/apis/apps/v1/namespaces/monitoring/deployments/victoria-metrics-grafana": _deploy(1, 1),
        "/apis/apps/v1/namespaces/keycloak/statefulsets/keycloak": _deploy(1, 1),
    }
    for group in api_module.ACK_API_GROUPS:
        base[f"/apis/{group}"] = {"kind": "APIGroup"}
    base.update(overrides)
    api_module._k8s = _Fake(base)
    api_module._events_store = events.EventStore(FakeDynamo(), "events")


def _rows(api_module):
    response = api_module.handler(event("/cluster/integrations"), None)
    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    return {row["id"]: row for row in body["items"]}, body["summary"]


def test_all_green_cluster_measures_every_integration(api, monkeypatch):
    monkeypatch.setattr(api, "_request_scope", lambda *a, **k: None)
    _cluster(api)
    rows, summary = _rows(api)
    assert set(rows) == {"kubernetes", "argocd", "kro", "ack", "metrics-server", "argo-workflows", "kagent", "langfuse", "grafana", "keycloak", "events"}
    assert all(row["status"] == "ok" for row in rows.values()), {k: v["status"] for k, v in rows.items()}
    assert rows["kubernetes"]["detail"] == "v1.36.4-eks"
    assert rows["argocd"]["detail"] == "2 applications, 2 synced, 2 healthy"
    assert rows["kro"]["detail"] == "2 definições, 2 Active"
    assert rows["ack"]["detail"].startswith(f"{len(api.ACK_API_GROUPS)}/{len(api.ACK_API_GROUPS)} grupos")
    assert rows["events"]["detail"] == "0 instâncias com estado de Ready"
    assert summary == {"ok": 11, "degraded": 0, "failed": 0, "unknown": 0}
    assert all(row["readAt"] > 0 for row in rows.values())


def test_degraded_and_failed_are_named_with_a_hint_never_ok_by_omission(api, monkeypatch):
    monkeypatch.setattr(api, "_request_scope", lambda *a, **k: None)
    _cluster(api, **{
        "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications": {"items": [_app("OutOfSync", "Degraded"), _app("Synced", "Healthy")]},
        "/apis/apps/v1/namespaces/langfuse/deployments/langfuse-web": _deploy(0, 1),
    })
    # metrics-server e um grupo ACK fora do mapa: _Fake responde 404 => failed / degraded.
    del api._k8s.routes["/apis/metrics.k8s.io/v1beta1"]
    del api._k8s.routes[f"/apis/{api.ACK_API_GROUPS[0]}"]
    rows, summary = _rows(api)
    assert rows["argocd"]["status"] == "degraded" and "fora de Synced" in rows["argocd"]["hint"]
    assert rows["langfuse"]["status"] == "degraded" and rows["langfuse"]["detail"] == "0/1 réplicas prontas" and "describe deployment" in rows["langfuse"]["hint"]
    assert rows["metrics-server"]["status"] == "failed" and rows["metrics-server"]["detail"] == "http_404"
    assert rows["ack"]["status"] == "degraded" and "sem: " in rows["ack"]["detail"]
    assert summary["ok"] == 7 and summary["degraded"] == 3 and summary["failed"] == 1


def test_not_installed_workload_is_unknown_and_disabled_store_is_unknown(api, monkeypatch):
    monkeypatch.setattr(api, "_request_scope", lambda *a, **k: None)
    _cluster(api)
    del api._k8s.routes["/apis/apps/v1/namespaces/keycloak/statefulsets/keycloak"]
    api._events_store = events.EventStore(None, "")
    rows, _ = _rows(api)
    assert rows["keycloak"]["status"] == "unknown" and rows["keycloak"]["detail"] == "não instalado"
    assert rows["events"]["status"] == "unknown"


def test_unreadable_store_is_failed_with_the_iam_hint(api, monkeypatch):
    monkeypatch.setattr(api, "_request_scope", lambda *a, **k: None)
    _cluster(api)
    api._events_store = events.EventStore(FakeDynamo(fail_query=True), "events")
    rows, _ = _rows(api)
    assert rows["events"]["status"] == "failed" and "PlatformReadyStateRead" in rows["events"]["hint"]


def test_a_failed_source_read_leaves_a_structured_log_line(api, monkeypatch, capsys):
    """Até 26/10 a falha era silenciosa: o portal dizia 'discovery unavailable' e o log não tinha a causa."""
    import urllib.error
    monkeypatch.setattr(api, "_request_scope", lambda *a, **k: None)
    api._k8s = _Fake({}, default=None)
    api._k8s.routes["/apis/kro.run/v1alpha1/resourcegraphdefinitions"] = urllib.error.HTTPError("u", 401, "Unauthorized", {}, None)
    items, truncated, code = api._list_source("/apis/kro.run/v1alpha1/resourcegraphdefinitions")
    assert (items, truncated, code) == ([], False, "http_401")
    logged = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    assert [row for row in logged if row["event"] == "source_read_failed"] == [{
        "event": "source_read_failed", "path": "/apis/kro.run/v1alpha1/resourcegraphdefinitions", "code": "http_401",
        "error": "HTTPError: HTTP Error 401: Unauthorized"}]
