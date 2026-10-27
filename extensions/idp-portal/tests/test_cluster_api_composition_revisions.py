"""composition-revisions: GraphRevisions por RGD, filhos por instância e rollout da revisão ativa.

Modelo medido no cluster (kro v0.9.4, 26/10/2026): a instância não fixa revisão; o controller usa a
GraphRevision ativa mais recente. "Atrás" é inferência pelos FILHOS, que levam a label
`kro.run/graph-revision-hash`. Filho sem a label é desconhecido, nunca atrás.
"""
from __future__ import annotations

import urllib.parse
from typing import Any

from test_cluster_api_inventory import (  # noqa: F401  (fixtures e helpers do inventário)
    KRO, RGD_PATH, _Fake, _http_error, api, body_of, event, graph_rgd, instance, kro_cluster,
)

GR_PATH = "/apis/internal.kro.run/v1alpha1/graphrevisions"
S3 = "/apis/s3.services.k8s.aws/v1alpha1"
CF = "/apis/cloudfront.services.k8s.aws/v1alpha1"


def graph_revision(name: str, revision: int, generation: int, *, ready: bool = True, hash_: str | None = None) -> dict[str, Any]:
    return {
        "metadata": {"name": f"{name}-r{revision:05d}", "creationTimestamp": f"2026-10-{10 + revision:02d}T00:00:00Z",
                     "labels": {"kro.run/graph-revision-hash": hash_ or f"h{revision}"}},
        "spec": {"revision": revision, "snapshot": {"name": name, "generation": generation, "spec": {}}},
        "status": {"conditions": [{"type": "Ready", "status": "True" if ready else "False"}], "resources": [{}, {}]},
    }


def child(kind: str, name: str, *, node: str, instance_id: str, hash_: str | None, api_version: str = f"{S3[6:]}",
          policy: str | None = "retain") -> dict[str, Any]:
    labels = {"kro.run/instance-id": instance_id, "kro.run/node-id": node, "kro.run/instance-kind": "StaticWebApp",
              "kro.run/instance-name": "hello-site"}
    if hash_:
        labels["kro.run/graph-revision-hash"] = hash_
    annotations = {"services.k8s.aws/deletion-policy": policy} if policy else {}
    return {"apiVersion": api_version, "kind": kind,
            "metadata": {"name": name, "namespace": "appmod", "labels": labels, "annotations": annotations,
                         "generation": 1, "creationTimestamp": "2026-10-01T00:00:00Z"},
            "status": {"observedGeneration": 1, "conditions": [{"type": "ACK.ResourceSynced", "status": "True"}]}}


