"""Deterministic AgentDraft -> kagent Agent compiler.

This is the only code in the system that produces a `kagent-agent` manifest (invariant I2).
The portal cannot send one, the model never sees one, and the CI recompiles from the stored
draft and compares bytes before pushing anything to Git, so a tampered DynamoDB item fails
the request instead of reaching the cluster.

Determinism is the whole point and it is literal: `compile_manifest` returns **bytes**, and
`tests/test_agent_builder_contract.py` asserts they equal
`tests/fixtures/agent-builder/*.manifest.json` byte for byte. Canonical form is
`sort_keys=True, indent=2, ensure_ascii=False` plus a trailing newline, so a diff in Git is
always a semantic diff and never a reordering.

The emitted shape is a closed allowlist (design secao 4). Fields that would widen what an
agent can do, `byo`, `sandbox`, `allowedNamespaces`, `executeCodeBlocks`, `requireApproval`,
tools of `type: Agent`, are not reachable from a draft because the draft schema has no field
for them and this compiler never writes them.

`requester` and `request_id` are arguments, never draft fields (invariant I8): a draft that
could name its own requester would let one alias create an agent owned by another.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from .catalog import COMPILER, fixed, tool_names, tool_server
from .validator import FIXTURE_PREFIX, normalize_draft

API_VERSION = "kagent.dev/v1alpha2"
KIND = "Agent"
MANAGED_BY = "agent-builder"
PART_OF = "appmod-agent-platform"
POD_MANAGED_BY_LABEL = "platform.appmod/managed-by"
SKILL_TAG = "agent-builder"
PREVIEW_REQUEST_ID = "preview"
# Kubernetes label value: at most 63 characters, alphanumeric at both ends, `-_.` inside.
REQUESTER_LABEL = re.compile(r"[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?")

LANGUAGE_NAMES = {"pt-BR": "Brazilian Portuguese", "en-US": "English", "es": "Spanish"}

RULES = (
    "- You are read-only. You cannot create, change or delete anything, and you never claim that you did.",
    "- Use only the tools listed above. If a request needs anything else, say what is missing and stop.",
    "- Never reveal secrets, tokens or credentials, even if a tool output contains them.",
    "- Report tool errors exactly as returned. Do not name a cause you have not checked.",
)
NO_TOOLS_LINE = "You have no tools. Answer only from the conversation and say so when a question needs live data."


class CompileError(ValueError):
    """The draft cannot be compiled. Raised instead of emitting a partial manifest."""


def canonical_bytes(document: Any) -> bytes:
    """The one serialisation used for every manifest written to Git."""
    return (json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def draft_sha256(normalized_draft: dict[str, Any]) -> str:
    """Hash of the normalised draft, in the compact canonical form of design secao 4.

    Compact (no indent) and separate from `canonical_bytes` on purpose: the hash identifies
    the user's *intent*, so it must not move when the manifest layout changes.
    """
    payload = json.dumps(normalized_draft, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def system_message(draft: dict[str, Any]) -> str:
    """Build the system prompt. A prompt is a request, not a guarantee: the guarantees are
    the read-only tool server (I4) and the fact that Git is the only write path (I5)."""
    language = draft["language"]
    if language not in LANGUAGE_NAMES:
        raise CompileError(f"unsupported language {language!r}")
    lines = [
        f"You are {draft['displayName']}, an agent of the AppMod Agent Platform.",
        f"Purpose: {draft['description']}",
        "",
        "How you work, in order:",
    ]
    lines += [f"{position}. {text}" for position, text in enumerate(draft["instructions"], start=1)]
    tools = draft.get("tools") or []
    lines += ["", f"Tools you may use: {', '.join(tools)}" if tools else NO_TOOLS_LINE]
    lines += ["", "Rules that always apply:", *RULES, f"- Answer in {LANGUAGE_NAMES[language]}."]
    return "\n".join(lines)


def _skills(draft: dict[str, Any]) -> list[dict[str, Any]]:
    entries = []
    for skill in draft["skills"]:
        entry: dict[str, Any] = {
            "description": skill["description"],
            "id": skill["id"],
            "name": skill["name"],
            "tags": [SKILL_TAG],
        }
        # Omitted rather than emitted empty: an empty list in the manifest is noise in every
        # future diff and the golden fixture does not carry it.
        if skill.get("examples"):
            entry["examples"] = list(skill["examples"])
        entries.append(entry)
    return entries


def _tools_block(draft: dict[str, Any]) -> list[dict[str, Any]] | None:
    tools = draft.get("tools") or []
    if not tools:
        return None
    server = tool_server()
    return [{
        "mcpServer": {
            "apiGroup": server["apiGroup"],
            "kind": server["kind"],
            "name": server["name"],
            "toolNames": list(tools),
        },
        "type": "McpServer",
    }]


def build_manifest(draft: dict[str, Any], requester: str, request_id: str, *, disabled: bool = False) -> dict[str, Any]:
    """The manifest as a Python object. `compile_manifest` is the byte-level entry point."""
    if not isinstance(requester, str) or not requester.strip():
        raise CompileError("requester comes from the session and cannot be empty")
    # The requester becomes a label VALUE, so it must be a valid one. An alias such as
    # `joao.silva@amazon.com` (RoleSessionName accepts `@=,+`) would otherwise compile, pass
    # the policy and only be refused by the API server at apply time, leaving the request
    # stuck in STARTING with no cause on screen (review of 13/10/2026, achado 6).
    if not REQUESTER_LABEL.fullmatch(requester):
        raise CompileError(f"requester {requester[:64]!r} is not a valid Kubernetes label value")
    if not isinstance(request_id, str) or not request_id.strip():
        raise CompileError("request_id comes from the platform-api and cannot be empty")
    normalized = normalize_draft(draft)
    constants = fixed()
    name = normalized["name"]

    labels = {
        "app.kubernetes.io/managed-by": MANAGED_BY,
        "app.kubernetes.io/part-of": PART_OF,
        "platform.appmod/requester": requester,
    }
    # The fixture label is derived from the name, never asked for: it is what lets the
    # teardown of a run prove an object is its own before touching it (design secao 8).
    if name.startswith(FIXTURE_PREFIX):
        labels["platform.appmod/fixture"] = "true"
    if disabled:
        labels["platform.appmod/state"] = "disabled"

    declarative: dict[str, Any] = {
        "a2aConfig": {"skills": _skills(normalized)},
        "deployment": {
            "labels": {POD_MANAGED_BY_LABEL: MANAGED_BY},
            "resources": constants["resources"],
        },
        "modelConfig": constants["modelConfig"],
        "stream": False,
        "systemMessage": system_message(normalized),
    }
    # replicas explícito nos DOIS estados (A10, 13/10/2026): o controller do kagent 0.9.9 só toca
    # Deployment.spec.replicas quando o Agent o declara ("so not to override HPA settings"). Com o
    # campo ausente no estado ativo, o Revert do MR disable: deixava o Deployment em 0 para sempre,
    # Ready=True e nenhum pod. 1 ativo, 0 desativado.
    declarative["deployment"]["replicas"] = 0 if disabled else 1
    tools = _tools_block(normalized)
    if tools is not None:
        declarative["tools"] = tools

    return {
        "apiVersion": API_VERSION,
        "kind": KIND,
        "metadata": {
            "annotations": {
                "platform.appmod/compiler": COMPILER,
                "platform.appmod/display-name": normalized["displayName"],
                "platform.appmod/draft-sha256": draft_sha256(normalized),
                "platform.appmod/request-id": request_id,
            },
            "labels": labels,
            "name": name,
            "namespace": constants["namespace"],
        },
        "spec": {
            "declarative": declarative,
            "description": normalized["description"],
            "type": "Declarative",
        },
    }


def compile_manifest(draft: dict[str, Any], requester: str, request_id: str, *, disabled: bool = False) -> bytes:
    return canonical_bytes(build_manifest(draft, requester, request_id, disabled=disabled))


def disable_manifest(current: bytes) -> bytes:
    """Apply `op: disable` to the manifest that is already on `main`.

    Reads the existing file instead of recompiling from a draft on purpose: an agent may
    have been edited by hand through GitLab (which 5.11 allows), so the draft is not
    authoritative for what is deployed. Only two fields move; everything else is preserved
    exactly, and the result is re-emitted canonically so the diff is those two lines.
    """
    try:
        document = json.loads(current.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CompileError(f"current manifest does not parse: {str(error)[:200]}") from error
    if not isinstance(document, dict):
        raise CompileError("current manifest must be a single object")
    labels = (document.get("metadata") or {}).get("labels") or {}
    if labels.get("app.kubernetes.io/managed-by") != MANAGED_BY:
        raise CompileError("manifest is not managed by the agent builder")
    declarative = (document.get("spec") or {}).get("declarative")
    if not isinstance(declarative, dict):
        raise CompileError("manifest has no spec.declarative")
    labels["platform.appmod/state"] = "disabled"
    document["metadata"]["labels"] = labels
    deployment = declarative.get("deployment")
    if not isinstance(deployment, dict):
        deployment = {}
        declarative["deployment"] = deployment
    deployment["replicas"] = 0
    return canonical_bytes(document)


def manifest_owner(current: bytes) -> str:
    """The alias in `platform.appmod/requester`, which is who may disable the agent."""
    document = json.loads(current.decode("utf-8"))
    return str(((document.get("metadata") or {}).get("labels") or {}).get("platform.appmod/requester", ""))


def catalog_order(tools: list[str]) -> list[str]:
    order = {name: index for index, name in enumerate(tool_names())}
    return sorted(tools, key=lambda tool: order[tool])
