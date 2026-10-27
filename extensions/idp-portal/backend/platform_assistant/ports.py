"""Ports of the assistant and their adapters.

The assistant has exactly two write surfaces, both records the governed control plane already
consumes, and no other:

- `RequestStore.put_if_absent`: a provision request in the existing PROVISION_TABLE. A
  creation step is a plain `kind: infra` request, byte-compatible with the CI job
  `open-provision-mrs`, which validates it and opens the merge request. A compensation step is
  a `kind: assistant-removal` request with status `pending_removal`, which that job's scheduled
  sweep drains into a delete merge request (see README, integration hooks). It carries a KMS
  HMAC approval proof (approval.py); the MAC is computed by KMS, never by code in this module.
- `PlanStore`: the plan run itself, in the same table under `kind: assistant-plan` and a
  `plan:`-prefixed status, so no existing scan of the table can mistake it for a request.

Reads of the live object go through `ResourceObserver`, whose adapter calls the read-only
`GET /cluster/instance` of the cluster-api. No adapter here holds a Kubernetes, Git or AWS
resource credential: the module imports no boto3, no Kubernetes client and no HTTP client,
and a test asserts that.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Protocol

PLAN_KIND = "assistant-plan"
REMOVAL_KIND = "assistant-removal"
REMOVAL_PENDING = "pending_removal"
PLAN_STATUS_PREFIX = "plan:"


class ObservationUnavailable(RuntimeError):
    """The live source could not be read. Never the same thing as "the object does not exist"."""


@dataclass(frozen=True)
class Membership:
    project: str
    alias: str
    role: str          # owner | developer | viewer
    persona: str       # human persona from docs/agent-platform/personas-and-agents.md
    namespace: str


class ProjectDirectory(Protocol):
    def membership(self, project: str, alias: str) -> Membership | None: ...


class RequestStore(Protocol):
    def put_if_absent(self, item: dict[str, Any]) -> bool: ...
    def get(self, request_id: str) -> dict[str, Any] | None: ...


class PlanStore(Protocol):
    def create(self, run: dict[str, Any]) -> bool: ...
    def get(self, plan_id: str) -> dict[str, Any] | None: ...
    def save(self, run: dict[str, Any], expected_version: int) -> bool: ...


class ResourceObserver(Protocol):
    def observe(self, namespace: str, kind: str, name: str) -> dict[str, Any] | None: ...


# ---------------------------------------------------------------------- static project directory
class StaticProjects:
    """Static project contract for tests: {project: {namespace, members: {alias: role}}}. Production
    uses projects.ScopeProjects over the issue #10 registry.
    The roles decide the writes; the persona is what the timeline shows as who acted."""

    PERSONAS = {"owner": "Platform Engineer", "developer": "Application Engineer", "viewer": "Product Owner"}

    def __init__(self, projects: dict[str, Any]):
        self._projects = projects

    def membership(self, project: str, alias: str) -> Membership | None:
        entry = self._projects.get(project) or {}
        role = (entry.get("members") or {}).get(alias)
        if role not in self.PERSONAS:
            return None
        return Membership(project, alias, role, self.PERSONAS[role], entry.get("namespace") or "appmod")


# ---------------------------------------------------------------------- DynamoDB adapters
def _s(item: dict[str, Any], key: str) -> str:
    return item.get(key, {}).get("S", "")


class DynamoRequestStore:
    """Provision requests in PROVISION_TABLE, through an injected low-level DynamoDB client."""

    TEXT = ("requestId", "status", "requester", "kind", "name", "capability", "path", "manifest",
            "planId", "planStep", "project", "namespace", "channel", "mrUrl", "error", "op", "confirmer",
            "proofVersion", "macAlgorithm", "mac")
    NUMBER = ("createdAt", "expiresAt", "attempt", "mergedAt", "issuedAt")

    def __init__(self, client: Any, table: str):
        self._client, self._table = client, table

    def put_if_absent(self, item: dict[str, Any]) -> bool:
        record: dict[str, Any] = {}
        for key, value in item.items():
            if key in self.NUMBER:
                record[key] = {"N": str(int(value))}
            elif isinstance(value, bool):
                record[key] = {"BOOL": value}
            else:
                record[key] = {"S": str(value)}
        try:
            self._client.put_item(TableName=self._table, Item=record,
                                  ConditionExpression="attribute_not_exists(requestId)")
            return True
        except self._client.exceptions.ConditionalCheckFailedException:
            return False

    def get(self, request_id: str) -> dict[str, Any] | None:
        item = self._client.get_item(TableName=self._table, Key={"requestId": {"S": request_id}},
                                     ConsistentRead=True).get("Item")
        if not item:
            return None
        found: dict[str, Any] = {k: _s(item, k) for k in self.TEXT if k in item}
        for key in self.NUMBER:
            if key in item:
                found[key] = int(item[key]["N"])
        return found


class DynamoPlanStore:
    """Plan runs as one item each. `version` is an optimistic lock: two concurrent refreshes cannot
    both win, and the loser re-reads instead of overwriting the winner's timeline."""

    def __init__(self, client: Any, table: str, ttl_seconds: int = 30 * 24 * 3600):
        self._client, self._table, self._ttl = client, table, ttl_seconds

    def _item(self, run: dict[str, Any]) -> dict[str, Any]:
        return {
            "requestId": {"S": run["planId"]}, "kind": {"S": PLAN_KIND},
            "status": {"S": PLAN_STATUS_PREFIX + run["state"]}, "requester": {"S": run["requester"]},
            "project": {"S": run["project"]}, "version": {"N": str(run["version"])},
            "body": {"S": json.dumps(run, sort_keys=True, ensure_ascii=False)},
            "createdAt": {"N": str(run["createdAt"])}, "expiresAt": {"N": str(run["createdAt"] + self._ttl)},
        }

    def create(self, run: dict[str, Any]) -> bool:
        try:
            self._client.put_item(TableName=self._table, Item=self._item(run),
                                  ConditionExpression="attribute_not_exists(requestId)")
            return True
        except self._client.exceptions.ConditionalCheckFailedException:
            return False

    def get(self, plan_id: str) -> dict[str, Any] | None:
        item = self._client.get_item(TableName=self._table, Key={"requestId": {"S": plan_id}},
                                     ConsistentRead=True).get("Item")
        if not item or _s(item, "kind") != PLAN_KIND:
            return None
        return json.loads(_s(item, "body"))

    def save(self, run: dict[str, Any], expected_version: int) -> bool:
        try:
            self._client.put_item(TableName=self._table, Item=self._item(run),
                                  ConditionExpression="#k = :kind AND version = :v",
                                  ExpressionAttributeNames={"#k": "kind"},
                                  ExpressionAttributeValues={":kind": {"S": PLAN_KIND},
                                                             ":v": {"N": str(expected_version)}})
            return True
        except self._client.exceptions.ConditionalCheckFailedException:
            return False


