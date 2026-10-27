"""The integration surface: what an API route calls. Pure, with every dependency injected.

| Route (to be wired by the platform-api owner) | Calls |
|---|---|
| `POST /platform/service-drafts/preview` | `preview(body, alias=..., is_admin=..., teams=..., compositions=...)` |
| `POST /platform/provision-requests` with `kind: service-capability` | `request_item(...)`, then `PutItem` |
| `POST /gateway/service-drafts/generate` (BFF) | `generation.generate_draft(body, invoke=_invoke_gateway, ...)` |
| CI `open-provision-mrs` | `publish.plan_publish`, `publish.verify_recompiled`, `publish.scaffold` |

Nothing here writes. `request_item` returns the DynamoDB item for the caller to store, and
the CI job is what turns it into a merge request, exactly like the Agent Builder.
"""
from __future__ import annotations

import json
from typing import Any, Mapping

from .authz import authorize
from .compiler import assert_package_paths, compile_package, diff_drafts, draft_sha256, package_dir, policy_verdict, schema_document
from .compositions import Composition
from .contract import COMPILER, DRAFT_OPS, OP_CREATE, OPS, Issue
from .validator import normalize_draft, validate_draft

KIND = "service-capability"
REQUEST_TTL_SECONDS = 30 * 24 * 3600
MAX_SOURCES = 5
EXECUTION_STATES = ("draft", "generating", "proposed", "validating", "invalid", "unauthorized", "valid",
                    "previewed", "requested", "processing", "mr_open", "merged", "closed", "failed")
_PREVIEW_KEYS = {"op", "draft", "base", "sources", "origin"}
_REQUEST_KEYS = {"kind", "op", "draft", "base", "sources", "origin", "previewSha256"}
_COMPUTED = {"manifest", "artifacts", "files", "actions", "path", "branch"}


