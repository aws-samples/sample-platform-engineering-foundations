"""platform-api: rotas de eventos (audit-log) e notificações, sobre o store em memória."""
from __future__ import annotations

import json

from test_platform_api import api, event  # noqa: F401
from test_platform_events import FakeDynamo, events


def _store(api_module, alias_admin: bool = True):
    fake = FakeDynamo()
    api_module._events = events.EventStore(fake, "events")
    return fake


def body_of(response):
    return json.loads(response["body"])


def test_routes_fail_closed_when_the_store_is_disabled(api):
    api._events = events.EventStore(FakeDynamo(), "")
    assert api.handler(event("/platform/events"), None)["statusCode"] == 503
    assert api.handler(event("/platform/notifications"), None)["statusCode"] == 503
    assert api.handler(event("/platform/notifications/read", "POST", body='{"until": 1}'), None)["statusCode"] == 503


def test_admin_sees_all_events_with_filters_and_object_trail(api):
    _store(api)
    api._events.record(actor="ana", action="provision.requested", kind="ProvisionRequest", name="r1", project="agent-platform", now=100)
    api._events.record(actor="platform-admin", action="pod.deleted", kind="Pod", name="web-1", namespace="appmod", project="agent-platform", now=200)
    api._events.record(actor="ana", action="workload.restarted", kind="Deployment", name="web", namespace="appmod", result="failed", now=300)
    body = body_of(api.handler(event("/platform/events"), None))
    assert body["scope"] == "all" and [r["time"] for r in body["items"]] == [300, 200, 100]
    body = body_of(api.handler({**event("/platform/events"), "queryStringParameters": {"actor": "ana", "result": "failed"}}, None))
    assert [r["name"] for r in body["items"]] == ["web"]
    body = body_of(api.handler({**event("/platform/events"), "queryStringParameters": {"object": "Pod/appmod/web-1"}}, None))
    assert [r["action"] for r in body["items"]] == ["pod.deleted"]
    assert api.handler({**event("/platform/events"), "queryStringParameters": {"object": "bad"}}, None)["statusCode"] == 400
    assert api.handler({**event("/platform/events"), "queryStringParameters": {"limit": "x"}}, None)["statusCode"] == 400


def test_non_admin_sees_only_own_actions_and_visible_projects(api, monkeypatch):
    monkeypatch.setattr(api, "AUTHORIZED_ALIASES", {"platform-admin", "ana"})
    monkeypatch.setattr(api, "PLATFORM_ADMINS", {"platform-admin"})
    monkeypatch.setattr(api, "_visible_project_ids", lambda alias, is_admin: ["agent-platform"] if alias == "ana" else [])
    _store(api)
    api._events.record(actor="platform-admin", action="pod.deleted", kind="Pod", name="x", project="agent-platform", now=100)
    api._events.record(actor="platform-admin", action="pod.deleted", kind="Pod", name="y", project="other", now=200)
    api._events.record(actor="ana", action="provision.requested", kind="ProvisionRequest", name="r", project="other", now=300)
    body = body_of(api.handler(event("/platform/events", alias="ana"), None))
    assert body["scope"] == "mine" and [r["name"] for r in body["items"]] == ["r", "x"]
    # Trilha por objeto também respeita a visibilidade.
    body = body_of(api.handler({**event("/platform/events", alias="ana"), "queryStringParameters": {"object": "Pod//y"}}, None))
    assert body["items"] == []


def test_notifications_and_read_markers(api, monkeypatch):
    monkeypatch.setattr(api, "_visible_project_ids", lambda alias, is_admin: ["agent-platform"])
    _store(api)
    api._events.record(actor="ci", action="provision.merged", kind="ProvisionRequest", name="r1", project="agent-platform", now=100)
    api._events.record(actor="ci", action="provision.merged", kind="ProvisionRequest", name="r2", project="elsewhere", now=200)
    box = body_of(api.handler(event("/platform/notifications"), None))
    assert [r["name"] for r in box["items"]] == ["r1"] and box["unread"] == 1
    response = api.handler(event("/platform/notifications/read", "POST", body='{"until": 150}'), None)
    assert response["statusCode"] == 200
    assert body_of(api.handler(event("/platform/notifications"), None))["unread"] == 0
    assert api.handler(event("/platform/notifications/read", "POST", body='{}'), None)["statusCode"] == 400
    assert api.handler(event("/platform/notifications/read", "POST", body='{"until": "soon"}'), None)["statusCode"] == 400
    assert api.handler(event("/platform/notifications/read", "POST", body='{"until": true}'), None)["statusCode"] == 400


def test_plan_event_is_recorded_only_for_writes_with_the_http_result(api):
    fake = _store(api)
    api._record_plan_event("platform-admin", "POST", "/platform/assistant/plans", 201, {"run": {"planId": "a" * 32, "state": "running", "project": "agent-platform"}})
    api._record_plan_event("platform-admin", "GET", "/platform/assistant/plans/" + "a" * 32, 200, {"run": {}})
    api._record_plan_event("platform-admin", "POST", "/platform/assistant/plans/" + "b" * 32 + "/compensation", 403, {"error": "not yours"})
    rows = api._events.list_events()
    assert sorted((r["action"], r["result"], r["name"][:1]) for r in rows) == [("plan.compensated", "denied", "b"), ("plan.submitted", "ok", "a")]
    assert next(r for r in rows if r["action"] == "plan.submitted")["link"].endswith("#assistant/" + "a" * 32)
    assert fake.puts == 4
