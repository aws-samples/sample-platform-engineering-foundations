"""Inventário live por capability (#8) e detalhe por instância (#9) da cluster-api.

Nada aqui toca AWS nem o cluster: `_k8s` é substituído por um fake, e o default
da fixture é um `_k8s` que levanta se alguma rota escapar para a rede de verdade.

Cada invariante tem o seu controle PAREADO: o caso bom passa e a versão
adulterada é recusada. Sem o par, um validador vazio passaria igual.

  I-A  erro de origem nunca vira lista vazia (par: fonte ok -> 200 com itens;
       toda fonte falhando -> 502, não 200 com items [])
  I-B  Ready exige condition real E observedGeneration atual (par: condition
       True com observed==generation -> ready; os quatro desvios -> não-ready)
  I-C  nenhuma credencial no payload (par: output inócuo sai; chave e valor
       sensíveis não saem)
  I-D  namespace e autorização aplicados no backend (par: ns válido entra na URL
       do API server; alias fora da allowlist -> 403 antes de qualquer leitura)
"""
from __future__ import annotations

import importlib.util
import json
import sys
import urllib.error
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "backend/cluster_api/lambda_function.py"

KRO = "/apis/kro.run/v1alpha1"
RGD_PATH = f"{KRO}/resourcegraphdefinitions"
ARGO_INSTANCES = "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/agent-platform-instances"


def _http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(f"https://example.invalid/{code}", code, "err", {}, None)  # type: ignore[arg-type]


class _Fake:
    """API server de mentira: casa por prefixo e registra todo path recebido."""

    def __init__(self, routes: dict[str, Any], default: Any = None) -> None:
        self.routes = routes
        self.default = default
        self.paths: list[str] = []

    def __call__(self, method: str, path: str, body: Any = None, **_: Any) -> Any:
        self.paths.append(path)
        for prefix, value in sorted(self.routes.items(), key=lambda pair: -len(pair[0])):
            if path.startswith(prefix):
                if isinstance(value, BaseException):
                    raise value
                return value(method, path, body) if callable(value) else value
        if self.default is not None:
            return self.default
        raise _http_error(404)


