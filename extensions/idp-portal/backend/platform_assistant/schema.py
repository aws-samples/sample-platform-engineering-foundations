"""Stdlib validator for the JSON Schema subset the catalog actually uses.

The Lambda bundle has no `jsonschema`, so this module validates a capability input object
against its `schema.json`. It supports exactly SUPPORTED_KEYWORDS. The index builder refuses
any schema that uses another keyword, which is what keeps "not validated" from ever looking
like "valid": a constraint this module cannot check can never reach the runtime silently.
"""
from __future__ import annotations

import re
from typing import Any

SUPPORTED_KEYWORDS = frozenset({
    "$schema", "title", "description", "type", "required", "properties", "additionalProperties",
    "enum", "pattern", "minimum", "maximum", "default", "items", "maxLength",
})
TYPES = frozenset({"object", "string", "integer", "number", "boolean", "array"})


class UnsupportedSchema(ValueError):
    """The schema uses a keyword or type this validator does not enforce."""


def unsupported_keywords(schema: Any, path: str = "") -> list[str]:
    """Every keyword or type outside the subset, with its location. Empty means enforceable."""
    if not isinstance(schema, dict):
        return [f"{path or '/'}: schema node must be an object"]
    found = [f"{path or '/'}: {key}" for key in sorted(schema) if key not in SUPPORTED_KEYWORDS]
    kind = schema.get("type")
    if kind is not None and kind not in TYPES:
        found.append(f"{path or '/'}: type {kind!r}")
    for name, child in (schema.get("properties") or {}).items():
        found += unsupported_keywords(child, f"{path}/properties/{name}")
    extra = schema.get("additionalProperties")
    if isinstance(extra, dict):
        found += unsupported_keywords(extra, f"{path}/additionalProperties")
    if isinstance(schema.get("items"), dict):
        found += unsupported_keywords(schema["items"], f"{path}/items")
    return found


def _type_ok(expected: str, value: Any) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return False


def validate(value: Any, schema: dict[str, Any], path: str = "") -> list[tuple[str, str, str]]:
    """Return (json-pointer, code, message) for every violation. Deterministic order."""
    errors: list[tuple[str, str, str]] = []
    where = path or "/"
    expected = schema.get("type")
    if expected and not _type_ok(expected, value):
        return [(where, "type", f"expected {expected}")]
    if "enum" in schema and value not in schema["enum"]:
        errors.append((where, "enum", "value is not one of " + ", ".join(map(str, schema["enum"]))))
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append((where, "pattern", f"does not match {schema['pattern']}"))
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append((where, "max_length", f"longer than {schema['maxLength']} characters"))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append((where, "minimum", f"below {schema['minimum']}"))
        if "maximum" in schema and value > schema["maximum"]:
            errors.append((where, "maximum", f"above {schema['maximum']}"))
    if isinstance(value, dict):
        properties = schema.get("properties") or {}
        extra = schema.get("additionalProperties", True)
        for key in schema.get("required") or []:
            if key not in value:
                errors.append((f"{path}/{key}", "required", "field is required"))
        for key in sorted(value):
            child = f"{path}/{key}"
            if key in properties:
                errors += validate(value[key], properties[key], child)
            elif extra is False:
                errors.append((child, "unknown_field", "field is not in the capability schema"))
            elif isinstance(extra, dict):
                errors += validate(value[key], extra, child)
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for index, item in enumerate(value):
            errors += validate(item, schema["items"], f"{path}/{index}")
    return errors
