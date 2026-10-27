"""ServiceDraft v1 validator, stdlib only, closed by construction.

Shape of the contract, same as the Agent Builder's: one error per JSON Pointer, first failing
rule wins, and nothing is ever repaired. A model that adds a key, renames a secret into a
field, or writes an instruction into a description gets a refusal with a code, not a draft
quietly cleaned up and compiled.

The rules that make the Service Owner flow safe live here and only here:

- the key set is closed at every level (`unknown_field`);
- a field can never carry a Secret, IAM, a namespace or a value the platform imposes
  (`secret_field`, `iam_field`, `namespace_field`, `platform_field`), whatever the composition
  underneath accepts;
- free text is one line where it is rendered inline, and never carries a credential, markup
  or an instruction-override phrase (`secret_like`, `markup`, `instruction_like`);
- a form bound to a composition can only ask for what that composition accepts, with the same
  type, and must ask for everything it requires (`field_not_in_rgd`, `rgd_type_mismatch`,
  `rgd_required_missing`).
"""
from __future__ import annotations

import json
import re
from typing import Any, Mapping

from .compositions import Composition
from .contract import (
    DOCS_KEYS, DOMAINS, ENGINES, FIELD_KEYS, FIELD_NAME_PATTERN, FIELD_REGEX_ALPHABET, FIELD_TYPES,
    GOLDEN_PATH_PATTERN, IAM_NAME_EXACT, IAM_NAME_TOKENS, INSTRUCTION_PATTERN, LIFECYCLES, MARKUP_PATTERN,
    MAX_DRAFT_BYTES, MAX_FIELDS, MAX_REQUIRES, NAME_PATTERN, NAMESPACE_NAME_TOKENS, OWNER_PATTERN,
    PLATFORM_NAME_EXACT, REQUIRED_ROOT, REQUIRES_PATTERN, RGD_REF_PATTERN, ROOT_FIELDS, SCHEMA_VERSION,
    SECRET_LIKE_PATTERN, SECRET_NAME_TOKENS, SINGLE_LINE, VERSION_PATTERN, WARNINGS, Issue, Validation,
)

_SINGLE = re.compile(SINGLE_LINE)
_SECRET = re.compile(SECRET_LIKE_PATTERN)
_MARKUP = re.compile(MARKUP_PATTERN)
_INSTRUCTION = re.compile(INSTRUCTION_PATTERN)
_REGEX_ALPHABET = re.compile(FIELD_REGEX_ALPHABET)
PATTERNS = {key: re.compile(value) for key, value in {
    "name": NAME_PATTERN, "version": VERSION_PATTERN, "owner": OWNER_PATTERN, "goldenPath": GOLDEN_PATH_PATTERN,
    "rgdRef": RGD_REF_PATTERN, "requires": REQUIRES_PATTERN, "field": FIELD_NAME_PATTERN,
}.items()}
LIMITS = {"displayName": 60, "displayNamePt": 60, "description": 200, "descriptionPt": 200, "pattern": 80,
          "title": 60, "fieldDescription": 200, "docs": 2000, "enumValue": 60, "value": 200}


class _Stop(Exception):
    def __init__(self, issue: Issue) -> None:
        super().__init__(issue.code)
        self.issue = issue


def _fail(path: str, code: str) -> None:
    raise _Stop(Issue.of(path, code))


def _canonical_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def forbidden_field_code(name: str) -> str | None:
    """Why a field name can never be a form input, or None. Exposed for the UI hint and tests."""
    flat = _canonical_name(name)
    if any(token in flat for token in SECRET_NAME_TOKENS):
        return "secret_field"
    if flat in IAM_NAME_EXACT or any(token in flat for token in IAM_NAME_TOKENS):
        return "iam_field"
    if any(token in flat for token in NAMESPACE_NAME_TOKENS):
        return "namespace_field"
    if flat in PLATFORM_NAME_EXACT or flat in ("lifecycle", "expiresat"):
        return "platform_field"
    return None


def _text(value: Any, path: str, limit: int, *, single_line: bool = True, required: bool = True) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        _fail(path, "type")
    if len(value) > limit:
        _fail(path, "too_long")
    if single_line and not _SINGLE.fullmatch(value):
        _fail(path, "not_single_line")
    if not single_line and (not value.strip() or re.search(r"[\u0000-\u0008\u000b-\u001f\u007f]", value)):
        _fail(path, "not_single_line")
    if _SECRET.search(value):
        _fail(path, "secret_like")
    if _MARKUP.search(value):
        _fail(path, "markup")
    if _INSTRUCTION.search(value):
        _fail(path, "instruction_like")
    return value


def _pattern(value: Any, path: str, key: str) -> str:
    if not isinstance(value, str):
        _fail(path, "type")
    if not PATTERNS[key].fullmatch(value):
        _fail(path, "pattern")
    return value


