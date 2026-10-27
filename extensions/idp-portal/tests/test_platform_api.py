"""Authz and contract tests for the platform-api Lambda."""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "backend/platform_api/lambda_function.py"


@pytest.fixture()
def api(monkeypatch):
    monkeypatch.setenv("AUTHORIZED_ALIASES", "platform-admin")
    monkeypatch.setenv("PLATFORM_ADMINS", "platform-admin")
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://portal.example.com")
    monkeypatch.setenv("IDENTITY_STORE_ID", "d-test")
    monkeypatch.setenv("VIEWER_GROUP_ID", "g-test")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "sa-east-1")
    spec = importlib.util.spec_from_file_location("qa_platform_api", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["qa_platform_api"] = spec.loader is not None and module or module
    spec.loader.exec_module(module)

    class Refuse:
        def __getattr__(self, name):
            raise AssertionError(f"AWS call {name} must not happen in this test")

    module._tagging = Refuse()
    module._identity = Refuse()
    return module


def event(path="/platform/me", method="GET", alias="platform-admin", role="PortalInvokeRole", body=None):
    return {
        "path": path,
        "httpMethod": method,
        "headers": {"origin": "https://portal.example.com"},
        "requestContext": {"identity": {"userArn": f"arn:aws:sts::111122223333:assumed-role/{role}/{alias}"}},
        "body": body,
    }


def test_wrong_role_and_unknown_alias_fail_closed(api):
    assert api.handler(event(role="OtherRole"), None)["statusCode"] == 403
    assert api.handler(event(alias="mallory"), None)["statusCode"] == 403
    assert api.handler({"path": "/platform/me", "httpMethod": "GET", "requestContext": {}}, None)["statusCode"] == 403


def test_me_reports_admin_only_for_platform_admins(api, monkeypatch):
    ok = api.handler(event(), None)
    assert ok["statusCode"] == 200
    assert json.loads(ok["body"])["isAdmin"] is True


def test_onboard_requires_admin_and_validates_alias(api):
    denied = api.handler(event("/platform/onboard", "POST", alias="platform-admin", body='{"alias":"Bad Alias!","givenName":"A","familyName":"B"}'), None)
    assert denied["statusCode"] == 400  # admin ok, alias inválido barra antes de qualquer AWS call
    non_admin = event("/platform/onboard", "POST", alias="someone", body="{}")
    assert api.handler(non_admin, None)["statusCode"] == 403


def test_disallowed_origin_gets_no_cors_headers(api):
    e = event()
    e["headers"] = {"origin": "https://evil.example.com"}
    res = api.handler(e, None)
    assert "Access-Control-Allow-Origin" not in res["headers"]


def _tagging_pages(pages):
    class Tagging:
        calls = 0

        def get_resources(self, **_kwargs):
            page = pages[Tagging.calls]
            Tagging.calls += 1
            return page
    return Tagging()


def test_resources_scan_past_five_pages_and_flag_truncation(api):
    arn = "arn:aws:ecs:sa-east-1:111122223333:task-definition/demo:{}"
    page = lambda i, token: {"ResourceTagMappingList": [{"ResourceARN": arn.format(i), "Tags": []}], "PaginationToken": token}
    api._tagging = _tagging_pages([page(i, "t") for i in range(7)] + [page(7, "")])
    body = json.loads(api.handler(event("/platform/resources"), None)["body"])
    assert body["count"] == 8 and body["truncated"] is False

    api._tagging = _tagging_pages([page(i, "t") for i in range(api.MAX_RESOURCE_PAGES)])
    body = json.loads(api.handler(event("/platform/resources"), None)["body"])
    assert body["count"] == api.MAX_RESOURCE_PAGES and body["truncated"] is True
