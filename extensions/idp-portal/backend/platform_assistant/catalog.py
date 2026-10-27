"""Published capability index: the ONLY things the assistant may plan.

`capability-index.json` is generated from `platform/catalog/**` and the RGDs by `build_index`,
and `tests/test_platform_assistant.py` regenerates it and compares bytes, so the index is a
cache of the catalog and never a second source of truth. It exists because the Lambda bundle
ships without PyYAML and without the `platform/` tree.

A capability is published when, and only when, all of this holds:

- its domain is not `agent` (agents go through the Agent Builder, which has its own gate);
- `lifecycle` is `available` or `preview`;
- it has a `schema.json` that `schema.py` can enforce completely;
- it has an `rgdRef` that exists, so the kind and the outputs come from the RGD.

Everything else is listed under `excluded` with the reason, so a refusal can say why
("database/postgres/v1 is planned") instead of "not found".
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from .schema import unsupported_keywords

INDEX_VERSION = "platform-assistant-capabilities/v1"
PUBLISHED_LIFECYCLES = ("available", "preview")
# Output names that may carry a credential or a connection string never reach the plan: the UI
# points to the authorized retrieval mechanism instead (issue #12, non-goals).
SENSITIVE_OUTPUT = re.compile(r"(?i)(password|secret|token|credential|connection|conn_?str|private)")

_MODULE_DIR = Path(__file__).resolve().parent
INDEX_FILE = _MODULE_DIR / "capability-index.json"


class CatalogUnavailable(RuntimeError):
    """No index: fail closed. Never plan against a guessed catalog."""


def load_index() -> dict[str, Any]:
    override = os.environ.get("PLATFORM_ASSISTANT_INDEX", "").strip()
    path = Path(override) if override else INDEX_FILE
    if not path.is_file():
        raise CatalogUnavailable(f"capability index not found at {path}")
    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("indexVersion") != INDEX_VERSION or not isinstance(document.get("capabilities"), dict):
        raise CatalogUnavailable("capability index has an unexpected shape")
    return document


def _rgd(repo_root: Path, ref: str) -> dict[str, Any]:
    import yaml  # build time only; the runtime reads the JSON index

    document = yaml.safe_load((repo_root / ref).read_text(encoding="utf-8"))
    return (document.get("spec") or {}).get("schema") or {}


def build_index(repo_root: Path) -> dict[str, Any]:
    """Derive the index from the catalog. Pure function of the files: same tree, same bytes."""
    import yaml

    capabilities: dict[str, Any] = {}
    excluded: dict[str, str] = {}
    for path in sorted((repo_root / "platform/catalog").glob("*/*/v*/capability.yaml")):
        directory = path.parent
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        meta, spec = doc.get("metadata") or {}, doc.get("spec") or {}
        cid = f"{meta.get('domain')}/{meta.get('name')}/{meta.get('version')}"
        schema_file, rgd_ref = directory / "schema.json", spec.get("rgdRef") or ""
        reason = ""
        if meta.get("domain") == "agent":
            reason = "agents are created through the Agent Builder"
        elif spec.get("lifecycle") not in PUBLISHED_LIFECYCLES:
            reason = f"lifecycle is {spec.get('lifecycle')}"
        elif not schema_file.is_file():
            reason = "no schema.json"
        elif not rgd_ref or not (repo_root / rgd_ref).is_file():
            reason = "no RGD"
        schema = json.loads(schema_file.read_text(encoding="utf-8")) if not reason else {}
        if not reason and unsupported_keywords(schema):
            reason = "schema uses keywords the assistant cannot enforce: " + "; ".join(unsupported_keywords(schema))
        if reason:
            excluded[cid] = reason
            continue
        rgd = _rgd(repo_root, rgd_ref)
        status = spec.get("status") or {}
        capabilities[cid] = {
            "id": cid,
            "displayName": spec.get("displayName") or meta.get("name"),
            "displayNamePt": spec.get("displayNamePt") or spec.get("displayName") or meta.get("name"),
            "lifecycle": spec.get("lifecycle"),
            "owner": spec.get("owner"),
            "goldenPath": spec.get("goldenPath") or "",
            "apiVersion": f"kro.run/{rgd.get('apiVersion')}",
            "kind": rgd.get("kind"),
            "deletionPolicy": spec.get("deletionPolicy") or "retain",
            "readyCondition": status.get("readyCondition") or "",
            "argoApplication": status.get("argoApplication") or "",
            "outputs": sorted(k for k in (rgd.get("status") or {}) if not SENSITIVE_OUTPUT.search(k)),
            # No capability publishes a price today. null means "not available", never zero.
            "cost": spec.get("cost"),
            "schema": schema,
        }
    return {"indexVersion": INDEX_VERSION, "source": "platform/catalog", "capabilities": capabilities,
            "excluded": excluded}


def render_index(index: dict[str, Any]) -> str:
    return json.dumps(index, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


if __name__ == "__main__":  # pragma: no cover - regeneration entry point
    root = _MODULE_DIR.parents[1]
    INDEX_FILE.write_text(render_index(build_index(root)), encoding="utf-8")
    print(f"wrote {INDEX_FILE.relative_to(root)}")