def _closed(obj: Any, allowed: tuple[str, ...], path: str) -> dict[str, Any]:
    if not isinstance(obj, dict):
        _fail(path, "type")
    for key in obj:
        if key not in allowed:
            _fail(f"{path}/{key}", "unknown_field")
    return obj


def _value_ok(field: dict[str, Any], value: Any) -> bool:
    kind = field["type"]
    if kind == "string":
        if not isinstance(value, str) or len(value) > LIMITS["value"]:
            return False
        if "enum" in field and value not in field["enum"]:
            return False
        if "pattern" in field and not re.fullmatch(field["pattern"], value):
            return False
        return not _SECRET.search(value) and not _MARKUP.search(value)
    if kind == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            return False
        return field.get("minimum", value) <= value <= field.get("maximum", value)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "stringMap":
        return isinstance(value, dict) and len(value) <= 20 and all(
            isinstance(k, str) and isinstance(v, str) and not _SECRET.search(f"{k}={v}") and not _MARKUP.search(v)
            for k, v in value.items())
    if kind == "stringList":
        return isinstance(value, list) and len(value) <= 20 and all(
            isinstance(v, str) and not _SECRET.search(v) and not _MARKUP.search(v) for v in value)
    return False


def _field(raw: Any, path: str) -> dict[str, Any]:
    field = _closed(raw, FIELD_KEYS, path)
    for key in ("name", "type"):
        if key not in field:
            _fail(f"{path}/{key}", "required")
    # The policy reason wins over the format one: `admin_PASSWORD` is refused as a secret, so the
    # Service Owner learns why, instead of being told to rename it into `adminPassword`.
    reason = forbidden_field_code(field["name"]) if isinstance(field["name"], str) else None
    if reason:
        _fail(f"{path}/name", reason)
    _pattern(field["name"], f"{path}/name", "field")
    if field["type"] not in FIELD_TYPES:
        _fail(f"{path}/type", "enum")
    kind = field["type"]
    _text(field.get("title"), f"{path}/title", LIMITS["title"], required=False)
    _text(field.get("description"), f"{path}/description", LIMITS["fieldDescription"], required=False)
    if "required" in field and not isinstance(field["required"], bool):
        _fail(f"{path}/required", "type")
    if "enum" in field:
        if kind != "string":
            _fail(f"{path}/enum", "constraint_type")
        values = field["enum"]
        if not isinstance(values, list):
            _fail(f"{path}/enum", "type")
        if not values:
            _fail(f"{path}/enum", "too_few")
        if len(values) > 20:
            _fail(f"{path}/enum", "too_many")
        for index, value in enumerate(values):
            _text(value, f"{path}/enum/{index}", LIMITS["enumValue"])
            if values.index(value) != index:
                _fail(f"{path}/enum/{index}", "duplicate")
    if "pattern" in field:
        if kind != "string":
            _fail(f"{path}/pattern", "constraint_type")
        expression = field["pattern"]
        if not isinstance(expression, str):
            _fail(f"{path}/pattern", "type")
        # No lookarounds, no backreferences, no nested quantifier groups: ECMA-262 and Python must
        # agree, and a catastrophic pattern must not reach the browser that renders the form.
        if not _REGEX_ALPHABET.fullmatch(expression) or "(?" in expression or re.search(r"\\[1-9]", expression) \
                or re.search(r"\)[*+{]", expression):
            _fail(f"{path}/pattern", "invalid_regex")
        try:
            re.compile(expression)
        except re.error:
            _fail(f"{path}/pattern", "invalid_regex")
    for bound in ("minimum", "maximum"):
        if bound in field:
            if kind != "integer":
                _fail(f"{path}/{bound}", "constraint_type")
            if isinstance(field[bound], bool) or not isinstance(field[bound], int):
                _fail(f"{path}/{bound}", "type")
    if "minimum" in field and "maximum" in field and field["minimum"] > field["maximum"]:
        _fail(f"{path}/maximum", "invalid_bounds")
    for key in ("default", "example"):
        if key in field and not _value_ok(field, field[key]):
            _fail(f"{path}/{key}", "invalid_default" if key == "default" else "type")
    return field


