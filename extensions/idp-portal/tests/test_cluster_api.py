"""Authz fail-closed da cluster-api (sem tocar AWS/K8s)."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "backend/cluster_api/lambda_function.py"


@pytest.fixture()
def api(monkeypatch):
    monkeypatch.setenv("AUTHORIZED_ALIASES", "platform-admin")
    monkeypatch.setenv("PLATFORM_ADMINS", "platform-admin")
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://portal.example.com")
    monkeypatch.setenv("CLUSTER_ENDPOINT", "https://example.invalid")
    monkeypatch.setenv("CLUSTER_CA_B64", "LS0tLS1CRUdJTi0tLS0t")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "sa-east-1")
    spec = importlib.util.spec_from_file_location("qa_cluster_api", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["qa_cluster_api"] = module
    spec.loader.exec_module(module)
    module._k8s = lambda *a, **k: (_ for _ in ()).throw(AssertionError("K8s call must not happen"))
    return module


def event(path="/cluster/overview", method="GET", alias="platform-admin", body=None):
    return {"path": path, "httpMethod": method,
            "headers": {"origin": "https://portal.example.com"},
            "requestContext": {"identity": {"userArn": f"arn:aws:sts::111122223333:assumed-role/PortalInvokeRole/{alias}"}},
            "body": body}


def test_unknown_alias_and_wrong_role_fail_closed(api):
    assert api.handler(event(alias="mallory"), None)["statusCode"] == 403
    bad = event(); bad["requestContext"]["identity"]["userArn"] = "arn:aws:sts::111122223333:assumed-role/OtherRole/platform-admin"
    assert api.handler(bad, None)["statusCode"] == 403


def test_writes_require_admin(api, monkeypatch):
    monkeypatch.setattr(api, "PLATFORM_ADMINS", set())
    res = api.handler(event("/cluster/scale", "POST", body='{"ns":"x","name":"y"}'), None)
    assert res["statusCode"] == 403


def test_write_validates_input_before_k8s(api):
    res = api.handler(event("/cluster/scale", "POST", body='{}'), None)
    assert res["statusCode"] == 400


def test_disallowed_origin_gets_no_cors(api):
    e = event(); e["headers"] = {"origin": "https://evil.example.com"}
    res = api.handler(e, None)
    assert "Access-Control-Allow-Origin" not in res["headers"]


def test_platform_view_exposes_string_status_fields_as_outputs(api):
    """Tarefa 9 dos primeiros passos: o trail do tour lê distributionStatus e url daqui."""
    item = {"metadata": {"name": "tour-teammate", "namespace": "appmod"}, "kind": "StaticWebApp",
            "status": {"state": "ACTIVE", "url": "https://d1.cloudfront.net", "distributionStatus": "Deployed",
                       "bucketName": "appmod-tour-teammate-111122223333", "observedGeneration": 3,
                       "conditions": [{"type": "InstanceSynced", "status": "True", "message": "x" * 50}]}}
    responses = {"/apis/kro.run/v1alpha1/resourcegraphdefinitions": {"items": []},
                 "/apis/kro.run/v1alpha1": {"resources": [{"name": "staticwebapps", "verbs": ["list"]}]},
                 "/apis/kro.run/v1alpha1/staticwebapps": {"items": [item]}}
    api._k8s = lambda method, path, **_: responses[path]
    [view] = api._platform_view()["instances"]
    assert view["outputs"] == {"state": "ACTIVE", "url": "https://d1.cloudfront.net", "distributionStatus": "Deployed",
                               "bucketName": "appmod-tour-teammate-111122223333"}
    assert view["synced"] == "True"


def test_platform_view_outputs_empty_when_instance_has_no_status(api):
    responses = {"/apis/kro.run/v1alpha1/resourcegraphdefinitions": {"items": []},
                 "/apis/kro.run/v1alpha1": {"resources": [{"name": "staticwebapps", "verbs": ["list"]}]},
                 "/apis/kro.run/v1alpha1/staticwebapps": {"items": [{"metadata": {"name": "tour-x", "namespace": "appmod"}, "kind": "StaticWebApp"}]}}
    api._k8s = lambda method, path, **_: responses[path]
    assert api._platform_view()["instances"][0]["outputs"] == {}
