"""Contract tests for platform/catalog capability packages."""
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "platform" / "catalog"
PACKAGES = sorted(p.parent for p in CATALOG.rglob("capability.yaml"))

REQUIRED_SPEC = {"displayName", "description", "owner", "engine", "pattern", "lifecycle", "deletionPolicy", "targetAccounts", "goldenPath"}
VALID_LIFECYCLES = {"available", "preview", "planned", "deprecated"}
VALID_ENGINES = {"ack", "kro", "hybrid", "crossplane"}


def test_catalog_has_packages():
    assert len(PACKAGES) >= 9


def test_every_capability_satisfies_the_contract():
    for pkg in PACKAGES:
        doc = yaml.safe_load((pkg / "capability.yaml").read_text())
        assert doc["apiVersion"] == "platform.appmod/v1", pkg
        assert doc["kind"] == "Capability", pkg
        meta, spec = doc["metadata"], doc["spec"]
        assert {"name", "domain", "version"} <= set(meta), pkg
        missing = REQUIRED_SPEC - set(spec)
        assert not missing, f"{pkg}: faltando {missing}"
        assert spec["lifecycle"] in VALID_LIFECYCLES, pkg
        assert spec["engine"] in VALID_ENGINES, pkg
        assert spec["deletionPolicy"] == "retain", pkg
        assert spec["targetAccounts"] == ["111122223333"], pkg
        if spec["engine"] in {"hybrid", "crossplane"}:
            assert spec.get("ackGap"), f"{pkg}: engine {spec['engine']} exige ackGap (ADR-0005)"


def test_available_and_preview_packages_ship_schema_docs_and_rgd():
    for pkg in PACKAGES:
        spec = yaml.safe_load((pkg / "capability.yaml").read_text())["spec"]
        if spec["lifecycle"] in {"available", "preview"}:
            schema = json.loads((pkg / "schema.json").read_text())
            assert schema.get("type") == "object", pkg
            assert (pkg / "docs.md").exists(), pkg
            rgd = ROOT / spec["rgdRef"]
            assert rgd.exists(), f"{pkg}: rgdRef inexistente {spec['rgdRef']}"
            rgd_doc = yaml.safe_load(rgd.read_text())
            assert rgd_doc["kind"] == "ResourceGraphDefinition", pkg


def test_ported_rgds_enforce_retain_and_account_tags():
    expected_retains = {
        "lambda-function-rgd.yaml": 1,
        "dynamodb-table-rgd.yaml": 1,
        "static-site-rgd.yaml": 1,
        "web-api-rgd.yaml": 4,
        "serverless-multi-tier-rgd.yaml": 1,
    }
    for name, count in expected_retains.items():
        text = (ROOT / "platform/compositions" / name).read_text()
        assert text.count("services.k8s.aws/deletion-policy: retain") == count, name
        assert "auto-delete" in text, name
        assert "platform-engineering-foundations" in text, name  # proveniência do porte
        assert ":latest" not in text, name