def _sources(raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_SOURCES:
        raise ValueError(f"sources must be a list of at most {MAX_SOURCES} strings")
    out = []
    for item in raw:
        if not isinstance(item, str) or not item or len(item) > 300 or any(c in item for c in "\n\r\t<>`|"):
            raise ValueError("each source is one line of at most 300 characters")
        out.append(item)
    return out


def _origin(raw: Any) -> str:
    if raw not in (None, "form", "model", "import-rgd", "import-crd", "catalog"):
        raise ValueError("origin must be form, model, import-rgd, import-crd or catalog")
    return raw or "form"


def _refused(state: str, issue: Issue) -> dict[str, Any]:
    return {"state": state, "valid": False, "errors": [issue.as_dict()], "warnings": []}


def preview(body: Mapping[str, Any], *, alias: str, is_admin: bool, teams: Mapping[str, frozenset[str]],
            compositions: Mapping[str, Composition]) -> tuple[int, dict[str, Any]]:
    """Validate, authorize and compile with no side effect. Same draft: same bytes and hash.

    `base` is what the client believes is on `main`. It only shapes the diff shown here; the CI
    reads the real base from `main` and recomputes everything before any write.
    """
    if set(body) - _PREVIEW_KEYS:
        raise ValueError(f"preview accepts only {sorted(_PREVIEW_KEYS)}")
    op = body.get("op", OP_CREATE)
    if op not in DRAFT_OPS:
        raise ValueError("preview supports create and evolve; deprecate and retire need no draft")
    sources, origin = _sources(body.get("sources")), _origin(body.get("origin"))
    draft, base = body.get("draft"), body.get("base")
    validation = validate_draft(draft, compositions)
    if not validation.valid:
        return 200, {"state": "invalid", **validation.as_dict()}
    if base is not None and not isinstance(base, dict):
        raise ValueError("base must be an object")
    normalized = normalize_draft(draft)
    denied = authorize(alias, is_admin, op, normalized["owner"], (base or {}).get("owner") if op != OP_CREATE else None, teams)
    if denied:
        return 403, _refused("unauthorized", denied)
    files = compile_package(normalized, compositions)
    composition = compositions.get(normalized.get("rgdRef") or "")
    base_norm = normalize_draft(base) if isinstance(base, dict) and isinstance(base.get("fields"), list) else None
    sha = draft_sha256(normalized)
    return 200, {
        "state": "previewed", "valid": True, "errors": [], "warnings": [w.as_dict() for w in validation.warnings],
        "draft": normalized, "draftSha256": sha, "compiler": COMPILER, "directory": package_dir(normalized),
        "artifacts": {path: content.decode("utf-8") for path, content in files.items()},
        "form": schema_document(normalized, composition),
        "diff": diff_drafts(base_norm, normalized), "policy": policy_verdict(normalized, base_norm, op),
        "provenance": {"requester": alias, "owner": normalized["owner"], "origin": origin, "sources": sources,
                       "compiler": COMPILER, "draftSha256": sha, "baseSource": "client" if base_norm else None},
    }


def request_item(body: Mapping[str, Any], *, alias: str, is_admin: bool, teams: Mapping[str, frozenset[str]],
                 compositions: Mapping[str, Composition], request_id: str, now: int) -> tuple[int, dict[str, Any], dict[str, Any] | None]:
    """(status, response, item). `item` is None when nothing must be stored.

    The client never sends compiled bytes: the server stores the normalized draft and its hash,
    and the CI recompiles and compares (`publish.verify_recompiled`). `previewSha256` is the
    hash the user approved; a request whose draft no longer hashes to it is refused, so what is
    proposed is exactly what was reviewed.
    """
    if set(body) & _COMPUTED:
        raise ValueError("compiled artifacts are computed by the server, never sent")
    if set(body) - _REQUEST_KEYS:
        raise ValueError(f"request accepts only {sorted(_REQUEST_KEYS)}")
    op = body.get("op")
    if op not in OPS:
        raise ValueError(f"op must be one of {OPS}")
    sources, origin = _sources(body.get("sources")), _origin(body.get("origin"))
    draft = body.get("draft")
    item: dict[str, Any] = {
        "requestId": {"S": request_id}, "status": {"S": "pending"}, "requester": {"S": alias},
        "kind": {"S": KIND}, "op": {"S": op}, "compiler": {"S": COMPILER}, "isAdmin": {"BOOL": is_admin},
        "origin": {"S": origin}, "sources": {"S": json.dumps(sources)},
        "createdAt": {"N": str(now)}, "expiresAt": {"N": str(now + REQUEST_TTL_SECONDS)},
    }
    if op in DRAFT_OPS:
        validation = validate_draft(draft, compositions)
        if not validation.valid:
            return 422, {"state": "invalid", **validation.as_dict()}, None
        normalized = normalize_draft(draft)
        sha = draft_sha256(normalized)
        if body.get("previewSha256") != sha:
            return 409, {"state": "invalid", "error": "the draft changed after the preview; preview again before proposing"}, None
        base = body.get("base")
        denied = authorize(alias, is_admin, op, normalized["owner"], (base or {}).get("owner") if op != OP_CREATE else None, teams)
        if denied:
            return 403, _refused("unauthorized", denied), None
        directory = package_dir(normalized)
        item.update({"name": {"S": directory.removeprefix("platform/catalog/")}, "path": {"S": directory},
                     "draft": {"S": json.dumps(normalized, ensure_ascii=False, sort_keys=True)},
                     "draftSha256": {"S": sha}, "owner": {"S": normalized["owner"]},
                     "capability": {"S": f"{normalized['domain']}/{normalized['name']}"}})
    else:
        # deprecate/retire name an existing package; the CI reads its owner and content from main.
        target = body.get("draft") or {}
        for key in ("domain", "name", "version", "owner"):
            if not isinstance(target.get(key), str):
                raise ValueError(f"{op} needs draft.{key} to identify the package")
        directory = package_dir(target)
        if not _directory_ok(directory):
            raise ValueError("draft does not identify a catalog package")
        denied = authorize(alias, is_admin, op, target["owner"], target["owner"], teams)
        if denied:
            return 403, _refused("unauthorized", denied), None
        item.update({"name": {"S": directory.removeprefix("platform/catalog/")}, "path": {"S": directory},
                     "owner": {"S": target["owner"]}, "capability": {"S": f"{target['domain']}/{target['name']}"}})
    response = {"state": "requested", "requestId": request_id, "status": "pending", "kind": KIND, "op": op,
                "path": item["path"]["S"], "draftSha256": item.get("draftSha256", {}).get("S")}
    return 201, response, item


def _directory_ok(directory: str) -> bool:
    try:
        assert_package_paths([f"{directory}/capability.yaml"])
    except ValueError:
        return False
    return True


def recheck_on_main(item: Mapping[str, Any], base_owner: str | None, teams: Mapping[str, frozenset[str]]) -> Issue | None:
    """The CI's authorization, against the owner READ FROM MAIN. The API checked the owner the
    client claimed; for evolve, deprecate and retire only the CI knows the real one."""
    text = lambda key: str((item.get(key) or {}).get("S", ""))
    return authorize(text("requester"), bool((item.get("isAdmin") or {}).get("BOOL")), text("op"), text("owner"),
                     None if text("op") == OP_CREATE else base_owner, teams)
