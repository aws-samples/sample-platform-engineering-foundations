"""Team authorization across the three portal APIs (platform-api, cluster-api, BFF).

AUTHORIZED_ALIASES="*" admits every session of PortalInvokeRole. That is only safe
because the internal gateway gates the assume on team membership (the internal allowlist "Can assume" granted to team
platform-team) and sets the session name to the the corporate SSO alias. These tests pin the parts
that live in our code: wildcard works, empty still denies, the role check still applies,
malformed aliases are refused, "*" never grants admin, and the three copies stay identical.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULES = {
    "platform_api": ROOT / "backend/platform_api/lambda_function.py",
    "cluster_api": ROOT / "backend/cluster_api/lambda_function.py",
    "platform_bff": ROOT / "backend/platform_bff/lambda_function.py",
}


def load(name, monkeypatch, aliases, admins="platform-admin"):
    if not MODULES[name].exists():
        pytest.skip(f"internal-only artifact not in this tree: {name}")
    monkeypatch.setenv("AUTHORIZED_ALIASES", aliases)
    monkeypatch.setenv("PLATFORM_ADMINS", admins)
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://portal.example.com")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "sa-east-1")
    monkeypatch.setenv("CLUSTER_ENDPOINT", "https://example.invalid")
    monkeypatch.setenv("CLUSTER_CA_B64", "LS0tLS1CRUdJTi0tLS0t")
    monkeypatch.setenv("GATEWAY_URL", "https://private.example/prod")
    monkeypatch.setenv("API_KEY_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:000000000000:secret:test")
    if name == "platform_bff":
        stub = types.ModuleType("boto3")
        stub.client = lambda _name: object()  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "boto3", stub)
    spec = importlib.util.spec_from_file_location(f"qa_team_{name}", MODULES[name])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def arn(alias, role="PortalInvokeRole"):
    return f"arn:aws:sts::111122223333:assumed-role/{role}/{alias}"


def event(path, alias, method="GET", role="PortalInvokeRole", body=None):
    return {"path": path, "httpMethod": method, "headers": {"origin": "https://portal.example.com"},
            "requestContext": {"identity": {"userArn": arn(alias, role)}}, "body": body}


@pytest.mark.parametrize("name", MODULES)
def test_wildcard_admits_any_team_session(name, monkeypatch):
    mod = load(name, monkeypatch, "*")
    for alias in ("platform-admin", "jnagase", "teammate"):
        assert mod._alias_authorized(alias), alias


@pytest.mark.parametrize("name", MODULES)
def test_empty_list_still_denies_everyone(name, monkeypatch):
    mod = load(name, monkeypatch, "")
    assert not mod._alias_authorized("platform-admin")


@pytest.mark.parametrize("name", MODULES)
@pytest.mark.parametrize("alias", ["", "Evil", "a b", "../x", "x" * 70, "*"])
def test_wildcard_refuses_malformed_session_names(name, alias, monkeypatch):
    mod = load(name, monkeypatch, "*")
    assert not mod._alias_authorized(alias)


@pytest.mark.parametrize("name", MODULES)
def test_explicit_list_keeps_working(name, monkeypatch):
    mod = load(name, monkeypatch, "platform-admin,jnagase")
    assert mod._alias_authorized("jnagase")
    assert not mod._alias_authorized("teammate")


def test_platform_api_team_member_gets_in_but_is_not_admin(monkeypatch):
    mod = load("platform_api", monkeypatch, "*", admins="platform-admin")
    res = mod.handler(event("/prod/platform/me", "teammate"), None)
    assert res["statusCode"] == 200
    assert json.loads(res["body"])["isAdmin"] is False
    onboard = mod.handler(event("/prod/platform/onboard", "teammate", method="POST", body="{}"), None)
    assert onboard["statusCode"] == 403


def test_star_in_admins_grants_no_admin(monkeypatch):
    mod = load("platform_api", monkeypatch, "*", admins="*")
    res = mod.handler(event("/prod/platform/me", "teammate"), None)
    assert json.loads(res["body"])["isAdmin"] is False


def test_cluster_api_team_member_cannot_write(monkeypatch):
    mod = load("cluster_api", monkeypatch, "*", admins="platform-admin")
    mod._k8s = lambda *a, **k: pytest.fail("K8s must not be called for a non-admin write")
    res = mod.handler(event("/cluster/scale", "teammate", method="POST", body='{"ns":"appmod","name":"x","replicas":1}'), None)
    assert res["statusCode"] == 403


@pytest.mark.parametrize("name,path", [("platform_api", "/prod/platform/me"), ("cluster_api", "/cluster/overview"), ("platform_bff", "/gateway/health")])
def test_wildcard_does_not_admit_another_role(name, path, monkeypatch):
    mod = load(name, monkeypatch, "*")
    res = mod.handler(event(path, "teammate", role="SomeOtherRole"), None)
    assert res["statusCode"] == 403


def test_the_three_gates_are_the_same_code():
    """One gate, three copies (each Lambda ships as a single file). They must not drift."""
    pattern = re.compile(r'# "\*" admits every session.*?return "\*" in AUTHORIZED_ALIASES or alias in AUTHORIZED_ALIASES\n', re.S)
    copies = {name: pattern.search(path.read_text()).group(0) for name, path in MODULES.items() if path.exists() or pytest.skip(f"internal-only artifact not in this tree: {name}")}
    assert len(set(copies.values())) == 1, "the alias gate diverged between Lambdas"
