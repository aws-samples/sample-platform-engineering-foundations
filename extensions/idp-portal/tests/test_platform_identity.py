"""platform_identity (backstage-killer 2b): um adapter, dois modos; fora dele nenhuma Lambda lê identidade."""
from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

import pytest
from conftest import internal_artifact

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("platform_identity", ROOT / "backend/platform_identity/__init__.py")
identity = importlib.util.module_from_spec(spec)
sys.modules["platform_identity"] = identity
spec.loader.exec_module(identity)

ACCOUNT, ROLE = "111122223333", "PortalInvokeRole"


def _iam(arn: str, http_api: bool = False) -> dict:
    rc = {"authorizer": {"iam": {"userArn": arn}}} if http_api else {"identity": {"userArn": arn}}
    return {"requestContext": rc}


def _jwt(claims: dict, rest: bool = False) -> dict:
    rc = {"authorizer": {"claims": claims}} if rest else {"authorizer": {"jwt": {"claims": claims, "scopes": []}}}
    return {"requestContext": rc}


# ---------------------------------------------------------------- iam (comportamento atual)

def test_iam_alias_is_the_session_name_of_the_expected_role_rest_and_http_api(monkeypatch):
    monkeypatch.delenv("AUTH_MODE", raising=False)
    arn = f"arn:aws:sts::{ACCOUNT}:assumed-role/{ROLE}/platform-admin"
    assert identity.caller_alias(_iam(arn)) == "platform-admin"
    assert identity.caller_alias(_iam(arn, http_api=True)) == "platform-admin"
    assert identity.caller_arn(_iam(arn)) == arn


@pytest.mark.parametrize("arn", [
    "", "arn:aws:sts::222233334444:assumed-role/PortalInvokeRole/platform-admin",
    f"arn:aws:sts::{ACCOUNT}:assumed-role/OtherRole/platform-admin", f"arn:aws:iam::{ACCOUNT}:user/platform-admin",
    f"arn:aws:sts::{ACCOUNT}:assumed-role/{ROLE}",
])
def test_iam_anything_else_is_anonymous(monkeypatch, arn):
    monkeypatch.delenv("AUTH_MODE", raising=False)
    assert identity.caller_alias(_iam(arn)) == ""
    assert identity.caller_alias({}) == "" and identity.caller_alias({"requestContext": "x"}) == ""


def test_iam_mode_ignores_jwt_claims_and_jwt_mode_ignores_iam_arns(monkeypatch):
    arn = f"arn:aws:sts::{ACCOUNT}:assumed-role/{ROLE}/platform-admin"
    monkeypatch.delenv("AUTH_MODE", raising=False)
    assert identity.caller_alias(_jwt({"cognito:username": "platform-admin"})) == ""
    monkeypatch.setenv("AUTH_MODE", "jwt")
    assert identity.caller_alias(_iam(arn)) == ""


# ---------------------------------------------------------------- jwt (sample público)

def test_jwt_alias_from_cognito_username_http_api_and_rest(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.delenv("AUTH_JWT_ISSUER", raising=False)
    monkeypatch.delenv("AUTH_JWT_CLIENT_IDS", raising=False)
    assert identity.caller_alias(_jwt({"cognito:username": "Alice", "email": "alice@example.com"})) == "alice"
    assert identity.caller_alias(_jwt({"cognito:username": "alice"}, rest=True)) == "alice"
    assert identity.caller_alias(_jwt({"email": "Bob.Smith@example.com"})) == "bob.smith"
    # access token do Cognito: `username` + `client_id`, sem `cognito:username`
    assert identity.caller_alias(_jwt({"username": "alice", "client_id": "c", "token_use": "access"})) == "alice"
    assert identity.caller_alias(_jwt({"preferred_username": "carol"})) == "carol"
    assert identity.caller_alias(_jwt({"sub": "9d1f0b2e-uuid"})) == ""  # UUID não é alias: anônimo


def test_jwt_issuer_and_client_id_controls_are_fail_closed(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("AUTH_JWT_ISSUER", "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc")
    monkeypatch.setenv("AUTH_JWT_CLIENT_IDS", "client-a, client-b")
    good = {"iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc", "client_id": "client-a", "cognito:username": "alice"}
    assert identity.caller_alias(_jwt(good)) == "alice"
    assert identity.caller_alias(_jwt({**good, "iss": "https://evil.example"})) == ""
    assert identity.caller_alias(_jwt({**good, "client_id": "client-z"})) == ""
    # `aud` (id token) vale no lugar de client_id (access token), lista ou string.
    assert identity.caller_alias(_jwt({"iss": good["iss"], "aud": ["client-b"], "cognito:username": "alice"})) == "alice"
    assert identity.caller_alias(_jwt({"iss": good["iss"], "aud": "client-a", "cognito:username": "alice"})) == "alice"
    assert identity.caller_alias(_jwt({"iss": good["iss"], "cognito:username": "alice"})) == ""  # sem client nenhum


def test_jwt_alias_claim_override_and_bad_shapes(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.delenv("AUTH_JWT_ISSUER", raising=False)
    monkeypatch.delenv("AUTH_JWT_CLIENT_IDS", raising=False)
    monkeypatch.setenv("AUTH_JWT_ALIAS_CLAIM", "custom:alias")
    assert identity.caller_alias(_jwt({"custom:alias": "dave", "cognito:username": "other"})) == "dave"
    monkeypatch.delenv("AUTH_JWT_ALIAS_CLAIM", raising=False)
    assert identity.caller_alias(_jwt({"cognito:username": "Not A Valid Alias!"})) == ""
    assert identity.caller_alias(_jwt({"cognito:username": "1starts-with-digit"})) == ""
    assert identity.caller_alias(_jwt({})) == "" and identity.caller_alias({"requestContext": {"authorizer": {}}}) == ""


def test_unknown_mode_fails_closed_at_first_use(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "basic")
    with pytest.raises(RuntimeError):
        identity.caller_alias(_jwt({"cognito:username": "alice"}))


# ---------------------------------------------------------------- contrato: a fronteira é o adapter

LAMBDAS = ["backend/cluster_api/lambda_function.py", "backend/platform_api/lambda_function.py", "backend/platform_bff/lambda_function.py"]


@pytest.mark.parametrize("path", LAMBDAS)
def test_lambdas_read_identity_only_through_the_adapter(path):
    source = internal_artifact(path).read_text(encoding="utf-8")
    assert "import platform_identity" in source
    assert "return platform_identity.caller_alias(event)" in source
    body = source.replace("def _caller_arn(event: dict[str, Any]) -> str:", "")
    # Nenhuma outra leitura do ARN/claims: só o adapter conhece a forma do evento.
    assert len(re.findall(r"assumed-role/", body)) == 0, path
    arn_reads = [line for line in body.splitlines() if "userArn" in line and "print(" not in line and "denied_arn" not in line]
    assert arn_reads == [] or path.endswith("platform_bff/lambda_function.py"), (path, arn_reads)


def test_bff_caller_arn_is_log_only_and_delegates_shape_to_the_adapter():
    source = internal_artifact("backend/platform_bff/lambda_function.py").read_text(encoding="utf-8")
    start = source.index("def _caller_arn(")
    end = source.index("\n\n\n", start)
    assert "platform_identity.caller_arn(event)" in source[start:end]


@pytest.mark.parametrize("build", ["backend/cluster_api/build.sh", "backend/platform_api/build.sh", "backend/platform_bff/build.sh"])
def test_every_bundle_ships_the_adapter(build):
    assert "platform_identity" in internal_artifact(build).read_text(encoding="utf-8")
