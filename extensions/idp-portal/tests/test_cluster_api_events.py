"""cluster-api como produtor de eventos: toda ação Day 2 grava um evento com o resultado (ok ou failed)."""
from __future__ import annotations

import json
import urllib.error

from test_cluster_api_inventory import _Fake, _http_error, api, event  # noqa: F401
from test_platform_events import FakeDynamo, events


def _arm(api_module):
    fake = FakeDynamo()
    api_module._events_store = events.EventStore(fake, "events")
    return fake


def _write(api_module, path: str, body: dict, project: str = "agent-platform"):
    ev = event(path, method="POST", params={"project": project})
    ev["body"] = json.dumps(body)
    return api_module.handler(ev, None)


def _rows(fake):
    return [(pk, item) for (pk, _sk), item in sorted(fake.items.items()) if pk == "event"]


def test_restart_and_delete_pod_record_ok_events_with_actor_object_and_project(api, monkeypatch):
    fake = _arm(api)
    monkeypatch.setattr(api, "_request_scope", lambda *a, **k: None)
    monkeypatch.setattr(api, "_restart", lambda ns, kind, name: {"restarted": True})
    api._k8s = _Fake({"/api/v1/namespaces/appmod/pods/web-1": {}})
    assert _write(api, "/cluster/restart", {"ns": "appmod", "name": "web"})["statusCode"] == 200
    assert _write(api, "/cluster/delete-pod", {"ns": "appmod", "name": "web-1"})["statusCode"] == 200
    actions = {item["action"]["S"]: item for _pk, item in _rows(fake)}
    assert set(actions) == {"workload.restarted", "pod.deleted"}
    restarted = actions["workload.restarted"]
    assert restarted["actor"]["S"] == "platform-admin" and restarted["kind"]["S"] == "deployment"
    assert restarted["namespace"]["S"] == "appmod" and restarted["project"]["S"] == "agent-platform"
    assert restarted["result"]["S"] == "ok" and restarted["source"]["S"] == "cluster-api"
    assert actions["pod.deleted"]["kind"]["S"] == "Pod" and actions["pod.deleted"]["name"]["S"] == "web-1"
    # Cópia por objeto para a trilha do detalhe.
    assert any(pk == "object#Pod/appmod/web-1" for (pk, _sk) in fake.items)


def test_failed_scale_records_a_failed_event_and_still_returns_the_error(api, monkeypatch):
    fake = _arm(api)
    monkeypatch.setattr(api, "_request_scope", lambda *a, **k: None)

    def boom(ns, kind, name, replicas):
        raise _http_error(409)
    monkeypatch.setattr(api, "_scale", boom)
    response = _write(api, "/cluster/scale", {"ns": "appmod", "name": "web", "replicas": 3})
    assert response["statusCode"] in (409, 502)
    (_pk, item), = _rows(fake)
    assert item["action"]["S"] == "workload.scaled" and item["result"]["S"] == "failed"
    assert item["detail"]["S"] == "replicas=3 http_409"


def test_disabled_store_does_not_break_the_action(api, monkeypatch):
    api._events_store = events.EventStore(None, "")
    monkeypatch.setattr(api, "_request_scope", lambda *a, **k: None)
    monkeypatch.setattr(api, "_restart", lambda ns, kind, name: {"restarted": True})
    assert _write(api, "/cluster/restart", {"ns": "appmod", "name": "web"})["statusCode"] == 200


def test_non_admin_is_refused_before_any_event(api, monkeypatch):
    fake = _arm(api)
    monkeypatch.setattr(api, "PLATFORM_ADMINS", set())
    ev = event("/cluster/restart", method="POST", alias="teammate")
    ev["body"] = json.dumps({"ns": "appmod", "name": "web"})
    assert api.handler(ev, None)["statusCode"] == 403
    assert fake.puts == 0


# ---------------------------------------------------------------------- varredura de Ready (platformReadySweep)

def _row(name: str, ready: bool, ns: str = "appmod", kind: str = "WebApp") -> dict:
    return {"kind": kind, "namespace": ns, "name": name, "ready": ready, "state": "ACTIVE" if ready else "Reconciling",
            "readyBasis": "condition"}


