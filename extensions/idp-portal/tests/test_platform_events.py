"""platform_events: um store para audit log e notificações (fail-open na escrita, fail-closed na leitura)."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("platform_events", ROOT / "backend/platform_events/__init__.py")
events = importlib.util.module_from_spec(spec)
sys.modules["platform_events"] = events
spec.loader.exec_module(events)


class FakeDynamo:
    """put_item/query mínimos: ordena por sk, filtra por pk e por `sk > :since`."""

    def __init__(self, *, fail_put: bool = False, fail_query: bool = False) -> None:
        self.items: dict[tuple[str, str], dict[str, Any]] = {}
        self.fail_put, self.fail_query = fail_put, fail_query
        self.puts = 0

    def put_item(self, TableName: str, Item: dict[str, Any], **_: Any) -> None:
        if self.fail_put:
            raise RuntimeError("ProvisionedThroughputExceededException")
        self.puts += 1
        self.items[(Item["pk"]["S"], Item["sk"]["S"])] = Item

    def query(self, TableName: str, KeyConditionExpression: str, ExpressionAttributeValues: dict[str, Any],
              ScanIndexForward: bool = True, Limit: int = 100, **_: Any) -> dict[str, Any]:
        if self.fail_query:
            raise RuntimeError("AccessDeniedException")
        pk = ExpressionAttributeValues[":pk"]["S"]
        since = ExpressionAttributeValues.get(":since", {}).get("S")
        rows = [item for (p, sk), item in self.items.items() if p == pk and (since is None or sk > since)]
        rows.sort(key=lambda item: item["sk"]["S"], reverse=not ScanIndexForward)
        return {"Items": rows[:Limit]}


@pytest.fixture()
def store():
    fake = FakeDynamo()
    return events.EventStore(fake, "events-table"), fake


def test_record_validates_vocabulary_and_writes_general_and_per_object_copies(store):
    s, fake = store
    event = s.record(actor="platform-admin", action="workload.restarted", kind="Deployment", name="web", namespace="appmod",
                     project="agent-platform", detail="rollout restart", link="/agent-platform/#cluster", source="cluster-api", now=1_700_000_000)
    assert event["id"] and event["time"] == 1_700_000_000
    assert fake.puts == 2
    assert ("event", f"{1_700_000_000_000:016d}#{event['id']}") in fake.items
    assert ("object#Deployment/appmod/web", f"{1_700_000_000_000:016d}#{event['id']}") in fake.items
    with pytest.raises(ValueError):
        s.record(actor="x", action="made.up", kind="K", name="n")
    with pytest.raises(ValueError):
        s.record(actor="x", action="pod.deleted", kind="Pod", name="n", result="meh")


def test_write_failure_is_logged_and_never_raises(capsys):
    fake = FakeDynamo(fail_put=True)
    s = events.EventStore(fake, "t")
    event = s.record(actor="a", action="pod.deleted", kind="Pod", name="p", namespace="ns")
    assert event is not None
    assert "platform_event_write_failed" in capsys.readouterr().out


def test_disabled_store_records_nothing_and_reads_fail_closed():
    s = events.EventStore(FakeDynamo(), "")
    assert s.record(actor="a", action="pod.deleted", kind="Pod", name="p") is None
    with pytest.raises(events.EventStoreError):
        s.list_events()
    with pytest.raises(events.EventStoreError):
        s.notifications("a", [])


def test_detail_is_sanitized_and_truncated(store):
    s, fake = store
    event = s.record(actor="a", action="plan.failed", kind="Plan", name="p", detail="token=abc\n<script>" + "x" * 500, result="failed")
    assert "\n" not in event["detail"] and "<" not in event["detail"]
    assert len(event["detail"]) <= events.DETAIL_MAX


def test_list_events_newest_first_with_filters_and_non_admin_scope(store):
    s, _ = store
    s.record(actor="ana", action="provision.requested", kind="Request", name="r1", project="p1", now=100)
    s.record(actor="bob", action="provision.merged", kind="Request", name="r2", project="p2", now=200)
    s.record(actor="ana", action="pod.deleted", kind="Pod", name="x", project="p2", result="denied", now=300)
    rows = s.list_events()
    assert [r["time"] for r in rows] == [300, 200, 100]
    assert [r["name"] for r in s.list_events(action="provision.merged")] == ["r2"]
    assert [r["name"] for r in s.list_events(result="denied")] == ["x"]
    # Não-admin de p1: vê o que é de p1 OU o que ela mesma fez (o pod em p2 é dela; o merge do bob não).
    assert [r["name"] for r in s.list_events(actor="ana", projects=["p1"])] == ["x", "r1"]
    # Admin filtrando por ator.
    assert [r["name"] for r in s.list_events(actor="bob")] == ["r2"]


def test_object_trail_reads_only_that_object(store):
    s, _ = store
    s.record(actor="a", action="workload.restarted", kind="Deployment", name="web", namespace="ns", now=10)
    s.record(actor="a", action="workload.scaled", kind="Deployment", name="web", namespace="ns", now=20)
    s.record(actor="a", action="workload.scaled", kind="Deployment", name="other", namespace="ns", now=30)
    assert [r["action"] for r in s.object_trail("Deployment", "ns", "web")] == ["workload.scaled", "workload.restarted"]


def test_notifications_are_relevant_events_with_read_state(store):
    s, _ = store
    s.record(actor="ana", action="provision.requested", kind="Request", name="r1", project="p1", now=100)
    s.record(actor="ci", action="provision.merged", kind="Request", name="r1", project="p1", now=200)
    s.record(actor="bob", action="pod.deleted", kind="Pod", name="x", project="p9", now=300)
    s.record(actor="ana", action="plan.submitted", kind="Plan", name="pl", project="p9", now=400)
    box = s.notifications("ana", ["p1"])
    assert [r["time"] for r in box["items"]] == [400, 200, 100]
    assert box["unread"] == 3 and box["readAt"] == 0
    s.mark_read("ana", until=200)
    box = s.notifications("ana", ["p1"])
    assert [r["read"] for r in box["items"]] == [False, True, True] and box["unread"] == 1
    s.mark_read("ana", event_id=box["items"][0]["id"])
    assert s.notifications("ana", ["p1"])["unread"] == 0
    with pytest.raises(ValueError):
        s.mark_read("ana")
    with pytest.raises(ValueError):
        s.mark_read("Ana Maria", until=1)
    with pytest.raises(ValueError):
        s.mark_read("ana", event_id="not-hex")


def test_read_failure_is_a_named_error_not_an_empty_list():
    s = events.EventStore(FakeDynamo(fail_query=True), "t")
    with pytest.raises(events.EventStoreError):
        s.list_events()
    with pytest.raises(events.EventStoreError):
        s.object_trail("Pod", "ns", "x")


# ---------------------------------------------------------------------- varredura de Ready

def test_plan_ready_sweep_seeds_unknown_objects_and_emits_only_transitions():
    previous = {"a": True, "b": False, "c": True, "d": None, "gone": False}
    current = {"a": True, "b": True, "c": False, "d": True, "new": True}
    plan = events.plan_ready_sweep(previous, current)
    assert plan == {"ready": ["b"], "notReady": ["c"], "seed": ["d", "new"], "absent": ["gone"]}


def test_plan_ready_sweep_first_run_emits_nothing():
    plan = events.plan_ready_sweep({}, {"x": True, "y": False})
    assert plan["ready"] == [] and plan["notReady"] == [] and sorted(plan["seed"]) == ["x", "y"]


def test_ready_state_round_trip_lives_in_its_own_partition(store):
    s, fake = store
    assert s.ready_states() == {}
    s.write_ready_state("Deployment/appmod/web", True, now=100)
    s.write_ready_state("Deployment/appmod/db", False, now=100)
    s.write_ready_state("Deployment/appmod/old", None, now=100)
    assert s.ready_states() == {"Deployment/appmod/web": True, "Deployment/appmod/db": False, "Deployment/appmod/old": None}
    assert all(pk == events.READY_STATE_PK for (pk, _sk) in fake.items), "estado nunca vira evento da trilha"
    assert s.list_events() == [] and all(item["expiresAt"]["N"] == str(100 + events.TTL_SECONDS) for item in fake.items.values())


def test_ready_state_is_fail_closed_both_ways():
    with pytest.raises(events.EventStoreError):
        events.EventStore(FakeDynamo(fail_query=True), "t").ready_states()
    with pytest.raises(events.EventStoreError):
        events.EventStore(FakeDynamo(fail_put=True), "t").write_ready_state("k", True)
    with pytest.raises(events.EventStoreError):
        events.EventStore(None, "").ready_states()


def test_instance_actions_are_in_the_vocabulary():
    assert {"instance.ready", "instance.not-ready"} <= events.ACTIONS
    assert events.event_record(actor=events.READY_SWEEP_ACTOR, action="instance.ready", kind="Deployment", name="web")["actor"] == "platform"
