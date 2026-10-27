"""Testes adversariais dos scorecards: revisão independente do fariseu-qa sobre o commit 34d5227
(scorecards-standards), 25/10/2026, mantidos na suíte como regressão.

Cada teste afirma o comportamento CORRETO (os oito que falhavam na revisão foram corrigidos no mesmo
turn; o nono é o controle do hot path). Reusa as fixtures de tests/test_cluster_api_inventory.py.
Nada toca AWS nem cluster.
"""

from __future__ import annotations

from typing import Any

import pytest

from test_cluster_api_inventory import (  # noqa: F401  (fixture `api` é usada por nome)
    ARGO_INSTANCES, KRO, TRACKING, _Fake, _http_error, api, body_of, event, instance, kro_cluster,
)

ACK_CAPABILITY = {"capability": "s3/buckets", "engine": "ack", "kind": "Bucket",
                  "apiVersion": "s3.services.k8s.aws/v1alpha1", "plural": "buckets", "listable": True,
                  "basePath": "/apis/s3.services.k8s.aws/v1alpha1/buckets"}


def _rule(rule_id: str, level: str, check: str, **extra: Any) -> dict[str, Any]:
    return {"id": rule_id, "level": level, "check": check, "title": "t", "titlePt": "t",
            "description": "d", "descriptionPt": "d", **extra}


def _ack_bucket_bronze_and_silver_ok() -> dict[str, Any]:
    item = instance("b", kind="Bucket", labels={"platform.appmod/owner": "team-x"},
                    annotations={TRACKING: "agent-platform-instances:s3/Bucket:appmod/b"})
    item["status"]["conditions"] = [{"type": "ACK.ResourceSynced", "status": "True"}]
    return item


# 1. Nível vazio vira ouro por verdade vacua -------------------------------------------------------

def test_gold_is_not_granted_when_no_gold_rule_applies_to_the_engine(api, monkeypatch):
    """Arquivo VÁLIDO para o validador: todo ouro é kro-only. Um ACK com bronze+prata vira 'gold'."""
    document = {"version": 1, "levels": ["bronze", "silver", "gold"], "rules": [
        _rule("ready", "bronze", "ready"),
        _rule("owner", "bronze", "owner"),
        _rule("gitops", "silver", "gitops-tracked"),
        _rule("env", "gold", "spec-field", path="environment", engines=["kro"]),
    ]}
    # O validador agora recusa este arquivo (nível ouro sem regra para ack); o monkeypatch prova que
    # `_scorecard` também não concede o nível sozinho, com guarda independente do validador.
    assert "engine ack" in api._validate_standards(document)
    monkeypatch.setattr(api, "STANDARDS", document)
    card = api._scorecard(_ack_bucket_bronze_and_silver_ok(), ACK_CAPABILITY, True, True)
    gold_rows = [row for row in card["rules"] if row["level"] == "gold"]
    assert gold_rows == []
    assert card["level"] != "gold", "ouro concedido sem nenhuma regra de ouro avaliada"


def test_validator_refuses_a_level_without_any_rule(api):
    """Sem nenhuma regra de ouro, todo recurso prata vira ouro. O validador aceita hoje."""
    document = {"version": 1, "levels": ["bronze", "silver", "gold"], "rules": [
        _rule("ready", "bronze", "ready"), _rule("gitops", "silver", "gitops-tracked")]}
    assert api._validate_standards(document) != ""


# 2. Validador quebra em vez de nomear o erro ------------------------------------------------------

@pytest.mark.parametrize("bad_check", [["ready"], {"ready": True}])
def test_unhashable_check_is_a_named_error_not_a_crash(api, bad_check):
    """`check not in frozenset` com lista levanta TypeError; no import isso derruba a Lambda inteira."""
    document = {"version": 1, "levels": ["bronze", "silver", "gold"], "rules": [_rule("a", "bronze", "ready")]}
    document["rules"][0]["check"] = bad_check
    assert isinstance(api._validate_standards(document), str)


# 3. Par listagem x detalhe: o mesmo objeto, dois níveis ------------------------------------------

