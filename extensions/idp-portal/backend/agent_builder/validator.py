"""AgentDraft v1 validator, stdlib only.

Why stdlib: this code runs inside the platform-api Lambda, whose bundle has no
`jsonschema`. The JSON Schema in `platform/agent-builder/agent-draft.schema.json` stays the
published contract; `tests/test_agent_builder_contract.py` runs both over the same fixtures
and asserts they agree, so this file cannot quietly become more permissive than the schema.

Three rules the schema cannot express (design secao 3) live only here:

- `reserved_name`: the `ab-fx-` fixture prefix needs an admin caller.
- `duplicate`: `skills[*].id` must be unique.
- `tool_not_allowed`: tool membership is decided by `tool-catalog.json`, not by the enum
  copied into the schema.

Shape of the contract: **one error per JSON Pointer**, first failing rule wins. That is what
makes a single-defect draft produce exactly one `(path, code)` pair, and it is why every
check below returns instead of accumulating.

Nothing is ever repaired. A draft that does not validate is refused, because silently
rewriting a user's intent and then compiling it is how a manifest stops matching what the
user approved in the preview.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable

from .catalog import tool_names

SCHEMA_VERSION = "agent-draft/v1"
MAX_DRAFT_BYTES = 32 * 1024

NAME_PATTERN = r"^ab-[a-z0-9](?:[a-z0-9-]{0,35}[a-z0-9])?$"
SKILL_ID_PATTERN = r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$"
SINGLE_LINE_PATTERN = r"^\S(?:[^\u0000-\u001f\u007f]*\S)?$"
# Credential shapes, then the `label: value` shape. The token prefixes below are matched by
# their OWN format, not by a nearby word, because a pasted token arrives naked: `glpat-...` in
# an instruction has no `token:` in front of it and the label branch never saw it.
# Lengths are `{20,}` rather than the exact vendor length so a truncated or re-prefixed token
# still matches; no prose reaches 20 characters of base64 after one of these prefixes.
SECRET_LIKE_PATTERN = (
    r"(?:AKIA|ASIA)[0-9A-Z]{16}|-----BEGIN|"
    r"glpat-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[bp]-[0-9A-Za-z-]{20,}|"
    # JWT: three base64url segments, the first being a base64 `{"` header. Covers the access
    # token of the gateway and any OIDC id_token pasted into an instruction.
    r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|"
    r"(?:[Pp]assw(?:or)?d|PASSW(?:OR)?D|[Ss]ecret|SECRET|[Tt]oken|TOKEN|[Aa]pi[_-]?[Kk]ey|API[_-]?KEY)\s*[:=]\s*\S"
)

FIXTURE_PREFIX = "ab-fx-"
BUILDER_PREFIX = "ab-"
LANGUAGES = ("pt-BR", "en-US", "es")

# re.fullmatch, never re.match: Python lets `$` match before a trailing newline, so
# re.match would accept "ab-ok\n" where ECMA-262 (the schema's dialect) rejects it.
_NAME = re.compile(NAME_PATTERN)
_SKILL_ID = re.compile(SKILL_ID_PATTERN)
_SINGLE_LINE = re.compile(SINGLE_LINE_PATTERN)
_SECRET_LIKE = re.compile(SECRET_LIKE_PATTERN)

ROOT_FIELDS = ("schemaVersion", "name", "displayName", "description", "language", "instructions", "tools", "skills")
SKILL_FIELDS = ("id", "name", "description", "examples")

MESSAGES: dict[str, tuple[str, str]] = {
    "schema_version": ("Unsupported draft schema version.", "Versao de schema do draft nao suportada."),
    "required": ("Field is required.", "O campo e obrigatorio."),
    "unknown_field": ("Field is not part of AgentDraft v1.", "O campo nao faz parte do AgentDraft v1."),
    "type": ("Field has the wrong type.", "O campo tem o tipo errado."),
    "too_short": ("Value is shorter than the minimum.", "O valor e menor que o minimo."),
    "too_long": ("Value is longer than the maximum.", "O valor e maior que o maximo."),
    "too_few": ("Fewer items than the minimum.", "Menos itens que o minimo."),
    "too_many": ("More items than the maximum.", "Mais itens que o maximo."),
    "pattern": ("Value does not match the required format.", "O valor nao casa com o formato exigido."),
    "not_single_line": ("Value must be one line, trimmed, without control characters.", "O valor deve ser uma linha, sem espaco nas pontas e sem caractere de controle."),
    "secret_like": ("Value looks like a credential.", "O valor parece uma credencial."),
    "enum": ("Value is not one of the allowed options.", "O valor nao esta entre as opcoes permitidas."),
    "duplicate": ("Value repeats an earlier entry.", "O valor repete uma entrada anterior."),
    "tool_not_allowed": ("Tool is not in the read-only catalog.", "A tool nao esta no catalogo read-only."),
    "reserved_name": ("Name prefix is reserved for run fixtures created by an admin.", "O prefixo do nome e reservado para fixtures de run criadas por admin."),
}

WARNING_MESSAGES: dict[str, tuple[str, str]] = {
    "no_tools": ("The agent has no tools and answers only from the conversation.", "O agent nao tem tools e responde so pela conversa."),
    "pod_logs_sensitive": ("Pod logs can contain sensitive data.", "Log de pod pode conter dado sensivel."),
}


@dataclass(frozen=True)
class Issue:
    path: str
    code: str

    def as_dict(self) -> dict[str, str]:
        english, portuguese = MESSAGES.get(self.code, WARNING_MESSAGES.get(self.code, ("", "")))
        return {"path": self.path, "code": self.code, "message": english, "messagePt": portuguese}


@dataclass(frozen=True)
class Validation:
    valid: bool
    errors: tuple[Issue, ...]
    warnings: tuple[Issue, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "errors": [issue.as_dict() for issue in self.errors],
            "warnings": [issue.as_dict() for issue in self.warnings],
        }


class _Collector:
    """One error per path. A second report for the same pointer is dropped, which is what
    keeps a single-defect draft down to a single pair."""

    def __init__(self) -> None:
        self._by_path: dict[str, str] = {}

    def add(self, path: str, code: str) -> None:
        self._by_path.setdefault(path, code)

    def taken(self, path: str) -> bool:
        return path in self._by_path

    def issues(self) -> tuple[Issue, ...]:
        return tuple(Issue(path, self._by_path[path]) for path in sorted(self._by_path))


def _check_text(errors: _Collector, path: str, value: Any, minimum: int, maximum: int, *, single_line: bool = True, pattern: re.Pattern[str] | None = None) -> None:
    if not isinstance(value, str):
        errors.add(path, "type")
        return
    if single_line and not _SINGLE_LINE.fullmatch(value):
        errors.add(path, "not_single_line")
        return
    if single_line and _SECRET_LIKE.search(value):
        errors.add(path, "secret_like")
        return
    if len(value) < minimum:
        errors.add(path, "too_short")
        return
    if len(value) > maximum:
        errors.add(path, "too_long")
        return
    if pattern is not None and not pattern.fullmatch(value):
        errors.add(path, "pattern")


def _check_list(errors: _Collector, path: str, value: Any, minimum: int, maximum: int) -> bool:
    """True when the value is a list worth descending into."""
    if not isinstance(value, list):
        errors.add(path, "type")
        return False
    if len(value) < minimum:
        errors.add(path, "too_few")
    elif len(value) > maximum:
        errors.add(path, "too_many")
    return True


def _check_unknown(errors: _Collector, prefix: str, document: dict[str, Any], allowed: Iterable[str]) -> None:
    for key in document:
        if key not in allowed:
            errors.add(f"{prefix}/{key}", "unknown_field")


def _check_name(errors: _Collector, value: Any, caller_is_admin: bool) -> None:
    _check_text(errors, "/name", value, 4, 40, single_line=False, pattern=_NAME)
    if errors.taken("/name") or not isinstance(value, str):
        return
    if value.startswith(FIXTURE_PREFIX) and not caller_is_admin:
        errors.add("/name", "reserved_name")


def _check_tools(errors: _Collector, value: Any) -> None:
    if not _check_list(errors, "/tools", value, 0, 5):
        return
    allowed = set(tool_names())
    seen: set[str] = set()
    for index, tool in enumerate(value):
        path = f"/tools/{index}"
        if not isinstance(tool, str):
            errors.add(path, "type")
            continue
        if tool not in allowed:
            errors.add(path, "tool_not_allowed")
            continue
        if tool in seen:
            errors.add(path, "duplicate")
        seen.add(tool)


def _check_skills(errors: _Collector, value: Any) -> None:
    if not _check_list(errors, "/skills", value, 1, 3):
        return
    seen: dict[str, int] = {}
    for index, skill in enumerate(value):
        prefix = f"/skills/{index}"
        if not isinstance(skill, dict):
            errors.add(prefix, "type")
            continue
        _check_unknown(errors, prefix, skill, SKILL_FIELDS)
        for field in SKILL_FIELDS:
            if field not in skill:
                errors.add(f"{prefix}/{field}", "required")
        if "id" in skill:
            _check_text(errors, f"{prefix}/id", skill["id"], 1, 32, single_line=False, pattern=_SKILL_ID)
        if "name" in skill:
            _check_text(errors, f"{prefix}/name", skill["name"], 3, 60)
        if "description" in skill:
            _check_text(errors, f"{prefix}/description", skill["description"], 10, 200)
        if "examples" in skill and _check_list(errors, f"{prefix}/examples", skill["examples"], 0, 3):
            for position, example in enumerate(skill["examples"]):
                _check_text(errors, f"{prefix}/examples/{position}", example, 5, 200)
        identifier = skill.get("id")
        if isinstance(identifier, str) and not errors.taken(f"{prefix}/id"):
            if identifier in seen:
                errors.add(f"{prefix}/id", "duplicate")
            else:
                seen[identifier] = index


def _warnings(draft: dict[str, Any]) -> tuple[Issue, ...]:
    tools = draft.get("tools") or []
    found: list[Issue] = []
    if not tools:
        found.append(Issue("/tools", "no_tools"))
    if "k8s_get_pod_logs" in tools:
        found.append(Issue(f"/tools/{tools.index('k8s_get_pod_logs')}", "pod_logs_sensitive"))
    return tuple(found)


def validate_draft(draft: Any, *, caller_is_admin: bool = False) -> Validation:
    """Validate a draft exactly as the preview and the CI do.

    `caller_is_admin` comes from `PLATFORM_ADMINS` at the handler, never from the draft:
    a draft that could declare its own privilege would make the `ab-fx-` guard decorative.
    """
    errors = _Collector()
    if not isinstance(draft, dict):
        return Validation(False, (Issue("", "type"),), ())
    try:
        encoded = json.dumps(draft, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError):
        # A value no JSON parser could have produced, so the payload did not come through
        # the documented path. Refused as a type error rather than crashing the handler.
        return Validation(False, (Issue("", "type"),), ())
    if len(encoded) > MAX_DRAFT_BYTES:
        return Validation(False, (Issue("", "too_long"),), ())

    _check_unknown(errors, "", draft, ROOT_FIELDS)
    for field in ROOT_FIELDS:
        if field not in draft:
            errors.add(f"/{field}", "required")

    if "schemaVersion" in draft and draft["schemaVersion"] != SCHEMA_VERSION:
        errors.add("/schemaVersion", "schema_version")
    if "name" in draft:
        _check_name(errors, draft["name"], caller_is_admin)
    if "displayName" in draft:
        _check_text(errors, "/displayName", draft["displayName"], 3, 60)
    if "description" in draft:
        _check_text(errors, "/description", draft["description"], 20, 240)
    if "language" in draft and draft["language"] not in LANGUAGES:
        errors.add("/language", "enum")
    if "instructions" in draft and _check_list(errors, "/instructions", draft["instructions"], 1, 10):
        for index, instruction in enumerate(draft["instructions"]):
            _check_text(errors, f"/instructions/{index}", instruction, 10, 400)
    if "tools" in draft:
        _check_tools(errors, draft["tools"])
    if "skills" in draft:
        _check_skills(errors, draft["skills"])

    found = errors.issues()
    if found:
        return Validation(False, found, ())
    return Validation(True, (), _warnings(draft))


def normalize_draft(draft: dict[str, Any]) -> dict[str, Any]:
    """Reorder `tools` into catalog order. Nothing else is touched (design secao 3).

    Normalisation runs after validation and before hashing, so the hash in the preview is
    the hash the CI recomputes: two drafts that differ only in tool order are the same
    agent and must not produce two different `draft-sha256` values.
    """
    order = {name: index for index, name in enumerate(tool_names())}
    tools = draft.get("tools") or []
    unknown = [tool for tool in tools if tool not in order]
    if unknown:
        # Reachable only when a caller skipped validation. A clear error beats a raw
        # KeyError from inside a sort key, which reads like a bug in the compiler.
        raise ValueError(f"tools outside the catalog cannot be normalised: {unknown}")
    normalized = dict(draft)
    normalized["tools"] = sorted(tools, key=lambda tool: order[tool])
    return normalized
