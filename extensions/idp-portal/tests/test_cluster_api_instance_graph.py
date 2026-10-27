"""cross-instance-graph: arestas entre instâncias por evidência (output consumido, nome, label, promoção)."""
from __future__ import annotations

import json
from typing import Any

from test_cluster_api_inventory import _Fake, api, event  # noqa: F401
from test_project_scope import platform_scope

CAP_TABLE = {"capability": "database/dynamodb", "kind": "DynamoDBTable", "engine": "kro", "plural": "dynamodbtables",
             "basePath": "/apis/kro.run/v1alpha1/dynamodbtables", "listable": True, "apiVersion": "kro.run/v1alpha1"}
CAP_APP = {"capability": "app/web", "kind": "WebApp", "engine": "kro", "plural": "webapps",
           "basePath": "/apis/kro.run/v1alpha1/webapps", "listable": True, "apiVersion": "kro.run/v1alpha1"}


def _item(kind: str, name: str, spec: dict[str, Any], outputs: dict[str, Any] | None = None, ns: str = "appmod",
          labels: dict[str, str] | None = None, annotations: dict[str, str] | None = None, ready: bool = True) -> dict[str, Any]:
    return {"apiVersion": "kro.run/v1alpha1", "kind": kind,
            "metadata": {"name": name, "namespace": ns, "uid": f"u-{name}", "generation": 1,
                         "labels": {"platform.appmod/owner": "team-x", **(labels or {})}, "annotations": annotations or {}},
            "spec": spec,
            "status": {"observedGeneration": 1, "state": "ACTIVE" if ready else "Reconciling",
                       "conditions": [{"type": "Ready", "status": "True" if ready else "False"}], **(outputs or {})}}


def _graph(api_module, items: list[tuple[dict[str, Any], dict[str, Any]]]):
    registry = platform_scope.load_registry()
    return api_module._instance_graph(items, registry.owner_of)


def test_output_consumed_by_a_spec_value_is_an_edge_with_the_exact_evidence(api):
    table = _item("DynamoDBTable", "orders", {"name": "appmod-orders"}, {"tableName": "appmod-orders", "tableArn": "arn:aws:dynamodb:x"})
    app = _item("WebApp", "shop", {"name": "appmod-shop", "tableName": "appmod-orders"})
    graph = _graph(api, [(table, CAP_TABLE), (app, CAP_APP)])
    assert [n["id"] for n in graph["nodes"]] == ["DynamoDBTable/appmod/orders", "WebApp/appmod/shop"]
    (edge,) = [e for e in graph["edges"] if e["relation"] == "consumes"]
    assert edge == {"from": "DynamoDBTable/appmod/orders", "to": "WebApp/appmod/shop", "relation": "consumes",
                    "evidence": "spec.tableName = orders.outputs.tableName"}
    assert graph["layers"] == [["DynamoDBTable/appmod/orders"], ["WebApp/appmod/shop"]] and graph["cycle"] == []
    assert graph["relations"] == {"consumes": 1, "declared": 0, "promoted-from": 0}
    # O próprio spec.name da tabela (igual ao output) NUNCA vira aresta para si mesma.
    assert all(e["from"] != e["to"] for e in graph["edges"])


def test_name_reference_and_declared_label_are_edges_short_values_are_not(api):
    table = _item("DynamoDBTable", "orders", {"name": "x"})
    app = _item("WebApp", "shop", {"source": "orders", "tag": "ord"}, labels={"platform.appmod/depends-on": "orders, missing"})
    graph = _graph(api, [(table, CAP_TABLE), (app, CAP_APP)])
    relations = {(e["relation"], e["evidence"]) for e in graph["edges"]}
    assert relations == {("consumes", "spec.source = orders (name)"), ("declared", "label platform.appmod/depends-on=orders")}
    # "missing" não existe no escopo: nenhuma aresta inventada, e "ord" (3 chars) não casa com nada.
    assert graph["nodes"][1]["dependsOn"] == ["DynamoDBTable/appmod/orders"]