def test_list_and_detail_agree_on_gitops_for_the_same_object(api):
    """Marca com prefixo de Application inválido: a listagem aceita qualquer marca, o detalhe não."""
    item = instance("odd", labels={"platform.appmod/owner": "t"},
                    annotations={TRACKING: "Not_A_Valid_App:kro.run/StaticWebApp:appmod/odd"})
    item["spec"] = {"environment": "lab"}
    api._k8s = _Fake(kro_cluster(item))
    listed = body_of(api.handler(event("/cluster/scorecards", params={"ns": "appmod"}), None))["items"][0]["scorecard"]
    detail = body_of(api.handler(event("/cluster/instance", params={
        "ns": "appmod", "name": "odd", "capability": "static-web-app"}), None))["scorecard"]
    pick = lambda card: next(rule["passed"] for rule in card["rules"] if rule["id"] == "gitops-tracked")  # noqa: E731
    assert pick(listed) == pick(detail), f"listagem={pick(listed)} detalhe={pick(detail)}"
    assert listed["level"] == detail["level"]


# 4. Plano B ignora namespace: objeto de outro time herda o rastreio ------------------------------

def test_argo_resource_list_match_respects_the_namespace(api):
    tracked = instance("site", namespace="appmod", labels={"platform.appmod/owner": "t"})
    stranger = instance("site", namespace="team-b", labels={"platform.appmod/owner": "t"})
    stranger["metadata"]["uid"] = "u-other"
    routes = kro_cluster(tracked)
    routes[f"{KRO}/staticwebapps"] = {"items": [tracked, stranger]}
    routes[ARGO_INSTANCES] = {"status": {"sync": {"status": "Synced"}, "health": {"status": "Healthy"},
                                         "resources": [{"kind": "StaticWebApp", "name": "site", "namespace": "appmod"}]}}
    api._k8s = _Fake(routes)
    body = body_of(api.handler(event("/cluster/scorecards", params={}), None))
    by_ns = {item["namespace"]: next(rule for rule in item["scorecard"]["rules"] if rule["id"] == "gitops-tracked")
             for item in body["items"]}
    assert by_ns["appmod"]["passed"] is True
    assert by_ns["team-b"]["passed"] is False, "objeto criado à mão em team-b herdou o rastreio de appmod"


# 5. Hot path: nenhuma leitura nova em /cluster/instances -----------------------------------------

def test_instances_route_reads_argo_once_and_nothing_new(api):
    items = [instance(f"s{i}", labels={"platform.appmod/owner": "t"}) for i in range(3)]
    fake = _Fake(kro_cluster(*items))
    api._k8s = fake
    api.handler(event("/cluster/instances", params={"ns": "appmod"}), None)
    assert sum(1 for path in fake.paths if path.startswith(ARGO_INSTANCES)) == 1
    assert len(fake.paths) == len(set(fake.paths)), fake.paths


def test_argo_unreadable_with_zero_items_is_not_reported_readable(api):
    routes = kro_cluster()
    routes[ARGO_INSTANCES] = _http_error(403)
    api._k8s = _Fake(routes)
    body = body_of(api.handler(event("/cluster/scorecards", params={"ns": "appmod"}), None))
    assert body["summary"]["total"] == 0
    assert body["argoReadable"] is False, "Argo 403 com zero itens sai como argoReadable=True"


def test_malformed_standards_never_crash_the_whole_lambda_import(monkeypatch, tmp_path):
    """No checkout o env override vence (não há standards.json ao lado do handler). Com `check` lista,
    o import do módulo levanta TypeError: todas as rotas da cluster-api caem, não só os scorecards."""
    import importlib.util
    import json
    import sys
    from test_cluster_api_inventory import MODULE_PATH
    bad = {"version": 1, "levels": ["bronze", "silver", "gold"], "rules": [_rule("a", "bronze", "ready")]}
    bad["rules"][0]["check"] = ["ready"]
    target = tmp_path / "standards.json"
    target.write_text(json.dumps(bad), encoding="utf-8")
    monkeypatch.setenv("SCORECARD_STANDARDS_PATH", str(target))
    for name, value in {"AUTHORIZED_ALIASES": "platform-admin", "CLUSTER_ENDPOINT": "https://example.invalid",
                        "CLUSTER_CA_B64": "LS0t", "AWS_DEFAULT_REGION": "sa-east-1"}.items():
        monkeypatch.setenv(name, value)
    spec = importlib.util.spec_from_file_location("qa_fariseu_bad_standards", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["qa_fariseu_bad_standards"] = module
    spec.loader.exec_module(module)  # hoje: TypeError aqui
    assert module.STANDARDS is None and module.STANDARDS_ERROR.startswith("standards invalid")
