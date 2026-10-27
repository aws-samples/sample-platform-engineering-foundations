"""Contract tests for the platform-api provisioning-request routes.

The portal cannot reach GitLab (the corporate SSO gateway), so it records a request and the CI job
opens the MR. These tests pin what the Lambda accepts, what it stores, and who may read it.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "backend/platform_api/lambda_function.py"
MANIFEST = "apiVersion: kro.run/v1alpha1\nkind: DynamoDBTable\nmetadata:\n  name: orders\n  namespace: appmod\n"


class FakeTable:
    def __init__(self):
        self.items: dict[str, dict] = {}

    def put_item(self, TableName, Item, ConditionExpression):
        assert TableName == "provision-test"
        assert ConditionExpression == "attribute_not_exists(requestId)"
        self.items[Item["requestId"]["S"]] = Item

    def get_item(self, TableName, Key, ConsistentRead):
        return {"Item": self.items[Key["requestId"]["S"]]} if Key["requestId"]["S"] in self.items else {}


@pytest.fixture()
def api(monkeypatch):
    monkeypatch.setenv("AUTHORIZED_ALIASES", "platform-admin,alice,bob")
    monkeypatch.setenv("PLATFORM_ADMINS", "platform-admin")
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://portal.example.com")
    monkeypatch.setenv("PROVISION_TABLE", "provision-test")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "sa-east-1")
    spec = importlib.util.spec_from_file_location("qa_platform_api_provision", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["qa_platform_api_provision"] = module
    spec.loader.exec_module(module)
    module._dynamodb = FakeTable()
    return module


def call(api, method, path, alias="alice", body=None):
    event = {
        "path": path,
        "httpMethod": method,
        "headers": {"origin": "https://portal.example.com"},
        "requestContext": {"identity": {"userArn": f"arn:aws:sts::111122223333:assumed-role/PortalInvokeRole/{alias}"}},
        "body": json.dumps(body) if body is not None else None,
    }
    response = api.handler(event, None)
    return response["statusCode"], json.loads(response["body"])


def create(api, alias="alice", **overrides):
    body = {"kind": "infra", "name": "orders", "capability": "database/dynamodb", "manifest": MANIFEST, **overrides}
    return call(api, "POST", "/prod/platform/provision-requests", alias, body)


def test_create_records_a_pending_request_and_derives_the_path(api):
    status, body = create(api)
    assert status == 201
    assert body["status"] == "pending"
    assert body["path"] == "platform/instances/orders.yaml"
    stored = api._dynamodb.items[body["requestId"]]
    assert stored["requester"]["S"] == "alice"
    assert stored["manifest"]["S"] == MANIFEST
    assert int(stored["expiresAt"]["N"]) > int(stored["createdAt"]["N"])


def test_agent_requests_go_to_agent_definitions(api):
    status, body = create(api, kind="agent", name="eks-health-agent", manifest='{"name": "eks-health-agent"}')
    assert status == 201
    assert body["path"] == "docs/agent-definitions/eks-health-agent.json"


@pytest.mark.parametrize("name", ["../main", "Orders", "a/b", "-lead", "trail-", "x" * 64, "", "a.b"])
def test_name_is_the_only_path_input_and_must_be_a_dns_label(api, name):
    status, body = create(api, name=name)
    assert status == 400, name
    assert "name" in body["error"]
    assert api._dynamodb.items == {}


@pytest.mark.parametrize("override", [{"kind": "terraform"}, {"manifest": ""}, {"manifest": "   "}, {"manifest": 42}, {"manifest": "x" * 40_000}])
def test_invalid_kind_or_manifest_is_rejected_before_any_write(api, override):
    status, _ = create(api, **override)
    assert status == 400
    assert api._dynamodb.items == {}


def test_requester_reads_own_request(api):
    _, created = create(api, alias="alice")
    status, body = call(api, "GET", f"/prod/platform/provision-requests/{created['requestId']}", alias="alice")
    assert status == 200
    assert body["status"] == "pending" and body["path"] == "platform/instances/orders.yaml"
    assert "manifest" not in body


def test_other_users_request_is_indistinguishable_from_a_missing_one(api):
    _, created = create(api, alias="alice")
    foreign = call(api, "GET", f"/prod/platform/provision-requests/{created['requestId']}", alias="bob")
    missing = call(api, "GET", f"/prod/platform/provision-requests/{'0' * 32}", alias="bob")
    assert foreign == missing
    assert foreign[0] == 404


def test_admin_can_read_any_request(api):
    _, created = create(api, alias="alice")
    status, _ = call(api, "GET", f"/prod/platform/provision-requests/{created['requestId']}", alias="platform-admin")
    assert status == 200


def test_malformed_request_id_does_not_match_the_route(api):
    status, body = call(api, "GET", "/prod/platform/provision-requests/not-an-id", alias="alice")
    assert status == 404 and body["error"] == "route not found"


def test_unauthorized_alias_cannot_create(api):
    status, _ = create(api, alias="mallory")
    assert status == 403
    assert api._dynamodb.items == {}
