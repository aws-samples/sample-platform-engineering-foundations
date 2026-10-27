"""Read the top-level `spec.schema.spec` of a kro ResourceGraphDefinition without PyYAML.

The platform-api Lambda ships no YAML parser, and the only thing the Studio needs from a
composition is which inputs it accepts: name, kro SimpleSchema type, required or default.
That block is regular (`<key>: <type> | default=<value>`), so a line reader is enough, and
`tests/test_service_studio.py` compares this reader with PyYAML over every composition in
the repository, so it cannot drift silently.

Anything this reader does not understand raises: a composition it cannot read is a
composition the Studio refuses to bind a form to, never one it guesses about.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .contract import StudioUnavailable

_KEY = re.compile(r"^(?P<indent> *)(?P<key>[A-Za-z][A-Za-z0-9_-]*):(?:\s+(?P<value>.*))?$")
KRO_TYPES = {"string": "string", "integer": "integer", "boolean": "boolean", "map[string]string": "stringMap",
             "[]string": "stringList"}


@dataclass(frozen=True)
class RgdField:
    name: str
    type: str          # one of contract.FIELD_TYPES
    required: bool
    default: object    # None when absent


@dataclass(frozen=True)
class Composition:
    ref: str           # platform/compositions/<file>
    name: str          # metadata.name, the live identity
    kind: str          # spec.schema.kind
    fields: Mapping[str, RgdField]


def _strip_comment(line: str) -> str:
    out, quote = [], ""
    for ch in line:
        if quote:
            quote = "" if ch == quote else quote
        elif ch in "\"'":
            quote = ch
        elif ch == "#":
            break
        out.append(ch)
    return "".join(out).rstrip()


def _parse_simple_type(raw: str, where: str) -> tuple[str, bool, object]:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    head, _, marker = value.partition("|")
    base = KRO_TYPES.get(head.strip())
    if base is None:
        raise StudioUnavailable(f"{where}: unsupported kro type {head.strip()!r}")
    default: object = None
    required = True
    marker = marker.strip()
    if marker.startswith("default="):
        literal = marker[len("default="):]
        try:
            default = json.loads(literal)
        except json.JSONDecodeError as error:
            raise StudioUnavailable(f"{where}: unreadable default {literal!r}") from error
        required = False
    elif marker and marker != "required=true":
        raise StudioUnavailable(f"{where}: unsupported kro marker {marker!r}")
    if base in ("stringMap", "stringList") and default is None:
        required = False
    return base, required, default


def parse_rgd(text: str, ref: str) -> Composition:
    lines = [_strip_comment(l) for l in text.splitlines()]
    name = kind = ""
    path: list[tuple[int, str]] = []
    fields: dict[str, RgdField] = {}
    for number, line in enumerate(lines, 1):
        if not line.strip() or line.lstrip().startswith("-"):
            continue
        match = _KEY.match(line)
        if not match:
            continue
        indent, key, value = len(match["indent"]), match["key"], (match["value"] or "").strip()
        while path and path[-1][0] >= indent:
            path.pop()
        keys = [k for _, k in path]
        if keys == ["metadata"] and key == "name":
            name = value.strip("\"'")
        elif keys == ["spec", "schema"] and key == "kind":
            kind = value.strip("\"'")
        elif keys == ["spec", "schema", "spec"]:
            if not value:
                raise StudioUnavailable(f"{ref}:{number}: nested schema field {key!r} is not supported")
            base, required, default = _parse_simple_type(value, f"{ref}:{number}")
            fields[key] = RgdField(key, base, required, default)
        if not value:
            path.append((indent, key))
    if not name or not kind or not fields:
        raise StudioUnavailable(f"{ref}: not a readable ResourceGraphDefinition")
    return Composition(ref, name, kind, fields)


def _compositions_dir() -> Path:
    override = os.environ.get("SERVICE_STUDIO_COMPOSITIONS")
    candidates = [Path(override)] if override else []
    here = Path(__file__).resolve()
    candidates += [here.parent / "compositions", here.parents[2] / "platform" / "compositions"]
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    raise StudioUnavailable("platform/compositions is not in this bundle")


def load_compositions(directory: Path | None = None) -> dict[str, Composition]:
    root = directory or _compositions_dir()
    found: dict[str, Composition] = {}
    for file in sorted(root.glob("*-rgd.yaml")):
        ref = f"platform/compositions/{file.name}"
        found[ref] = parse_rgd(file.read_text(encoding="utf-8"), ref)
    if not found:
        raise StudioUnavailable(f"no composition under {root}")
    return found