def _bind(draft: dict[str, Any], composition: Composition, warnings: list[Issue]) -> None:
    by_name = {field["name"]: (index, field) for index, field in enumerate(draft["fields"])}
    for name, (index, field) in by_name.items():
        rgd_field = composition.fields.get(name)
        if rgd_field is None:
            _fail(f"/fields/{index}/name", "field_not_in_rgd")
        if rgd_field.type != field["type"]:
            _fail(f"/fields/{index}/type", "rgd_type_mismatch")
        if "default" in field and rgd_field.default is not None and field["default"] != rgd_field.default:
            warnings.append(Issue.of(f"/fields/{index}/default", "default_differs", WARNINGS))
    for name, rgd_field in composition.fields.items():
        if rgd_field.required and rgd_field.default is None:
            if name not in by_name:
                # A required composition input the form may not ask for (IAM, secret) means the
                # capability cannot be self-service; the error names which one.
                code = forbidden_field_code(name)
                _fail(f"/fields/-/{name}", code or "rgd_required_missing")
            index, field = by_name[name]
            if field.get("required") is not True:
                _fail(f"/fields/{index}/required", "rgd_required_missing")


def validate_draft(draft: Any, compositions: Mapping[str, Composition]) -> Validation:
    warnings: list[Issue] = []
    try:
        if not isinstance(draft, dict):
            _fail("", "type")
        if len(json.dumps(draft, ensure_ascii=False, default=str).encode("utf-8")) > MAX_DRAFT_BYTES:
            _fail("", "too_large")
        _closed(draft, ROOT_FIELDS, "")
        for key in REQUIRED_ROOT:
            if key not in draft:
                _fail(f"/{key}", "required")
        if draft["schemaVersion"] != SCHEMA_VERSION:
            _fail("/schemaVersion", "schema_version")
        if draft["domain"] not in DOMAINS:
            _fail("/domain", "enum")
        for key in ("name", "version", "owner", "goldenPath"):
            _pattern(draft[key], f"/{key}", key)
        for key, limit in (("displayName", 60), ("description", 200), ("pattern", 80)):
            _text(draft[key], f"/{key}", limit)
        _text(draft.get("displayNamePt"), "/displayNamePt", 60, required=False)
        _text(draft.get("descriptionPt"), "/descriptionPt", 200, required=False)
        if draft["engine"] not in ENGINES:
            _fail("/engine", "enum")
        if draft["lifecycle"] not in LIFECYCLES:
            _fail("/lifecycle", "enum")
        if "requires" in draft:
            requires = draft["requires"]
            if not isinstance(requires, list):
                _fail("/requires", "type")
            if len(requires) > MAX_REQUIRES:
                _fail("/requires", "too_many")
            for index, item in enumerate(requires):
                _pattern(item, f"/requires/{index}", "requires")
                if requires.index(item) != index:
                    _fail(f"/requires/{index}", "duplicate")
        if "docs" in draft:
            docs = _closed(draft["docs"], DOCS_KEYS, "/docs")
            for key in DOCS_KEYS:
                _text(docs.get(key), f"/docs/{key}", LIMITS["docs"], single_line=False, required=False)
        fields = draft["fields"]
        if not isinstance(fields, list):
            _fail("/fields", "type")
        if not fields:
            _fail("/fields", "too_few")
        if len(fields) > MAX_FIELDS:
            _fail("/fields", "too_many")
        names: list[str] = []
        for index, raw in enumerate(fields):
            field = _field(raw, f"/fields/{index}")
            if field["name"] in names:
                _fail(f"/fields/{index}/name", "duplicate")
            names.append(field["name"])
        if "name" not in names:
            # Every instance is addressed by name; the compiler maps it to metadata.name.
            _fail("/fields", "required")
        for index, field in enumerate(fields):
            if field["name"] == "name":
                if field["type"] != "string" or field.get("required") is not True:
                    _fail(f"/fields/{index}/required", "rgd_required_missing")
                if "example" in field and not re.fullmatch(r"[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?", str(field["example"])):
                    _fail(f"/fields/{index}/example", "pattern")
            # The generated example must validate, so a required input needs a value to show.
            if field.get("required") and "example" not in field and "default" not in field:
                _fail(f"/fields/{index}/example", "required")
        ref = draft.get("rgdRef")
        if ref is None:
            if draft["lifecycle"] != "planned":
                _fail("/lifecycle", "lifecycle_needs_rgd")
            warnings.append(Issue.of("/rgdRef", "planned_without_rgd", WARNINGS))
        else:
            _pattern(ref, "/rgdRef", "rgdRef")
            if ref not in compositions:
                _fail("/rgdRef", "rgd_unknown")
            _bind(draft, compositions[ref], warnings)
    except _Stop as stop:
        return Validation(errors=(stop.issue,), warnings=tuple(warnings))
    return Validation(warnings=tuple(warnings))


def normalize_draft(draft: dict[str, Any]) -> dict[str, Any]:
    """Stable order and explicit `required`, so two drafts meaning the same compile the same."""
    out = {key: draft[key] for key in ROOT_FIELDS if key in draft}
    out["fields"] = [{**{key: field[key] for key in FIELD_KEYS if key in field}, "required": bool(field.get("required", False))}
                     for field in draft["fields"]]
    if "requires" in out:
        out["requires"] = sorted(out["requires"])
    return out