def with_children(routes: dict[str, Any], uid: str, children: list[dict[str, Any]], *, revisions: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    routes = dict(routes)
    routes[f"{RGD_PATH}/static-web-app"] = graph_rgd()
    routes[GR_PATH] = {"items": revisions if revisions is not None else []}
    routes[S3] = {"resources": [{"name": "buckets", "kind": "Bucket", "verbs": ["get", "list"]},
                                {"name": "bucketpolicies", "kind": "BucketPolicy", "verbs": ["get", "list"]}]}
    routes[CF] = {"resources": [{"name": "distributions", "kind": "Distribution", "verbs": ["get", "list"]},
                                {"name": "originaccesscontrols", "kind": "OriginAccessControl", "verbs": ["get", "list"]}]}

    def listing(kind: str):
        def handler(_method: str, path: str, _body: Any):
            selector = urllib.parse.unquote(path.split("labelSelector=", 1)[1].split("&", 1)[0]) if "labelSelector=" in path else ""
            key, _, value = selector.partition("=")
            rows = [c for c in children if c["kind"] == kind and (c["metadata"]["labels"].get(key) == value)]
            return {"items": rows}
        return handler
    for base, plural, kind in ((S3, "buckets", "Bucket"), (S3, "bucketpolicies", "BucketPolicy"),
                               (CF, "distributions", "Distribution"), (CF, "originaccesscontrols", "OriginAccessControl")):
        routes[f"{base}/namespaces/appmod/{plural}"] = listing(kind)
        routes[f"{base}/{plural}"] = listing(kind)
    return routes


def detail(api_module, routes):
    api_module._k8s = _Fake(routes)
    api_module._PLURALS.clear()
    return body_of(api_module.handler(event("/cluster/instance", params={"ns": "appmod", "name": "hello-site", "capability": "static-web-app"}), None))


def test_graph_revisions_group_by_rgd_newest_first_and_pick_the_latest_ready(api):
    api._k8s = _Fake({GR_PATH: {"items": [
        graph_revision("static-web-app", 1, 1), graph_revision("static-web-app", 3, 4, ready=False),
        graph_revision("static-web-app", 2, 3), graph_revision("other", 1, 1)]}})
    by_rgd, source = api._graph_revisions()
    assert source == {"source": "internal.kro.run/graphrevisions", "ok": True, "error": ""}
    assert [r["revision"] for r in by_rgd["static-web-app"]] == [3, 2, 1]
    summary = api._revision_summary({"status": {"lastIssuedRevision": 3}}, by_rgd["static-web-app"], "")
    assert summary["latest"]["revision"] == 2 and summary["latest"]["hash"] == "h2"
    assert summary["pending"]["revision"] == 3
    assert summary["lastIssued"] == 3


def test_missing_graphrevision_crd_is_a_definitive_answer_not_a_failed_source(api):
    api._k8s = _Fake({})
    by_rgd, source = api._graph_revisions()
    assert by_rgd == {}
    assert source["ok"] is True and source["absent"] is True and source["error"] == ""


def test_forbidden_graphrevision_list_is_a_named_error(api):
    api._k8s = _Fake({GR_PATH: _http_error(403)})
    _, source = api._graph_revisions()
    assert source["ok"] is False and source["error"] == "http_403"


def test_detail_lists_children_by_instance_id_with_deletion_policy_and_rollout_current(api):
    item = instance()
    uid = item["metadata"]["uid"]
    children = [child("Bucket", "b", node="bucket", instance_id=uid, hash_="h2"),
                child("Distribution", "d", node="distribution", instance_id=uid, hash_="h2", api_version=CF[6:], policy=None),
                child("Bucket", "stranger", node="bucket", instance_id="other-uid", hash_="h1")]
    body = detail(api, with_children(kro_cluster(item), uid, children,
                                     revisions=[graph_revision("static-web-app", 2, 3), graph_revision("static-web-app", 1, 1)]))
    assert [c["name"] for c in body["children"]] == ["b", "d"]
    assert body["children"][0]["deletionPolicy"] == "retain" and body["children"][1]["deletionPolicy"] is None
    assert all(c["onLatest"] is True for c in body["children"])
    assert "_instanceId" not in body["children"][0]
    assert body["revision"]["status"] == "current" and body["revision"]["latestRevision"] == 2
    assert body["revision"]["children"] == 2 and body["revision"]["onLatest"] == 2
    assert body["partial"] is False


def test_child_on_an_older_hash_marks_the_instance_behind(api):
    item = instance()
    uid = item["metadata"]["uid"]
    children = [child("Bucket", "b", node="bucket", instance_id=uid, hash_="h1"),
                child("Distribution", "d", node="distribution", instance_id=uid, hash_="h2", api_version=CF[6:])]
    body = detail(api, with_children(kro_cluster(item), uid, children, revisions=[graph_revision("static-web-app", 2, 3)]))
    assert body["revision"]["status"] == "behind"
    assert [c["onLatest"] for c in body["children"]] == [False, True]


def test_children_without_hash_are_unknown_never_behind(api):
    item = instance()
    uid = item["metadata"]["uid"]
    children = [child("Bucket", "b", node="bucket", instance_id=uid, hash_=None)]
    body = detail(api, with_children(kro_cluster(item), uid, children, revisions=[graph_revision("static-web-app", 2, 3)]))
    assert body["children"][0]["onLatest"] is None
    assert body["revision"]["status"] == "unknown"


def test_no_children_and_no_revisions_are_reported_as_such(api):
    item = instance()
    body = detail(api, with_children(kro_cluster(item), item["metadata"]["uid"], []))
    assert body["children"] == []
    assert body["revision"]["status"] == "no-children" and body["revision"]["latest"] is None


def test_forbidden_child_group_is_a_failed_source_not_an_empty_child_list(api):
    item = instance()
    uid = item["metadata"]["uid"]
    routes = with_children(kro_cluster(item), uid, [child("Bucket", "b", node="bucket", instance_id=uid, hash_="h2")])
    routes[CF] = _http_error(403)
    body = detail(api, routes)
    assert [c["name"] for c in body["children"]] == ["b"]
    failed = [s for s in body["sources"] if s["source"].startswith("children:cloudfront")]
    assert failed and all(s["ok"] is False and s["error"] == "http_403" for s in failed)
    assert body["partial"] is True


def test_rgds_view_carries_revisions_rollout_and_git_source(api):
    item = instance()
    uid = item["metadata"]["uid"]
    routes = with_children(kro_cluster(item), uid, [child("Bucket", "b", node="bucket", instance_id=uid, hash_="h2")],
                           revisions=[graph_revision("static-web-app", 2, 3), graph_revision("static-web-app", 1, 1)])
    routes[RGD_PATH] = {"items": [graph_rgd()]}
    api._k8s = _Fake(routes)
    api._PLURALS.clear()
    body = body_of(api.handler(event("/cluster/rgds", params={"ns": "appmod"}), None))
    row = body["items"][0]
    assert row["source"] == "platform/compositions/static-web-app-rgd.yaml"
    assert [r["revision"] for r in row["revisions"]["items"]] == [2, 1]
    assert row["revisions"]["latest"]["revision"] == 2
    assert row["rollout"] == [{"name": "hello-site", "namespace": "appmod",
                               "rollout": {"status": "current", "children": 1, "withHash": 1, "onLatest": 1, "latestRevision": 2}}]
    assert {"source": "internal.kro.run/graphrevisions", "ok": True, "error": ""} in body["sources"]
