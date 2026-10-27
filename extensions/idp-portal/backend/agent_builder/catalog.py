"""Closed tool catalog and the fixed values every compiled Agent carries.

Tool membership is decided **by this file**, never by the copy of the enum inside
`agent-draft.schema.json` (design secao 3): a schema that drifts must fail the contract
test, not silently widen what an agent may call.

The canonical file is `platform/agent-builder/tool-catalog.json`, owned by W0. A
byte-identical copy ships next to this module so a Lambda bundle that contains only
`agent_builder/` still resolves the catalog. `tests/test_agent_builder_contract.py`
asserts the two are identical, so a change on either side turns the suite red instead of
letting the runtime and the contract disagree.

Resolution order: `AGENT_BUILDER_CATALOG`, then the module copy, then the repository file.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

CATALOG_VERSION = "agent-builder-tools/v1"
COMPILER = "agent-builder/v1"

_MODULE_DIR = Path(__file__).resolve().parent
_CANDIDATES = (
    _MODULE_DIR / "tool-catalog.json",
    _MODULE_DIR.parents[1] / "platform/agent-builder/tool-catalog.json",
)


class CatalogUnavailable(RuntimeError):
    """The catalog file was not found. Never silently fall back to an embedded list:
    an agent compiled against a guessed catalog is exactly the drift this file prevents."""


def catalog_path() -> Path:
    override = os.environ.get("AGENT_BUILDER_CATALOG", "").strip()
    if override:
        candidate = Path(override)
        if not candidate.is_file():
            raise CatalogUnavailable(f"AGENT_BUILDER_CATALOG points at {override!r}, which is not a file")
        return candidate
    for candidate in _CANDIDATES:
        if candidate.is_file():
            return candidate
    raise CatalogUnavailable(f"tool-catalog.json not found in {[str(c) for c in _CANDIDATES]}")


def load_catalog() -> dict[str, Any]:
    """Read and shape-check the catalog. Not cached: a Lambda container that outlives a
    deploy would otherwise keep serving the catalog of the previous bundle."""
    document = json.loads(catalog_path().read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise CatalogUnavailable("catalog must be a JSON object")
    if document.get("catalogVersion") != CATALOG_VERSION:
        raise CatalogUnavailable(f"catalog version is {document.get('catalogVersion')!r}, expected {CATALOG_VERSION!r}")
    entries = document.get("tools")
    if not isinstance(entries, list) or not entries:
        raise CatalogUnavailable("catalog has no tools")
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str) or not entry["name"]:
            raise CatalogUnavailable("every catalog entry needs a string name")
    return document


def tool_names() -> tuple[str, ...]:
    """Catalog order. This order is the normalisation target for a draft's `tools` and the
    order of `toolNames` in the manifest, so it has to be stable and come from one place."""
    return tuple(entry["name"] for entry in load_catalog()["tools"])


def tool_server() -> dict[str, str]:
    server = load_catalog().get("toolServer") or {}
    missing = [key for key in ("apiGroup", "kind", "name", "namespace") if not server.get(key)]
    if missing:
        raise CatalogUnavailable(f"toolServer is missing {missing}")
    return {key: str(server[key]) for key in ("apiGroup", "kind", "name", "namespace")}


def fixed() -> dict[str, Any]:
    values = load_catalog().get("fixed") or {}
    missing = [key for key in ("namespace", "modelConfig", "compiler", "gitPath", "mirrorPath", "resources") if key not in values]
    if missing:
        raise CatalogUnavailable(f"fixed is missing {missing}")
    if values["compiler"] != COMPILER:
        raise CatalogUnavailable(f"fixed.compiler is {values['compiler']!r}, expected {COMPILER!r}")
    return values