# ---------------------------------------------------------------------- cluster-api observer
class ClusterApiObserver:
    """Adapter over the read-only `GET /cluster/instance` of the cluster-api (issues #8 and #9).

    `fetch(params) -> (status, body)` is injected: the deployment decides the transport (the
    cluster-api runs inside the cluster VPC). 404 is "not found"; anything else that is not 200,
    or a `partial` answer, is ObservationUnavailable, because a read failure must never look
    like a missing object or a Ready one.
    """

    def __init__(self, fetch: Callable[[dict[str, str]], tuple[int, Any]]):
        self._fetch = fetch

    def observe(self, namespace: str, kind: str, name: str) -> dict[str, Any] | None:
        status, body = self._fetch({"ns": namespace, "kind": kind, "name": name})
        if status == 404 and isinstance(body, dict) and body.get("error") == "instance not found":
            return None
        if status != 200 or not isinstance(body, dict) or body.get("partial"):
            raise ObservationUnavailable(f"cluster-api answered {status}")
        trail = body.get("trail") or {}
        argo = trail.get("argo") or {}
        return {
            "ready": body.get("ready"),
            "readyReason": str(body.get("readyReason") or "")[:200],
            "readyCondition": str(body.get("readyCondition") or ""),
            "conditions": [{k: str(c.get(k) or "")[:200] for k in ("type", "status", "reason")}
                           for c in (body.get("conditions") or [])[:10] if isinstance(c, dict)],
            "outputs": {k: v for k, v in (body.get("outputs") or {}).items() if isinstance(v, str)},
            "labels": dict(((body.get("metadata") or {}).get("labels")) or {}),
            "argo": {k: str(argo.get(k) or "") for k in ("sync", "health")},
        }