def _arm_sweep(api, monkeypatch, rows: list[dict], *, sources_ok: bool = True):
    fake = _arm(api)
    sources = [{"capability": "web-app", "ok": sources_ok, **({} if sources_ok else {"error": "http_503"})}]
    monkeypatch.setattr(api, "_capability_index", lambda include_ack=True: ([{"capability": "web-app", "listable": True}], list(sources)))
    monkeypatch.setattr(api, "_live_instance_rows", lambda ns, selected, src, now, full_scorecard=False: (rows, list(sources), [], True))
    return fake


def _sweep(api):
    return api.handler({"platformReadySweep": {}}, None)


def test_first_sweep_seeds_state_and_emits_no_event(api, monkeypatch):
    fake = _arm_sweep(api, monkeypatch, [_row("web", True), _row("db", False), _row("sys", True, ns="kube-system")])
    out = _sweep(api)
    assert out["status"] == 200
    assert out["body"]["seeded"] == 2 and out["body"]["ready"] == 0 and out["body"]["events"] == []
    # kube-system não pertence a projeto do registry: nem estado, nem evento.
    states = {sk for (pk, sk) in fake.items if pk == events.READY_STATE_PK}
    assert states == {"WebApp/appmod/web", "WebApp/appmod/db"}
    assert _rows(fake) == []


def test_transitions_emit_ready_and_not_ready_with_project_and_source(api, monkeypatch):
    fake = _arm_sweep(api, monkeypatch, [_row("web", True), _row("db", False)])
    assert _sweep(api)["status"] == 200
    _arm_sweep(api, monkeypatch, [_row("web", False), _row("db", True)])
    api._events_store = events.EventStore(fake, "events")
    out = _sweep(api)
    assert out["body"]["ready"] == 1 and out["body"]["notReady"] == 1 and len(out["body"]["events"]) == 2
    by_name = {item["name"]["S"]: item for _pk, item in _rows(fake)}
    assert by_name["db"]["action"]["S"] == "instance.ready" and by_name["db"]["result"]["S"] == "ok"
    assert by_name["web"]["action"]["S"] == "instance.not-ready" and by_name["web"]["result"]["S"] == "failed"
    assert by_name["web"]["detail"]["S"] == "Reconciling"
    for item in by_name.values():
        assert item["actor"]["S"] == "platform" and item["project"]["S"] == "agent-platform"
        assert item["source"]["S"] == "ready-sweep" and item["link"]["S"] == "/agent-platform/#cluster"
    # Terceira varredura sem mudança: nada novo.
    api._events_store = events.EventStore(fake, "events")
    assert _sweep(api)["body"]["events"] == [] and len(_rows(fake)) == 2


def test_vanished_object_is_marked_absent_and_reappearing_is_seeded_not_notified(api, monkeypatch):
    fake = _arm_sweep(api, monkeypatch, [_row("web", True)])
    _sweep(api)
    _arm_sweep(api, monkeypatch, [])
    api._events_store = events.EventStore(fake, "events")
    assert _sweep(api)["body"]["absent"] == 1
    assert fake.items[(events.READY_STATE_PK, "WebApp/appmod/web")]["ready"] == {"NULL": True}
    _arm_sweep(api, monkeypatch, [_row("web", True)])
    api._events_store = events.EventStore(fake, "events")
    out = _sweep(api)
    assert out["body"]["seeded"] == 1 and out["body"]["events"] == [] and _rows(fake) == []


def test_partial_source_skips_the_sweep_without_touching_state(api, monkeypatch):
    fake = _arm_sweep(api, monkeypatch, [_row("web", True)])
    _sweep(api)
    before = dict(fake.items)
    _arm_sweep(api, monkeypatch, [], sources_ok=False)
    api._events_store = events.EventStore(fake, "events")
    out = _sweep(api)
    assert out["status"] == 502 and "skipped" in out["body"]["error"]
    assert fake.items == before, "fonte ilegível não pode virar 'sumiu' nem 'not-ready'"


def test_disabled_store_and_bad_payload_are_refused(api, monkeypatch):
    _arm_sweep(api, monkeypatch, [_row("web", True)])
    api._events_store = events.EventStore(None, "")
    assert _sweep(api)["status"] == 503
    api._events_store = events.EventStore(FakeDynamo(), "events")
    assert api.handler({"platformReadySweep": {"ns": "appmod"}}, None)["status"] == 400
    # Pelo API Gateway (requestContext presente) a chave de topo é ignorada: não existe rota HTTP para a varredura.
    assert "status" not in api.handler({"platformReadySweep": {}, "requestContext": {}, "httpMethod": "GET", "path": "/x"}, None)
