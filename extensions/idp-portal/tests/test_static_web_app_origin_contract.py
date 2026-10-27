"""Contrato da origem do CloudFront no GP-A (backlog gpa-ack-illegal-update).

O UpdateDistribution do ACK envia a config inteira e o CloudFront recusa a origem sem
CustomHeaders e sem OriginPath (IllegalUpdate). O controlador só manda CustomHeaders.Quantity
quando customHeaders existe no spec, então cada origem declara customHeaders.items (lista,
vazia vira Quantity 0) e originPath. A fixture é um recorte do CRD do ACK v1.9.1.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
RGD = ROOT / "platform/compositions/static-web-app-rgd.yaml"
CRD = json.loads((ROOT / "tests/fixtures/ack-cloudfront-distribution-origin.json").read_text())


def _origins() -> list[dict]:
    resources = yaml.safe_load(RGD.read_text())["spec"]["resources"]
    dists = [r["template"] for r in resources if r.get("template", {}).get("kind") == "Distribution"]
    assert dists, "o RGD precisa ter ao menos um Distribution"
    origins = [o for d in dists for o in d["spec"]["distributionConfig"]["origins"]["items"]]
    assert origins, "Distribution sem origem"
    return origins


ORIGINS = _origins()
IDS = [o["id"] for o in ORIGINS]


@pytest.mark.parametrize("origin", ORIGINS, ids=IDS)
def test_origin_declares_custom_headers_items_as_a_list(origin):
    headers = origin.get("customHeaders")
    assert isinstance(headers, dict), "sem customHeaders o ACK não envia Quantity e o update falha"
    assert isinstance(headers.get("items"), list)


@pytest.mark.parametrize("origin", ORIGINS, ids=IDS)
def test_origin_declares_origin_path(origin):
    assert isinstance(origin.get("originPath"), str)


@pytest.mark.parametrize("origin", ORIGINS, ids=IDS)
def test_origin_keys_exist_in_the_ack_crd(origin):
    assert set(origin) <= set(CRD["originProperties"])
    assert set(origin["customHeaders"]) <= set(CRD["customHeadersProperties"])
    assert set(origin.get("s3OriginConfig", {})) <= set(CRD["s3OriginConfigProperties"])


def test_fixture_has_no_quantity_field():
    # Se o ACK passar a expor quantity, o contrato muda e este teste avisa.
    assert "quantity" not in CRD["customHeadersProperties"]