def test_promoted_copy_points_to_its_source_even_when_the_source_is_outside_the_scope(api):
    copy = _item("WebApp", "shop-staging", {"name": "appmod-shop-staging"}, ns="appmod-staging",
                 annotations={"platform.appmod/promoted-from": "agent-platform/appmod/shop"})
    graph = _graph(api, [(copy, CAP_APP)])
    external = [n for n in graph["nodes"] if n["external"]]
    assert external == [{"id": "?/appmod/shop", "name": "shop", "namespace": "appmod", "kind": "", "capability": "", "engine": "",
                         "project": "agent-platform", "owner": "", "ready": None, "external": True, "dependsOn": []}]
    (edge,) = graph["edges"]
    assert edge["relation"] == "promoted-from" and edge["from"] == "?/appmod/shop" and edge["to"] == "WebApp/appmod-staging/shop-staging"
    assert graph["layers"] == [["?/appmod/shop"], ["WebApp/appmod-staging/shop-staging"]]
    # Com a origem no escopo, o nó é o real e não há externo.
    source = _item("WebApp", "shop", {"name": "appmod-shop"})
    graph = _graph(api, [(copy, CAP_APP), (source, CAP_APP)])
    assert not any(n["external"] for n in graph["nodes"]) and graph["edges"][0]["from"] == "WebApp/appmod/shop"


def test_cycle_is_reported_not_dropped(api):
    a = _item("WebApp", "alpha", {"peer": "beta"})
    b = _item("WebApp", "beta", {"peer": "alpha"})
    graph = _graph(api, [(a, CAP_APP), (b, CAP_APP)])
    assert graph["layers"] == [] and graph["cycle"] == ["WebApp/appmod/alpha", "WebApp/appmod/beta"]
    assert len(graph["edges"]) == 2


def test_route_is_scoped_reads_every_listable_capability_and_keeps_partial_named(api, monkeypatch):
    monkeypatch.setattr(api, "_request_scope", lambda *a, **k: None)
    monkeypatch.setattr(api, "_capability_index", lambda include_ack=True: ([CAP_TABLE, CAP_APP], []))
    table = _item("DynamoDBTable", "orders", {"name": "appmod-orders"}, {"tableName": "appmod-orders"})
    app = _item("WebApp", "shop", {"tableName": "appmod-orders"})
    api._k8s = _Fake({"/apis/kro.run/v1alpha1/namespaces/appmod/dynamodbtables": {"items": [table]},
                      "/apis/kro.run/v1alpha1/namespaces/appmod/webapps": {"items": [app]}})
    response = api.handler(event("/cluster/instance-graph", params={"ns": "appmod"}), None)
    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    assert body["namespace"] == "appmod" and body["partial"] is False and len(body["edges"]) == 1
    assert {s["source"] for s in body["sources"]} == {"database/dynamodb:DynamoDBTable", "app/web:WebApp"}
    # Uma fonte falhando: 200 com partial e o erro nomeado, nunca grafo "completo" em silêncio.
    api._k8s = _Fake({"/apis/kro.run/v1alpha1/namespaces/appmod/dynamodbtables": {"items": [table]}})
    body = json.loads(api.handler(event("/cluster/instance-graph", params={"ns": "appmod"}), None)["body"])
    assert body["partial"] is True and any(not s["ok"] for s in body["sources"])
    assert [n["id"] for n in body["nodes"]] == ["DynamoDBTable/appmod/orders"]


def test_namespace_outside_the_registry_never_enters_the_graph(api, monkeypatch):
    monkeypatch.setattr(api, "_request_scope", lambda *a, **k: None)
    monkeypatch.setattr(api, "_capability_index", lambda include_ack=True: ([CAP_APP], []))
    api._k8s = _Fake({"/apis/kro.run/v1alpha1/webapps": {"items": [_item("WebApp", "shop", {}), _item("WebApp", "sys", {}, ns="kube-system")]}})
    body = json.loads(api.handler(event("/cluster/instance-graph", params={"ns": "_all"}), None)["body"])
    assert [n["id"] for n in body["nodes"]] == ["WebApp/appmod/shop"]