@pytest.fixture()
def api(monkeypatch):
    monkeypatch.setenv("AUTHORIZED_ALIASES", "platform-admin,teammate")
    monkeypatch.setenv("PLATFORM_ADMINS", "platform-admin")
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://portal.example.com")
    monkeypatch.setenv("CLUSTER_ENDPOINT", "https://example.invalid")
    monkeypatch.setenv("CLUSTER_CA_B64", "LS0tLS1CRUdJTi0tLS0t")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "sa-east-1")
    spec = importlib.util.spec_from_file_location("qa_cluster_api_inventory", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["qa_cluster_api_inventory"] = module
    spec.loader.exec_module(module)

    def forbidden(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("K8s call must not happen")

    module._k8s = forbidden
    return module


def event(path: str, method: str = "GET", alias: str = "platform-admin",
          params: dict[str, str] | None = None, body: Any = None) -> dict[str, Any]:
    return {
        "path": path, "httpMethod": method, "body": body,
        "queryStringParameters": params,
        "headers": {"origin": "https://portal.example.com"},
        "requestContext": {"identity": {
            "userArn": f"arn:aws:sts::111122223333:assumed-role/PortalInvokeRole/{alias}"}},
    }


def body_of(response: dict[str, Any]) -> dict[str, Any]:
    return json.loads(response["body"])


# --------------------------------------------------------------- objetos vivos

def rgd(name: str = "static-web-app", kind: str = "StaticWebApp") -> dict[str, Any]:
    return {"metadata": {"name": name}, "status": {"state": "Active"},
            "spec": {"schema": {"kind": kind, "apiVersion": "v1alpha1"},
                     "resources": [{"id": "bucket"}, {"id": "distribution"}]}}


def discovery(*pairs: tuple[str, str]) -> dict[str, Any]:
    return {"resources": [{"name": plural, "kind": kind, "verbs": ["list", "get"]}
                          for plural, kind in pairs]}


def instance(name: str = "hello-site", *, namespace: str = "appmod", kind: str = "StaticWebApp",
             generation: int | None = 2, observed: int | None = 2, ready: str | None = "True",
             state: str | None = "ACTIVE", status_extra: dict[str, Any] | None = None,
             annotations: dict[str, str] | None = None,
             labels: dict[str, str] | None = None) -> dict[str, Any]:
    metadata: dict[str, Any] = {"name": name, "namespace": namespace, "uid": "u-" + name,
                                "resourceVersion": "4242",
                                "creationTimestamp": "2026-10-15T12:00:00Z",
                                "labels": labels if labels is not None else {},
                                "annotations": annotations if annotations is not None else {}}
    if generation is not None:
        metadata["generation"] = generation
    status: dict[str, Any] = {}
    if observed is not None:
        status["observedGeneration"] = observed
    if state is not None:
        status["state"] = state
    if ready is not None:
        status["conditions"] = [{"type": "InstanceSynced", "status": ready, "reason": "Synced",
                                 "message": "all resources reconciled",
                                 "lastTransitionTime": "2026-10-15T12:05:00Z"}]
    status.update(status_extra or {})
    return {"apiVersion": "kro.run/v1alpha1", "kind": kind, "metadata": metadata, "status": status}


def kro_cluster(*items: dict[str, Any], plural: str = "staticwebapps",
                kind: str = "StaticWebApp", capability: str = "static-web-app") -> dict[str, Any]:
    """Cluster mínimo: um RGD, a discovery dele, a lista do plural e cada objeto.

    A rota de objeto único é registrada por nome porque o fake casa por PREFIXO:
    sem ela, `.../staticwebapps/hello-site` casaria com a rota da LISTA e o
    detalhe receberia um payload de lista em vez do objeto.
    """
    routes: dict[str, Any] = {
        RGD_PATH: {"items": [rgd(capability, kind)]},
        KRO: discovery((plural, kind)),
        f"{KRO}/{plural}": {"items": list(items)},
        f"{KRO}/namespaces/appmod/{plural}": {"items": list(items)},
        ARGO_INSTANCES: {"status": {"sync": {"status": "Synced", "revision": "abc123"},
                                    "health": {"status": "Healthy"}, "resources": []}},
    }
    for item in items:
        namespace = item["metadata"].get("namespace", "appmod")
        routes[f"{KRO}/namespaces/{namespace}/{plural}/{item['metadata']['name']}"] = item
    return routes


# ======================================================= #8 listagem live (I-A)

def test_capabilities_come_from_live_rgd_not_from_a_fixture(api):
    api._k8s = _Fake(kro_cluster())
    status, payload = api._capabilities_view({})
    assert status == 200
    [capability] = [row for row in payload["capabilities"] if row["engine"] == "kro"]
    assert capability["capability"] == "static-web-app"
    assert capability["kind"] == "StaticWebApp"
    assert capability["basePath"] == f"{KRO}/staticwebapps"
    assert capability["listable"] is True
    assert payload["partial"] is False


def test_capability_without_discovery_plural_is_visible_but_not_listable(api):
    """Controle pareado do teste acima: sem o plural, o item aparece com listable false.

    Desaparecer em silêncio seria o erro de origem virando lista vazia.
    """
    api._k8s = _Fake({RGD_PATH: {"items": [rgd()]}, KRO: discovery()})
    status, payload = api._capabilities_view({"engine": "kro"})
    assert status == 200
    [capability] = payload["capabilities"]
    assert capability["listable"] is False and capability["basePath"] == ""
    assert payload["partial"] is False


def test_instances_lists_live_objects_with_state_and_synced(api):
    api._k8s = _Fake(kro_cluster(instance("hello-site"), instance("tour-site")))
    status, payload = api._instances_view({"capability": "static-web-app"})
    assert status == 200
    assert [row["name"] for row in payload["items"]] == ["hello-site", "tour-site"]
    assert payload["total"] == 2
    row = payload["items"][0]
    assert row["state"] == "ACTIVE" and row["synced"] == "True" and row["ready"] is True
    assert row["capability"] == "static-web-app" and row["engine"] == "kro"
    assert payload["partial"] is False and payload["kinds"] == ["StaticWebApp"]


def test_source_error_is_reported_and_never_an_empty_list(api):
    """I-A: a fonte falhou, então `partial` é true e o erro vem nomeado."""
    routes = kro_cluster()
    routes[f"{KRO}/staticwebapps"] = _http_error(403)
    api._k8s = _Fake(routes)
    status, payload = api._instances_view({"capability": "static-web-app"})
    assert status == 200
    assert payload["partial"] is True
    assert payload["items"] == []
    assert {"source": "static-web-app:StaticWebApp", "ok": False, "error": "http_403"} in payload["sources"]


def test_every_source_failing_is_502_not_an_empty_success(api):
    """Controle pareado: nenhuma fonte legível NÃO pode responder 200 com items []."""
    api._k8s = _Fake({RGD_PATH: _http_error(503), KRO: _http_error(503)})
    status, payload = api._instances_view({})
    assert status == 502
    assert "items" not in payload and payload["partial"] is True


def test_unknown_capability_is_404_not_an_empty_page(api):
    api._k8s = _Fake(kro_cluster())
    status, payload = api._instances_view({"capability": "does-not-exist"})
    assert status == 404
    assert "not found" in payload["error"]


def test_empty_capability_with_readable_source_is_a_real_empty_list(api):
    """Par do I-A pelo outro lado: vazio de verdade é 200, partial false."""
    api._k8s = _Fake(kro_cluster())
    status, payload = api._instances_view({"capability": "static-web-app"})
    assert status == 200 and payload["items"] == []
    assert payload["partial"] is False and payload["total"] == 0


# ------------------------------------------------- #8 filtros, ordem, paginação

def test_namespace_is_applied_on_the_server_url(api):
    """I-D: o namespace entra na URL do API server, não no browser."""
    fake = _Fake(kro_cluster(instance()))
    api._k8s = fake
    status, _ = api._instances_view({"capability": "static-web-app", "ns": "appmod"})
    assert status == 200
    assert f"{KRO}/namespaces/appmod/staticwebapps" in " ".join(fake.paths)


@pytest.mark.parametrize("bad", ["../etc", "Appmod", "ns/evil", "a" * 64, "ns?x=1"])
def test_invalid_namespace_is_refused_before_any_read(api, bad):
    api._k8s = _Fake({})  # qualquer leitura levanta 404 do fake e falharia o teste
    with pytest.raises(ValueError, match="invalid namespace"):
        api._instances_view({"capability": "static-web-app", "ns": bad})


def test_search_state_and_ready_filters_narrow_the_live_list(api):
    api._k8s = _Fake(kro_cluster(
        instance("alpha-site", state="ACTIVE"),
        instance("beta-site", state="FAILED", ready="False"),
    ))
    base = {"capability": "static-web-app"}
    assert [row["name"] for row in api._instances_view({**base, "q": "beta"})[1]["items"]] == ["beta-site"]
    assert [row["name"] for row in api._instances_view({**base, "state": "failed"})[1]["items"]] == ["beta-site"]
    assert [row["name"] for row in api._instances_view({**base, "ready": "true"})[1]["items"]] == ["alpha-site"]
    assert [row["name"] for row in api._instances_view({**base, "synced": "false"})[1]["items"]] == ["beta-site"]


def test_sort_and_order_are_server_side(api):
    api._k8s = _Fake(kro_cluster(instance("b-site"), instance("a-site")))
    ascending = api._instances_view({"capability": "static-web-app", "sort": "name"})[1]
    descending = api._instances_view({"capability": "static-web-app", "sort": "name", "order": "desc"})[1]
    assert [row["name"] for row in ascending["items"]] == ["a-site", "b-site"]
    assert [row["name"] for row in descending["items"]] == ["b-site", "a-site"]


def test_invalid_sort_is_refused(api):
    api._k8s = _Fake({})
    with pytest.raises(ValueError, match="invalid sort"):
        api._instances_view({"capability": "static-web-app", "sort": "../"})


def test_pagination_walks_the_whole_set_without_repeating(api):
    api._k8s = _Fake(kro_cluster(*(instance(f"site-{index:02d}") for index in range(5))))
    seen, cursor, pages = [], "", 0
    while True:
        status, payload = api._instances_view({"capability": "static-web-app", "limit": "2", "cursor": cursor})
        assert status == 200 and payload["total"] == 5
        seen.extend(row["name"] for row in payload["items"])
        pages += 1
        cursor = payload["page"]["nextCursor"]
        if not cursor:
            break
    assert pages == 3
    assert seen == sorted(seen) and len(set(seen)) == 5


def test_cursor_from_a_different_query_is_refused(api):
    """Cursor que atravessa consultas pagina um universo que ninguém pediu."""
    api._k8s = _Fake(kro_cluster(*(instance(f"site-{index}") for index in range(4))))
    cursor = api._instances_view({"capability": "static-web-app", "limit": "2"})[1]["page"]["nextCursor"]
    assert cursor
    with pytest.raises(ValueError, match="cursor"):
        api._instances_view({"capability": "static-web-app", "limit": "2", "q": "site-1", "cursor": cursor})


@pytest.mark.parametrize("bad", ["not-base64!!", "", "Zm9v"])
def test_garbage_cursor_never_silently_restarts_the_page(api, bad):
    api._k8s = _Fake(kro_cluster(instance()))
    if bad == "":
        assert api._instances_view({"capability": "static-web-app", "cursor": bad})[0] == 200
        return
    with pytest.raises(ValueError, match="cursor"):
        api._instances_view({"capability": "static-web-app", "cursor": bad})


def test_page_size_is_capped_and_validated(api):
    api._k8s = _Fake(kro_cluster(instance()))
    assert api._instances_view({"capability": "static-web-app", "limit": "9999"})[1]["page"]["limit"] == api.PAGE_SIZE_MAX
    with pytest.raises(ValueError, match="invalid limit"):
        api._instances_view({"capability": "static-web-app", "limit": "0"})
    with pytest.raises(ValueError, match="invalid limit"):
        api._instances_view({"capability": "static-web-app", "limit": "abc"})


def test_truncated_source_is_flagged(api):
    routes = kro_cluster()
    routes[f"{KRO}/staticwebapps"] = {"items": [instance()], "metadata": {"continue": "token"}}
    api._k8s = _Fake(routes)
    assert api._instances_view({"capability": "static-web-app"})[1]["truncated"] is True


def test_ack_groups_are_only_scanned_when_the_query_asks(api, monkeypatch):
    """Varrer todo grupo ACK em toda listagem pagaria discovery a cada request."""
    monkeypatch.setattr(api, "ACK_API_GROUPS", ("s3.services.k8s.aws",))
    fake = _Fake(kro_cluster(instance()))
    api._k8s = fake
    api._instances_view({})
    assert not any("s3.services.k8s.aws" in path for path in fake.paths)


def test_ack_capability_is_discovered_from_the_live_group(api, monkeypatch):
    monkeypatch.setattr(api, "ACK_API_GROUPS", ("s3.services.k8s.aws",))
    routes = kro_cluster()
    routes["/apis/s3.services.k8s.aws/v1alpha1"] = discovery(("buckets", "Bucket"))
    routes["/apis/s3.services.k8s.aws"] = {"preferredVersion": {"version": "v1alpha1"},
                                            "versions": [{"version": "v1alpha1"}]}
    routes["/apis/s3.services.k8s.aws/v1alpha1/buckets"] = {"items": [
        {"apiVersion": "s3.services.k8s.aws/v1alpha1", "kind": "Bucket",
         "metadata": {"name": "appmod-bucket", "namespace": "appmod", "generation": 1},
         "status": {"observedGeneration": 1,
                    "conditions": [{"type": "ACK.ResourceSynced", "status": "True"}]}}]}
    api._k8s = _Fake(routes)
    status, payload = api._instances_view({"capability": "s3/buckets"})
    assert status == 200
    [row] = payload["items"]
    assert row["engine"] == "ack" and row["kind"] == "Bucket" and row["ready"] is True


# --- controles pareados do gate "404 na discovery é grupo ausente, não erro" ---
# O par existe porque afrouxar essa classificação é exatamente como se desliga um
# sinal sem perceber: se 403 também contasse como ausente, `partial` nunca mais
# acusaria falha de leitura e o aviso de degradado morreria em silêncio.

def test_absent_ack_controller_does_not_mark_the_answer_partial(api, monkeypatch):
    """404 na discovery = controller não instalado. Resposta definitiva, não falha."""
    monkeypatch.setattr(api, "ACK_API_GROUPS", ("s3.services.k8s.aws",))
    api._k8s = _Fake(kro_cluster())  # o fake levanta 404 para o grupo
    status, payload = api._capabilities_view({})
    assert status == 200 and payload["partial"] is False
    [source] = [row for row in payload["sources"] if row["source"].startswith("s3.")]
    assert source["ok"] is True and source["absent"] is True


def test_forbidden_ack_group_is_still_a_read_error(api, monkeypatch):
    """Controle: 403 é RBAC faltando, logo erro de origem e `partial` true."""
    monkeypatch.setattr(api, "ACK_API_GROUPS", ("s3.services.k8s.aws",))
    routes = kro_cluster()
    routes["/apis/s3.services.k8s.aws"] = _http_error(403)
    api._k8s = _Fake(routes)
    status, payload = api._capabilities_view({})
    assert status == 200 and payload["partial"] is True
    [source] = [row for row in payload["sources"] if row["source"].startswith("s3.")]
    assert source["ok"] is False and source["error"] == "http_403"
    assert "absent" not in source


def test_unreachable_ack_group_is_a_read_error(api, monkeypatch):
    monkeypatch.setattr(api, "ACK_API_GROUPS", ("s3.services.k8s.aws",))
    routes = kro_cluster()
    routes["/apis/s3.services.k8s.aws"] = urllib.error.URLError("timed out")
    api._k8s = _Fake(routes)
    payload = api._capabilities_view({})[1]
    [source] = [row for row in payload["sources"] if row["source"].startswith("s3.")]
    assert source["ok"] is False and source["error"] == "unreachable"


def test_capability_counts_are_opt_in_and_report_their_own_source(api):
    """`counts` custa uma lista por capability, então não entra por default."""
    fake = _Fake(kro_cluster(instance(), instance("second-site")))
    api._k8s = fake
    without = api._capabilities_view({"engine": "kro"})[1]
    assert "instances" not in without["capabilities"][0]
    with_counts = api._capabilities_view({"engine": "kro", "counts": "true"})[1]
    assert with_counts["capabilities"][0]["instances"] == 2
    assert any(row["source"] == "static-web-app:count" for row in with_counts["sources"])


def test_counts_of_an_unreadable_capability_is_none_not_zero(api):
    """Zero e "não deu para ler" são respostas diferentes: None preserva a distinção."""
    routes = kro_cluster()
    routes[f"{KRO}/staticwebapps"] = _http_error(403)
    api._k8s = _Fake(routes)
    payload = api._capabilities_view({"engine": "kro", "counts": "true"})[1]
    assert payload["capabilities"][0]["instances"] is None
    assert payload["partial"] is True


def test_detail_resolves_by_kind_when_capability_is_not_given(api):
    api._k8s = _Fake(kro_cluster(instance()))
    status, payload = api._instance_detail(
        {"kind": "StaticWebApp", "ns": "appmod", "name": "hello-site"}, is_admin=False)
    assert status == 200 and payload["capability"] == "static-web-app"


# ============================================= #9 Ready com prova (invariante B)

def test_ready_true_needs_condition_and_current_observed_generation(api):
    assert api._ready_state(instance(generation=3, observed=3, ready="True")) == {
        "ready": True, "readyBasis": "CONDITION_TRUE", "readyCondition": "InstanceSynced",
        "readyReason": "Synced", "generation": 3, "observedGeneration": 3, "statusStale": False}


@pytest.mark.parametrize(("kwargs", "basis"), [
    ({"ready": None}, "NO_READY_CONDITION"),
    ({"ready": "False"}, "CONDITION_FALSE"),
    ({"ready": "Unknown"}, "CONDITION_UNKNOWN"),
    ({"generation": 5, "observed": 3}, "STATUS_STALE"),
    ({"generation": 5, "observed": None}, "OBSERVED_GENERATION_MISSING"),
])
def test_ready_is_false_for_every_unproven_shape(api, kwargs, basis):
    """Controle pareado do teste acima: os cinco desvios NÃO podem virar Ready."""
    state = api._ready_state(instance(**kwargs))
    assert state["ready"] is False and state["readyBasis"] == basis


def test_stale_status_is_never_reported_as_ready_in_the_list(api):
    api._k8s = _Fake(kro_cluster(instance("stale-site", generation=7, observed=4)))
    [row] = api._instances_view({"capability": "static-web-app"})[1]["items"]
    assert row["ready"] is False and row["statusStale"] is True
    assert row["readyBasis"] == "STATUS_STALE"
    assert "GENERATION_LAG" in row["freshness"]["staleReasons"]


# ----------------------------------------------------------- #9 detalhe (I-B/C)

def test_instance_detail_returns_the_whole_contract(api):
    api._k8s = _Fake(kro_cluster(instance(
        annotations={"platform.appmod/request-id": "0" * 32,
                     "platform.appmod/mr-url": "https://github.com/aws-samples/sample-platform-engineering-foundations/-/merge_requests/41"},
        labels={"platform.appmod/requester": "platform-admin"},
        status_extra={"url": "https://d1.cloudfront.net", "distributionStatus": "Deployed"})))
    status, payload = api._instance_detail(
        {"capability": "static-web-app", "ns": "appmod", "name": "hello-site"}, is_admin=False)
    assert status == 200
    assert payload["kind"] == "StaticWebApp" and payload["apiVersion"] == "kro.run/v1alpha1"
    assert payload["metadata"]["name"] == "hello-site" and payload["metadata"]["uid"] == "u-hello-site"
    assert payload["generation"] == 2 and payload["observedGeneration"] == 2
    assert payload["ready"] is True and payload["readyBasis"] == "CONDITION_TRUE"
    assert payload["outputs"]["url"] == "https://d1.cloudfront.net"
    assert payload["conditions"][0]["type"] == "InstanceSynced"
    assert payload["conditions"][0]["ageSeconds"] is not None
    assert payload["freshness"]["stale"] is False
    assert payload["trail"]["request"]["requestId"] == "0" * 32
    assert payload["trail"]["mergeRequest"]["url"].startswith("https://github.com/")
    assert payload["trail"]["argo"]["sync"] == "Synced" and payload["trail"]["argo"]["readable"] is True
    assert payload["trail"]["resource"]["name"] == "hello-site"


def test_detail_trail_omits_what_the_object_does_not_carry(api):
    """Issue #9: trail "quando os dados existirem". Nada é inventado."""
    api._k8s = _Fake(kro_cluster(instance()))
    payload = api._instance_detail(
        {"capability": "static-web-app", "ns": "appmod", "name": "hello-site"}, is_admin=False)[1]
    assert payload["trail"]["request"] == {"requestId": None, "requester": None}
    assert payload["trail"]["mergeRequest"] is None


def test_detail_rejects_a_non_internal_merge_request_link(api):
    """Annotation é texto de terceiro: link arbitrário no detalhe é phishing na UI."""
    api._k8s = _Fake(kro_cluster(instance(
        annotations={"platform.appmod/mr-url": "https://evil.example.com/merge_requests/1"})))
    payload = api._instance_detail(
        {"capability": "static-web-app", "ns": "appmod", "name": "hello-site"}, is_admin=False)[1]
    assert payload["trail"]["mergeRequest"] is None


def test_detail_read_failure_is_an_error_never_ready_or_empty(api):
    routes = kro_cluster()
    routes[f"{KRO}/namespaces/appmod/staticwebapps/hello-site"] = _http_error(403)
    api._k8s = _Fake(routes)
    status, payload = api._instance_detail(
        {"capability": "static-web-app", "ns": "appmod", "name": "hello-site"}, is_admin=False)
    assert status == 502
    assert "ready" not in payload and payload["partial"] is True


def test_detail_missing_object_is_404(api):
    routes = kro_cluster()
    routes[f"{KRO}/namespaces/appmod/staticwebapps/ghost"] = _http_error(404)
    api._k8s = _Fake(routes)
    status, payload = api._instance_detail(
        {"capability": "static-web-app", "ns": "appmod", "name": "ghost"}, is_admin=False)
    assert status == 404 and payload["error"] == "instance not found"


def test_detail_requires_a_concrete_namespace_and_a_valid_name(api):
    api._k8s = _Fake({})
    with pytest.raises(ValueError, match="ns is required"):
        api._instance_detail({"capability": "static-web-app", "name": "hello-site"}, is_admin=False)
    with pytest.raises(ValueError, match="invalid instance name"):
        api._instance_detail({"capability": "static-web-app", "ns": "appmod", "name": "../x"}, is_admin=False)
    with pytest.raises(ValueError, match="kind or capability is required"):
        api._instance_detail({"ns": "appmod", "name": "hello-site"}, is_admin=False)


def test_conditions_are_ordered_by_relevance_problem_first(api):
    api._k8s = _Fake(kro_cluster(instance(status_extra={"conditions": [
        {"type": "InstanceSynced", "status": "True", "lastTransitionTime": "2026-10-15T12:00:00Z"},
        {"type": "SomethingElse", "status": "True", "lastTransitionTime": "2026-10-15T12:00:00Z"},
        {"type": "ACK.Terminal", "status": "True", "message": "bad spec",
         "lastTransitionTime": "2026-10-15T12:10:00Z"},
    ]})))
    payload = api._instance_detail(
        {"capability": "static-web-app", "ns": "appmod", "name": "hello-site"}, is_admin=False)[1]
    assert [row["type"] for row in payload["conditions"]][0] == "ACK.Terminal"


def test_condition_with_fractional_timestamp_still_gets_an_age(api):
    """_epoch não parseia fração; sem _epoch_any a idade sairia None e viraria "sem idade"."""
    rows = api._condition_rows(
        {"conditions": [{"type": "Ready", "status": "True",
                         "lastTransitionTime": "2026-10-15T12:00:00.123456Z"}]}, now=1_760_000_000)
    assert rows[0]["ageSeconds"] is not None


# ============================================ I-C sanitização (nada de segredo)

def test_safe_outputs_keep_the_useful_and_drop_the_sensitive(api):
    outputs = api._safe_outputs({
        "url": "https://d1.cloudfront.net",
        "distributionStatus": "Deployed",
        "bucketName": "appmod-site-111122223333",
        "replicas": 3,
        "enabled": True,
        "secretArn": "arn:aws:secretsmanager:sa-east-1:111122223333:secret:db-AbCdEf",
        "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
        "dbPassword": "hunter2",
        "sessionToken": "abc",
        "clientSecret": "s3cr3t",
        "conditions": [{"type": "Ready"}],
        "nested": {"keep": "out"},
    })
    assert outputs == {"url": "https://d1.cloudfront.net", "distributionStatus": "Deployed",
                       "bucketName": "appmod-site-111122223333", "replicas": "3",
                       "enabled": "true",
                       "secretArn": "arn:aws:secretsmanager:sa-east-1:111122223333:secret:db-AbCdEf"}


@pytest.mark.parametrize("value", [
    "AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN RSA PRIVATE KEY-----MIIEpAIBAAKC",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
    "glpat-xxxxxxxxxxxxxxxxxxxx",
    "postgres://admin:hunter2@db.internal:5432/app",
])
def test_credential_shaped_value_is_dropped_even_with_a_clean_key_name(api, value):
    """Par do teste acima: nome de chave limpo não basta, a FORMA do valor também nega."""
    assert api._safe_outputs({"endpoint": value}) == {}


def test_condition_message_carrying_a_credential_is_emptied_not_truncated(api):
    rows = api._condition_rows({"conditions": [
        {"type": "Ready", "status": "False", "reason": "AuthFailed",
         "message": "could not auth with AKIAIOSFODNN7EXAMPLE"}]}, now=1_760_000_000)
    assert rows[0]["message"] == "" and rows[0]["reason"] == "AuthFailed"


def test_listing_filters_labels_just_like_the_detail(api):
    """Regressão medida em 15/10/2026: _meta() devolve `labels` CRU.

    A listagem espalhava _meta() e saía com o label inteiro, enquanto o detalhe
    filtrava - I-C furada só num dos dois lados. O par é o label inócuo, que fica.
    """
    sensitive = instance("leaky-site", labels={
        "app.kubernetes.io/part-of": "appmod-agent-platform",
        "platform.appmod/api-token": "glpat-xxxxxxxxxxxxxxxxxxxx",
        "platform.appmod/requester": "platform-admin",
    })
    api._k8s = _Fake(kro_cluster(sensitive))
    [row] = api._instances_view({"capability": "static-web-app"})[1]["items"]
    assert "glpat-xxxxxxxxxxxxxxxxxxxx" not in json.dumps(row)
    assert "platform.appmod/api-token" not in row["labels"]
    assert row["labels"]["platform.appmod/requester"] == "platform-admin"
    detail = api._instance_detail(
        {"capability": "static-web-app", "ns": "appmod", "name": "leaky-site"}, is_admin=False)[1]
    assert row["labels"] == detail["metadata"]["labels"]


def test_detail_metadata_only_exposes_platform_annotations(api):
    api._k8s = _Fake(kro_cluster(instance(annotations={
        "platform.appmod/request-id": "0" * 32,
        "kubectl.kubernetes.io/last-applied-configuration": '{"spec":{"password":"hunter2"}}',
        "platform.appmod/api-key": "AKIAIOSFODNN7EXAMPLE",
    })))
    payload = api._instance_detail(
        {"capability": "static-web-app", "ns": "appmod", "name": "hello-site"}, is_admin=False)[1]
    annotations = payload["metadata"]["annotations"]
    assert list(annotations) == ["platform.appmod/request-id"]
    assert "hunter2" not in json.dumps(payload)


def test_no_route_of_the_inventory_reads_secrets(api):
    """Secret não é lido nem listado por estas rotas: nenhuma chamada a /secrets."""
    fake = _Fake(kro_cluster(instance(status_extra={"url": "https://x"})))
    api._k8s = fake
    api._capabilities_view({})
    api._instances_view({"capability": "static-web-app"})
    api._instance_detail({"capability": "static-web-app", "ns": "appmod", "name": "hello-site"}, is_admin=False)
    assert not any("secret" in path.lower() for path in fake.paths)


def test_whole_detail_payload_is_json_serializable_and_credential_free(api):
    api._k8s = _Fake(kro_cluster(instance(status_extra={
        "url": "https://d1.cloudfront.net", "roleSecret": "AKIAIOSFODNN7EXAMPLE"})))
    payload = api._instance_detail(
        {"capability": "static-web-app", "ns": "appmod", "name": "hello-site"}, is_admin=False)[1]
    rendered = json.dumps(payload)
    assert "AKIAIOSFODNN7EXAMPLE" not in rendered and "roleSecret" not in rendered


# ========================================== I-D autorização aplicada no backend

@pytest.mark.parametrize("route", ["/cluster/capabilities", "/cluster/instances", "/cluster/instance"])
def test_unauthorized_alias_is_refused_before_any_cluster_read(api, route):
    # `api._k8s` continua sendo o que levanta: um 403 que leu o cluster falha aqui.
    response = api.handler(event(route, alias="mallory"), None)
    assert response["statusCode"] == 403
    assert body_of(response)["error"] == "caller is not an authorized platform session"


@pytest.mark.parametrize("route", ["/cluster/capabilities", "/cluster/instances", "/cluster/instance"])
def test_wrong_role_in_the_arn_is_refused(api, route):
    bad = event(route)
    bad["requestContext"]["identity"]["userArn"] = \
        "arn:aws:sts::111122223333:assumed-role/OtherRole/platform-admin"
    assert api.handler(bad, None)["statusCode"] == 403


def test_non_admin_reads_the_inventory_and_the_detail(api):
    """Leitura é de todo alias autorizado; só a escrita exige admin."""
    api._k8s = _Fake(kro_cluster(instance()))
    listing = api.handler(event("/cluster/instances", alias="teammate",
                                params={"capability": "static-web-app"}), None)
    detail = api.handler(event("/cluster/instance", alias="teammate",
                               params={"capability": "static-web-app", "ns": "appmod",
                                       "name": "hello-site"}), None)
    assert listing["statusCode"] == 200 and detail["statusCode"] == 200
    assert body_of(detail)["actions"]["callerIsAdmin"] is False


def test_detail_reports_the_gate_but_never_is_the_gate(api):
    """Issue #9: nenhuma autorização vive só no botão.

    O detalhe informa `callerIsAdmin`; a recusa real acontece no POST governado,
    e o par abaixo prova que ela acontece sem passar pela UI.
    """
    api._k8s = _Fake(kro_cluster(instance()))
    detail = api.handler(event("/cluster/instance", alias="platform-admin",
                               params={"capability": "static-web-app", "ns": "appmod",
                                       "name": "hello-site"}), None)
    assert body_of(detail)["actions"]["callerIsAdmin"] is True
    assert body_of(detail)["actions"]["writePathForThisObject"] == "git-merge-request"


@pytest.mark.parametrize("route", ["/cluster/scale", "/cluster/restart", "/cluster/delete-pod"])
def test_day2_action_called_without_the_ui_is_refused_for_a_non_admin(api, route):
    """A API recusa ação de usuário não autorizado chamada direto (critério da #9)."""
    response = api.handler(event(route, "POST", alias="teammate",
                                 body='{"ns":"appmod","name":"hello-site"}'), None)
    assert response["statusCode"] == 403
    assert body_of(response)["error"] == "cluster operations require a platform admin"


def test_inventory_routes_are_read_only(api):
    """Nenhum verbo de escrita sai destas rotas: o fake levanta se vier POST/PATCH."""
    seen: list[str] = []

    def record(method: str, path: str, body: Any = None, **_: Any) -> Any:
        seen.append(method)
        return _Fake(kro_cluster(instance()))(method, path, body)

    api._k8s = record
    api._capabilities_view({"counts": "true"})
    api._instances_view({"capability": "static-web-app"})
    api._instance_detail({"capability": "static-web-app", "ns": "appmod", "name": "hello-site"}, is_admin=True)
    assert set(seen) == {"GET"}


def test_post_to_an_inventory_route_is_not_a_write_path(api):
    api._k8s = _Fake(kro_cluster(instance()))
    response = api.handler(event("/cluster/instances", "POST", alias="platform-admin", body="{}"), None)
    assert response["statusCode"] in (400, 404)


# ========================================================== handler, fim a fim

def test_handler_wires_the_three_routes_and_keeps_platform_untouched(api):
    api._k8s = _Fake(kro_cluster(instance()))
    for route, params in (("/cluster/capabilities", None),
                          ("/cluster/instances", {"capability": "static-web-app"}),
                          ("/cluster/instance", {"capability": "static-web-app", "ns": "appmod",
                                                 "name": "hello-site"}),
                          ("/cluster/platform", None)):
        response = api.handler(event(route, params=params), None)
        assert response["statusCode"] == 200, route
        assert response["headers"]["Cache-Control"] == "no-store"


def test_handler_turns_an_invalid_query_into_400_with_no_stack(api):
    api._k8s = _Fake(kro_cluster(instance()))
    response = api.handler(event("/cluster/instances", params={"ns": "../etc"}), None)
    assert response["statusCode"] == 400
    assert body_of(response)["error"] == "invalid namespace"
    assert "Traceback" not in response["body"]


def test_platform_view_contract_is_unchanged_by_this_work(api):
    """Guarda de regressão: FirstRun e o ClusterExplorer leem /cluster/platform."""
    api._k8s = _Fake(kro_cluster(instance(status_extra={"url": "https://d1.cloudfront.net"})))
    view = api._platform_view()
    assert set(view) == {"rgds", "instances"}
    [found] = view["instances"]
    assert found["outputs"]["url"] == "https://d1.cloudfront.net"
    assert found["synced"] == "True" and found["state"] == "ACTIVE"


def test_argo_state_keeps_its_agent_builder_behaviour(api):
    """A generalização de _argo_state não pode mudar o alvo do Agent Builder."""
    agents_app = "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/agent-platform-agents"
    api._k8s = _Fake({agents_app: {"status": {
        "sync": {"status": "Synced", "revision": "deadbeef"}, "health": {"status": "Healthy"},
        "resources": [{"kind": "Agent", "name": "ab-pod-health"}]}}})
    argo, names, readable = api._argo_state()
    assert argo == {"application": "agent-platform-agents", "sync": "Synced",
                    "health": "Healthy", "revision": "deadbeef"}
    assert names == {"ab-pod-health"} and readable is True


# ------------------------------------------- #9 trilha: proveniência e rastreio do Argo

PLAN_ID = "a" * 32


def _trail(api, routes):
    api._k8s = _Fake(routes)
    status, payload = api._instance_detail(
        {"capability": "static-web-app", "ns": "appmod", "name": "hello-site"}, is_admin=False)
    assert status == 200
    return payload["trail"]


def test_trail_tracks_against_the_instances_application_it_read(api):
    """Finding live 22/10: sync/health lidos da Application e mesmo assim "não rastreado".

    A marca do Argo era comparada com a Application do Agent Builder. Par: label da
    Application das instâncias -> rastreado e com arquivo GitOps; sem marca -> não.
    """
    marked = _trail(api, kro_cluster(instance(labels={"app.kubernetes.io/instance": "agent-platform-instances"})))
    assert marked["argo"]["readable"] is True and marked["argo"]["tracked"] is True
    assert marked["gitopsPath"] == "platform/instances/hello-site.yaml"

    unmarked = _trail(api, kro_cluster(instance()))
    assert unmarked["argo"]["readable"] is True and unmarked["argo"]["tracked"] is False
    assert unmarked["gitopsPath"] is None


def test_trail_tracking_also_comes_from_the_application_resource_list(api):
    """Plano B do rastreio: a lista de recursos da Application, quando legível."""
    routes = kro_cluster(instance())
    routes[ARGO_INSTANCES] = {"status": {"sync": {"status": "Synced"}, "health": {"status": "Healthy"},
                                         "resources": [{"kind": "StaticWebApp", "name": "hello-site"}]}}
    trail = _trail(api, routes)
    assert trail["argo"]["tracked"] is True and trail["gitopsPath"] == "platform/instances/hello-site.yaml"

    routes[ARGO_INSTANCES] = {"status": {"resources": [{"kind": "OtherKind", "name": "hello-site"}]}}
    assert _trail(api, routes)["argo"]["tracked"] is False


def test_trail_gitops_path_only_for_the_instances_application(api):
    """Objeto de OUTRA Application é rastreado por ela, mas não vem de platform/instances."""
    other = "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/agent-platform-agents"
    routes = kro_cluster(instance(annotations={
        "argocd.argoproj.io/tracking-id": "agent-platform-agents:kro.run/StaticWebApp:appmod/hello-site"}))
    routes[other] = {"status": {"sync": {"status": "Synced"}, "health": {"status": "Healthy"}}}
    trail = _trail(api, routes)
    assert trail["argo"]["trackedBy"] == "agent-platform-agents" and trail["argo"]["tracked"] is True
    assert trail["gitopsPath"] is None


def test_trail_carries_the_assistant_plan_provenance(api):
    """plan-id/plan-step do planner viram o elo do pedido; o par incompleto ou fora da forma não."""
    trail = _trail(api, kro_cluster(instance(labels={
        "platform.appmod/plan-id": PLAN_ID, "platform.appmod/plan-step": "site"})))
    assert trail["plan"] == {"planId": PLAN_ID, "step": "site"}

    for labels in ({"platform.appmod/plan-id": PLAN_ID},
                   {"platform.appmod/plan-id": "../../x", "platform.appmod/plan-step": "site"},
                   {"platform.appmod/plan-id": PLAN_ID, "platform.appmod/plan-step": "Site/../x"}):
        assert _trail(api, kro_cluster(instance(labels=labels)))["plan"] is None


# ================================================ grafo nativo da composição kro

def graph_rgd(name: str = "static-web-app", *, cycle: bool = False) -> dict[str, Any]:
    """RGD com quatro recursos em três camadas, outputs e um includeWhen vindo do schema."""
    distribution_origin = "${bucketPolicy.status.x}" if cycle else "${bucket.status.ackResourceMetadata.arn}"
    return {
        "metadata": {"name": name},
        "status": {"state": "Active", "topologicalOrder": ["bucket", "oac", "distribution", "bucketPolicy"]},
        "spec": {
            "schema": {"kind": "StaticWebApp", "apiVersion": "v1alpha1",
                       "spec": {"name": "string"},
                       "status": {"url": "https://${distribution.status.domainName}",
                                  "bucketName": "${bucket.spec.name}",
                                  "fixed": "constant"}},
            "resources": [
                {"id": "distribution",
                 "template": {"apiVersion": "cloudfront.services.k8s.aws/v1alpha1", "kind": "Distribution",
                              "spec": {"origins": [{"domainName": distribution_origin, "oac": "${oac.status.id}"}]}},
                 "readyWhen": ["${distribution.status.status == 'Deployed'}"]},
                {"id": "bucket",
                 "template": {"apiVersion": "s3.services.k8s.aws/v1alpha1", "kind": "Bucket",
                              "spec": {"name": "${schema.spec.name}"}}},
                {"id": "oac",
                 "template": {"apiVersion": "cloudfront.services.k8s.aws/v1alpha1", "kind": "OriginAccessControl",
                              "spec": {"name": "${schema.spec.name}-oac"}},
                 "includeWhen": ["${schema.spec.name != ''}"]},
                {"id": "bucketPolicy",
                 "template": {"apiVersion": "s3.services.k8s.aws/v1alpha1", "kind": "BucketPolicy",
                              "spec": {"bucket": "${bucket.spec.name}", "policy": "${distribution.status.id}"}}},
            ],
        },
    }


def test_rgd_graph_is_derived_from_the_spec_and_is_deterministic(api):
    graph = api._rgd_graph(graph_rgd())
    assert [node["id"] for node in graph["nodes"]] == ["distribution", "bucket", "oac", "bucketPolicy"]
    # Camadas: quem só depende do schema vem primeiro; desempate é alfabético.
    assert graph["layers"] == [["bucket", "oac"], ["distribution"], ["bucketPolicy"]]
    assert graph["cycle"] == []
    assert {(e["from"], e["to"]) for e in graph["edges"]} == {
        ("bucket", "distribution"), ("oac", "distribution"), ("bucket", "bucketPolicy"), ("distribution", "bucketPolicy")}
    by_id = {node["id"]: node for node in graph["nodes"]}
    # A autorreferência do readyWhen NÃO vira aresta, e o schema conta como uso da instância, não como nó.
    assert by_id["distribution"]["dependsOn"] == ["bucket", "oac"]
    assert by_id["distribution"]["readyWhen"] == 1 and by_id["oac"]["includeWhen"] == 1
    assert by_id["bucket"]["usesSchema"] is True and by_id["bucketPolicy"]["usesSchema"] is False
    assert by_id["bucket"]["kind"] == "Bucket" and by_id["bucket"]["apiVersion"] == "s3.services.k8s.aws/v1alpha1"
    assert graph["outputs"] == [{"name": "bucketName", "from": ["bucket"]}, {"name": "fixed", "from": []},
                                {"name": "url", "from": ["distribution"]}]
    assert graph["controllerOrder"] == ["bucket", "oac", "distribution", "bucketPolicy"]
    # Mesmo spec, mesmo grafo: a ordem dos recursos no YAML não muda o desenho.
    shuffled = graph_rgd()
    shuffled["spec"]["resources"].reverse()
    assert api._rgd_graph(shuffled)["layers"] == graph["layers"]


def test_rgd_graph_reports_a_cycle_instead_of_dropping_nodes(api):
    graph = api._rgd_graph(graph_rgd(cycle=True))
    assert graph["layers"] == [["bucket", "oac"]]
    assert graph["cycle"] == ["bucketPolicy", "distribution"]
    assert len(graph["nodes"]) == 4


def test_rgd_graph_handles_external_refs_and_empty_specs(api):
    graph = api._rgd_graph({"metadata": {"name": "x"}, "spec": {"schema": {"kind": "X"}, "resources": [
        {"id": "vpc", "externalRef": {"apiVersion": "ec2.services.k8s.aws/v1alpha1", "kind": "VPC",
                                      "metadata": {"name": "shared-vpc"}}},
        {"id": "subnet", "template": {"kind": "Subnet", "spec": {"vpcID": "${vpc.status.vpcID}"}}}]}})
    assert graph["nodes"][0]["external"] is True and graph["nodes"][0]["kind"] == "VPC"
    assert graph["layers"] == [["vpc"], ["subnet"]] and graph["state"] == "Unknown"
    assert api._rgd_graph({})["nodes"] == [] and api._rgd_graph({})["layers"] == []


def test_rgd_graph_endpoint_reads_one_definition(api):
    fake = _Fake({f"{RGD_PATH}/static-web-app": graph_rgd()})
    api._k8s = fake
    response = api.handler(event("/cluster/rgd-graph", params={"name": "static-web-app"}), None)
    assert response["statusCode"] == 200
    body = body_of(response)
    assert body["name"] == "static-web-app" and body["kind"] == "StaticWebApp"
    assert body["layers"] == [["bucket", "oac"], ["distribution"], ["bucketPolicy"]]
    assert body["sources"] == [{"source": "kro.run/resourcegraphdefinitions/static-web-app", "ok": True, "error": ""}]
    assert fake.paths == [f"{RGD_PATH}/static-web-app"]


def test_rgd_graph_endpoint_distinguishes_missing_from_unreadable(api):
    api._k8s = _Fake({f"{RGD_PATH}/ghost": _http_error(404)})
    assert api.handler(event("/cluster/rgd-graph", params={"name": "ghost"}), None)["statusCode"] == 404
    api._k8s = _Fake({f"{RGD_PATH}/locked": _http_error(403)})
    denied = api.handler(event("/cluster/rgd-graph", params={"name": "locked"}), None)
    assert denied["statusCode"] == 502 and body_of(denied)["sources"][0]["error"] == "http_403"
    bad = api.handler(event("/cluster/rgd-graph", params={"name": "Not Valid!"}), None)
    assert bad["statusCode"] == 400


def test_instance_detail_carries_the_native_composition_graph(api):
    routes = kro_cluster(instance())
    routes[f"{RGD_PATH}/static-web-app"] = graph_rgd()
    api._k8s = _Fake(routes)
    response = api.handler(event("/cluster/instance", params={
        "ns": "appmod", "name": "hello-site", "capability": "static-web-app"}), None)
    body = body_of(response)
    assert response["statusCode"] == 200
    assert body["composition"]["layers"] == [["bucket", "oac"], ["distribution"], ["bucketPolicy"]]
    assert {"source": "kro.run/resourcegraphdefinitions/static-web-app", "ok": True, "error": ""} in body["sources"]
    assert body["partial"] is False


def test_instance_detail_marks_unreadable_rgd_as_a_failed_source_not_an_empty_graph(api):
    routes = kro_cluster(instance())
    routes[f"{RGD_PATH}/static-web-app"] = _http_error(403)
    api._k8s = _Fake(routes)
    body = body_of(api.handler(event("/cluster/instance", params={
        "ns": "appmod", "name": "hello-site", "capability": "static-web-app"}), None))
    assert body["composition"] is None
    assert body["partial"] is True
    assert any(s["source"].endswith("/static-web-app") and s["error"] == "http_403" for s in body["sources"])


# ========================================= página de Composições (fatia 2)


def test_schema_fields_parse_simpleschema_markers_and_nested_objects(api):
    fields = api._schema_fields({
        "name": "string | required=true description=\"Bucket name\"",
        "replicas": "integer | default=2 minimum=1",
        "tags": {"team": "string | default=\"platform\"", "env": "string"},
        "enabled": "boolean",
    })
    by_path = {field["path"]: field for field in fields}
    assert list(by_path) == ["enabled", "name", "replicas", "tags", "tags.env", "tags.team"]
    assert by_path["name"] == {"path": "name", "type": "string", "required": True, "default": None,
                               "description": "Bucket name", "markers": {}}
    assert by_path["replicas"]["default"] == "2" and by_path["replicas"]["markers"] == {"minimum": "1"}
    assert by_path["tags"]["type"] == "object" and by_path["tags.team"]["default"] == "platform"
    assert by_path["enabled"] == {"path": "enabled", "type": "boolean", "required": False, "default": None,
                                  "description": "", "markers": {}}
    assert api._schema_fields("not a dict") == [] and api._schema_fields(None) == []


def test_rgds_lists_every_definition_with_graph_schema_and_instance_health(api):
    routes = kro_cluster(instance("hello-site"), instance("broken-site", ready="False"))
    second = rgd("dynamodb-table", "DynamoTable")
    second["spec"]["schema"]["spec"] = {"tableName": "string | required=true"}
    routes[RGD_PATH] = {"items": [graph_rgd(), second]}
    api._k8s = _Fake(routes)
    response = api.handler(event("/cluster/rgds", params={"ns": "_all"}), None)
    body = body_of(response)
    assert response["statusCode"] == 200
    assert [item["name"] for item in body["items"]] == ["dynamodb-table", "static-web-app"]
    web = body["items"][1]
    assert web["kind"] == "StaticWebApp" and web["apiVersion"] == "kro.run/v1alpha1" and web["state"] == "Active"
    assert web["graph"]["layers"] == [["bucket", "oac"], ["distribution"], ["bucketPolicy"]]
    assert web["schema"]["spec"] == [{"path": "name", "type": "string", "required": False, "default": None,
                                      "description": "", "markers": {}}]
    assert web["schema"]["status"] == ["bucketName", "fixed", "url"]
    assert web["listable"] is True and web["plural"] == "staticwebapps"
    assert web["instances"] == {"total": 2, "ready": 1, "notReady": 1, "truncated": False, "error": ""}
    # Definição sem plural na discovery: visível, sem contagem, nunca omitida.
    table = body["items"][0]
    assert table["listable"] is False and table["instances"] is None
    assert table["schema"]["spec"][0]["required"] is True
    assert body["partial"] is False and body["total"] == 2


def test_rgds_marks_a_failed_instance_source_instead_of_counting_zero(api):
    routes = kro_cluster(instance())
    routes[f"{KRO}/staticwebapps"] = _http_error(403)
    api._k8s = _Fake(routes)
    body = body_of(api.handler(event("/cluster/rgds"), None))
    item = body["items"][0]
    assert item["instances"]["total"] is None and item["instances"]["error"] == "http_403"
    assert body["partial"] is True
    assert {"source": "static-web-app:instances", "ok": False, "error": "http_403"} in body["sources"]


def test_rgds_is_502_when_the_definitions_cannot_be_read(api):
    api._k8s = _Fake({RGD_PATH: _http_error(503), KRO: discovery()})
    response = api.handler(event("/cluster/rgds"), None)
    assert response["statusCode"] == 502
    assert body_of(response)["partial"] is True


# ============================================================= ownership-model (owner no objeto)
def test_owner_comes_from_the_label_then_spec_and_is_searchable(api):
    labeled = instance("by-label", labels={"platform.appmod/owner": "team-x"}, status_extra={})
    labeled["spec"] = {"owner": "ignored-when-label-present"}
    by_spec = instance("by-spec")
    by_spec["spec"] = {"owner": "platform-admin"}
    nobody = instance("nobody")
    api._k8s = _Fake(kro_cluster(labeled, by_spec, nobody))
    body = body_of(api.handler(event("/cluster/instances", params={"ns": "appmod"}), None))
    owners = {row["name"]: row["owner"] for row in body["items"]}
    assert owners == {"by-label": "team-x", "by-spec": "platform-admin", "nobody": ""}
    found = body_of(api.handler(event("/cluster/instances", params={"ns": "appmod", "q": "team-x"}), None))
    assert [row["name"] for row in found["items"]] == ["by-label"]
    detail = body_of(api.handler(event("/cluster/instance", params={"ns": "appmod", "name": "by-spec", "capability": "static-web-app"}), None))
    assert detail["owner"] == "platform-admin"


# ============================================================= scorecards-standards
TRACKING = "argocd.argoproj.io/tracking-id"


def _tracked_route(*names: str) -> dict[str, Any]:
    return {ARGO_INSTANCES: {"status": {"sync": {"status": "Synced", "revision": "abc"}, "health": {"status": "Healthy"},
                                        "resources": [{"kind": "StaticWebApp", "namespace": "appmod", "name": name} for name in names]}}}


def test_standards_file_in_git_loads_and_is_what_the_server_evaluates(api):
    assert api.STANDARDS is not None, api.STANDARDS_ERROR
    assert api.STANDARDS_ERROR == ""
    assert [rule["check"] for rule in api.STANDARDS["rules"]] and all(
        rule["check"] in api._SCORECARD_CHECKS for rule in api.STANDARDS["rules"])


def test_scorecard_levels_are_cumulative_and_evidence_is_text(api):
    gold = instance("gold", labels={"platform.appmod/owner": "team-x", "platform.appmod/project": "agent-platform",
                                    "platform.appmod/requester": "platform-admin"},
                    annotations={TRACKING: "agent-platform-instances:kro.run/StaticWebApp:appmod/gold"})
    gold["spec"] = {"environment": "lab"}
    # Prata inteira, mas sem proveniência e sem label de projeto: fica em prata.
    silver = instance("silver", labels={"platform.appmod/owner": "team-x"},
                      annotations={TRACKING: "agent-platform-instances:kro.run/StaticWebApp:appmod/silver"})
    silver["spec"] = {"environment": "lab"}
    # Regras de ouro todas OK mas sem owner: bronze falha, então o nível é "none", não ouro.
    orphan = instance("orphan", labels={"platform.appmod/project": "agent-platform", "platform.appmod/plan-id": "p1"},
                      annotations={TRACKING: "agent-platform-instances:kro.run/StaticWebApp:appmod/orphan"})
    orphan["spec"] = {"environment": "lab"}
    api._k8s = _Fake(kro_cluster(gold, silver, orphan))
    body = body_of(api.handler(event("/cluster/instances", params={"ns": "appmod"}), None))
    cards = {row["name"]: row["scorecard"] for row in body["items"]}
    assert cards["gold"] == {"level": "gold", "passed": 7, "total": 7}
    assert cards["silver"] == {"level": "silver", "passed": 5, "total": 7}
    assert cards["orphan"]["level"] == "none" and cards["orphan"]["passed"] == 6
    detail = body_of(api.handler(event("/cluster/instance", params={"ns": "appmod", "name": "orphan", "capability": "static-web-app"}), None))
    failed = [rule for rule in detail["scorecard"]["rules"] if not rule["passed"]]
    assert [rule["id"] for rule in failed] == ["owner-declared"]
    assert failed[0]["evidence"] == "no owner label or spec.owner"
    assert all(isinstance(rule["evidence"], str) and rule["evidence"] for rule in detail["scorecard"]["rules"])


def test_gitops_rule_uses_the_argo_resource_list_when_the_object_has_no_mark(api):
    tracked = instance("tracked", labels={"platform.appmod/owner": "t"})
    loose = instance("loose", labels={"platform.appmod/owner": "t"})
    api._k8s = _Fake({**kro_cluster(tracked, loose), **_tracked_route("tracked")})
    body = body_of(api.handler(event("/cluster/scorecards", params={"ns": "appmod"}), None))
    gitops = {item["name"]: next(rule for rule in item["scorecard"]["rules"] if rule["id"] == "gitops-tracked")
              for item in body["items"]}
    assert gitops["tracked"]["passed"] is True
    assert gitops["loose"] == {"id": "gitops-tracked", "level": "silver", "passed": False, "evidence": "not tracked by Argo CD",
                               "title": "Managed by GitOps", "titlePt": "Gerido por GitOps"}


def test_a_tracking_mark_from_an_unknown_application_or_helm_instance_label_is_not_gitops(api):
    helm = instance("helm", labels={"platform.appmod/owner": "t", "app.kubernetes.io/instance": "my-chart"})
    foreign = instance("foreign", labels={"platform.appmod/owner": "t"}, annotations={TRACKING: "someone-else:kro.run/StaticWebApp:appmod/foreign"})
    api._k8s = _Fake(kro_cluster(helm, foreign))
    body = body_of(api.handler(event("/cluster/scorecards", params={"ns": "appmod"}), None))
    gitops = {item["name"]: next(rule for rule in item["scorecard"]["rules"] if rule["id"] == "gitops-tracked")["passed"] for item in body["items"]}
    assert gitops == {"helm": False, "foreign": False}


def test_unreadable_argo_makes_gitops_not_verifiable_never_a_pass(api):
    item = instance("x", labels={"platform.appmod/owner": "t"})
    routes = kro_cluster(item)
    routes[ARGO_INSTANCES] = _http_error(403)
    api._k8s = _Fake(routes)
    body = body_of(api.handler(event("/cluster/scorecards", params={"ns": "appmod"}), None))
    rule = next(rule for rule in body["items"][0]["scorecard"]["rules"] if rule["id"] == "gitops-tracked")
    assert rule["passed"] is False and rule["evidence"].startswith("not verifiable")
    assert body["argoReadable"] is False
    assert body["items"][0]["scorecard"]["level"] == "bronze"


def test_engine_scoped_rule_is_not_counted_against_other_engines(api):
    kro_rules = [rule for rule in api.STANDARDS["rules"] if rule.get("engines") == ["kro"]]
    assert kro_rules, "the standards file is expected to carry at least one kro-only rule"
    fake_ack = {"capability": "s3/buckets", "engine": "ack", "kind": "Bucket", "apiVersion": "s3.services.k8s.aws/v1alpha1",
                "plural": "buckets", "listable": True, "basePath": "/apis/s3.services.k8s.aws/v1alpha1/buckets"}
    card = api._scorecard({"kind": "Bucket", "metadata": {"name": "b", "labels": {}}, "status": {}}, fake_ack, False, True)
    assert all(rule["id"] not in {r["id"] for r in kro_rules} for rule in card["rules"])
    assert card["total"] == len(api.STANDARDS["rules"]) - len(kro_rules)


@pytest.mark.parametrize("document,reason", [
    ({"version": 2, "levels": ["bronze", "silver", "gold"], "rules": []}, "unsupported standards version"),
    ({"version": 1, "levels": ["bronze", "gold"], "rules": [{}]}, "levels must be exactly"),
    ({"version": 1, "levels": ["bronze", "silver", "gold"], "rules": [
        {"id": "a", "level": "bronze", "check": "magic", "title": "t", "titlePt": "t", "description": "d", "descriptionPt": "d"}]},
     "unknown check 'magic'"),
    ({"version": 1, "levels": ["bronze", "silver", "gold"], "rules": [
        {"id": "a", "level": "bronze", "check": "label", "title": "t", "titlePt": "t", "description": "d", "descriptionPt": "d"}]},
     "label needs a valid `key`"),
    ({"version": 1, "levels": ["bronze", "silver", "gold"], "rules": [
        {"id": "a", "level": "bronze", "check": "ready", "title": "t", "titlePt": "t", "description": "d", "descriptionPt": "d"},
        {"id": "a", "level": "gold", "check": "ready", "title": "t", "titlePt": "t", "description": "d", "descriptionPt": "d"}]},
     "duplicate rule id a"),
])
def test_invalid_standards_are_refused_with_the_reason(api, document, reason):
    assert reason in api._validate_standards(document)


def test_validator_refuses_a_level_without_a_rule_for_every_engine(api):
    base = {"version": 1, "levels": ["bronze", "silver", "gold"]}
    rule = lambda rid, level, **extra: {"id": rid, "level": level, "check": "ready", "title": "t", "titlePt": "t", "description": "d", "descriptionPt": "d", **extra}
    assert "level gold has no rule" in api._validate_standards({**base, "rules": [rule("a", "bronze"), rule("b", "silver")]})
    assert "engine ack" in api._validate_standards({**base, "rules": [rule("a", "bronze"), rule("b", "silver"), rule("c", "gold", engines=["kro"])]})
    assert api._validate_standards({**base, "rules": [rule("a", "bronze"), rule("b", "silver"), rule("c", "gold", engines=["kro"]), rule("d", "gold", engines=["ack"])]}) == ""


def test_invalid_standards_disable_scorecards_fail_closed(api, monkeypatch):
    monkeypatch.setattr(api, "STANDARDS", None)
    monkeypatch.setattr(api, "STANDARDS_ERROR", "standards invalid: unknown check 'magic'")
    api._k8s = _Fake(kro_cluster(instance("x")))
    body = body_of(api.handler(event("/cluster/instances", params={"ns": "appmod"}), None))
    assert body["items"][0]["scorecard"] is None
    response = api.handler(event("/cluster/scorecards", params={"ns": "appmod"}), None)
    assert response["statusCode"] == 503
    assert body_of(response)["error"] == "standards invalid: unknown check 'magic'"


def test_scorecards_view_aggregates_by_level_and_by_rule_and_names_failed_sources(api):
    good = instance("good", labels={"platform.appmod/owner": "t"}, annotations={TRACKING: "agent-platform-instances:kro.run/StaticWebApp:appmod/good"})
    good["spec"] = {"environment": "lab"}
    bad = instance("bad", ready="False")
    api._k8s = _Fake(kro_cluster(good, bad))
    body = body_of(api.handler(event("/cluster/scorecards", params={"ns": "appmod"}), None))
    assert body["summary"] == {"total": 2, "byLevel": {"none": 1, "bronze": 0, "silver": 1, "gold": 0}}
    assert [item["name"] for item in body["items"]] == ["bad", "good"]  # pior primeiro
    rules = {row["id"]: row for row in body["rules"]}
    assert rules["ready"] == {"id": "ready", "applicable": 2, "passed": 1}
    assert rules["owner-declared"] == {"id": "owner-declared", "applicable": 2, "passed": 1}
    assert [rule["id"] for rule in body["standards"]["rules"]] == [rule["id"] for rule in api.STANDARDS["rules"]]
    assert body["standards"]["rules"][0]["titlePt"] and body["partial"] is False
    # Fonte que falhou aparece nomeada, como no inventário, e nunca derruba a resposta inteira.
    routes = kro_cluster(good)
    routes[RGD_PATH] = {"items": [rgd("static-web-app", "StaticWebApp"), rgd("web-api", "WebApi")]}
    routes[KRO] = discovery(("staticwebapps", "StaticWebApp"), ("webapis", "WebApi"))
    routes[f"{KRO}/namespaces/appmod/webapis"] = _http_error(403)
    api._k8s = _Fake(routes)
    degraded = body_of(api.handler(event("/cluster/scorecards", params={"ns": "appmod"}), None))
    assert degraded["partial"] is True
    assert any(source["source"] == "web-api:WebApi" and not source["ok"] for source in degraded["sources"])
    assert degraded["summary"]["total"] == 1


def test_scorecards_route_is_project_scoped_like_the_inventory(api):
    assert "/cluster/scorecards" in api._SCOPED_NAMESPACED


def test_bundle_carries_the_standards_file():
    import subprocess
    import zipfile
    subprocess.run(["bash", str(REPO_ROOT / "backend/cluster_api/build.sh")], check=True, capture_output=True)
    names = set(zipfile.ZipFile(REPO_ROOT / "backend/cluster_api/.build/cluster-api.zip").namelist())
    assert "standards.json" in names
    shipped = json.loads(zipfile.ZipFile(REPO_ROOT / "backend/cluster_api/.build/cluster-api.zip").read("standards.json"))
    assert shipped == json.loads((REPO_ROOT / "platform/scorecards/standards.json").read_text(encoding="utf-8"))
