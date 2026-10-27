"""Transport adapters: one operation table, served as portal routes and as MCP tools.

Both transports go through `dispatch`, which checks the argument names against the same table
and calls the same AssistantService method. So the portal and the platform-mcp-server cannot
drift in validation or authorization: a field the portal refuses, MCP refuses too, and the
caller identity always comes from the transport, never from an argument. `requester`,
`manifest`, `namespace` and `labels` are not arguments of any operation, so sending them is a
400, not something silently ignored.
"""
from __future__ import annotations

import json
import re
from typing import Any

from .catalog import CatalogUnavailable
from .service import AssistantError, AssistantService, Caller

MAX_BODY_BYTES = 32_768
OPERATIONS: dict[str, dict[str, Any]] = {
    "draft": {"required": ("project", "prompt"), "optional": ("selection",),
              "description": "Ask the model for a ProvisionPlan from a request and the selected context; returns a preview, writes nothing."},
    "preview": {"required": ("project", "plan"), "optional": (),
                "description": "Validate a ProvisionPlan against the published catalog and show steps, defaults, dependencies and manifests; writes nothing."},
    "submit": {"required": ("project", "plan", "idempotencyKey", "confirm"), "optional": (),
               "description": "Submit a previewed plan. confirm.planSha256 must equal the preview hash; the same idempotencyKey never creates twice."},
    "get": {"required": ("planId",), "optional": (), "description": "Read a plan run and its timeline."},
    "refresh": {"required": ("planId",), "optional": (),
                "description": "Reconcile the plan with the CI request, the merge request, Argo CD and the object conditions."},
    "retry": {"required": ("planId", "ref", "expectedAttempt"), "optional": (),
              "description": "Retry one failed step that created nothing."},
    "compensation_preview": {"required": ("planId",), "optional": (),
                             "description": "Show what a rollback of this plan would remove, and what it leaves untouched."},
    "compensation_confirm": {"required": ("planId", "confirm"), "optional": (),
                             "description": "Start the rollback previewed. confirm.compensationSha256 must equal the preview hash."},
}


def _confirm(args: dict[str, Any], key: str) -> Any:
    confirm = args.get("confirm")
    if not isinstance(confirm, dict) or set(confirm) != {key}:
        raise AssistantError(400, "confirmation_invalid", f"confirm must be {{\"{key}\": ...}}")
    return confirm[key]


def dispatch(service: AssistantService, operation: str, args: Any, caller: Caller) -> tuple[int, dict[str, Any]]:
    try:
        spec = OPERATIONS.get(operation)
        if spec is None:
            raise AssistantError(404, "operation_unknown", f"{operation!r} is not an assistant operation")
        if not isinstance(args, dict):
            raise AssistantError(400, "body_invalid", "arguments must be a JSON object")
        unknown = sorted(set(args) - set(spec["required"]) - set(spec["optional"]))
        if unknown:
            raise AssistantError(400, "unknown_field", f"{operation} does not accept: {', '.join(unknown)}")
        missing = [k for k in spec["required"] if k not in args]
        if missing:
            raise AssistantError(400, "missing_field", f"{operation} requires: {', '.join(missing)}")
        if operation == "draft":
            return 200, service.draft(caller, args["project"], args["prompt"], args.get("selection"))
        if operation == "preview":
            return 200, service.preview(caller, args["project"], args["plan"])
        if operation == "submit":
            return service.submit(caller, args["project"], args["plan"], args["idempotencyKey"],
                                  _confirm(args, "planSha256"))
        if operation == "get":
            return 200, service.get(caller, args["planId"])
        if operation == "refresh":
            return 200, service.refresh(caller, args["planId"])
        if operation == "retry":
            return 200, service.retry(caller, args["planId"], args["ref"], args["expectedAttempt"])
        if operation == "compensation_preview":
            return 200, service.compensation_preview(caller, args["planId"])
        return 200, service.compensation_confirm(caller, args["planId"], _confirm(args, "compensationSha256"))
    except AssistantError as error:
        return error.status, error.body()
    except CatalogUnavailable:
        # No index, no safe plan: fail closed, never guess the catalog.
        return 503, {"error": "capability index unavailable in this deployment", "code": "catalog_unavailable"}


# ---------------------------------------------------------------------- portal routes
PREFIX = "/platform/assistant"
_ID = r"([0-9a-f]{32})"
ROUTES: tuple[tuple[str, re.Pattern[str], str], ...] = (
    ("POST", re.compile(rf"{PREFIX}/draft$"), "draft"),
    ("POST", re.compile(rf"{PREFIX}/preview$"), "preview"),
    ("POST", re.compile(rf"{PREFIX}/plans$"), "submit"),
    ("GET", re.compile(rf"{PREFIX}/plans/{_ID}$"), "get"),
    ("POST", re.compile(rf"{PREFIX}/plans/{_ID}/refresh$"), "refresh"),
    ("POST", re.compile(rf"{PREFIX}/plans/{_ID}/steps/([a-z][a-z0-9]{{0,15}})/retry$"), "retry"),
    ("GET", re.compile(rf"{PREFIX}/plans/{_ID}/compensation$"), "compensation_preview"),
    ("POST", re.compile(rf"{PREFIX}/plans/{_ID}/compensation$"), "compensation_confirm"),
)


def handle_http(service: AssistantService, method: str, path: str, raw_body: Any, caller: Caller) -> tuple[int, dict[str, Any]]:
    """Mount point for the platform-api: `if PREFIX in path: return respond(*handle_http(...))`.
    `caller` is the the internal gateway session the platform-api already authorized (alias allowlist)."""
    for verb, pattern, operation in ROUTES:
        match = pattern.search(path)
        if not match or verb != method:
            continue
        args: dict[str, Any] = {}
        if method == "POST":
            if isinstance(raw_body, str) and len(raw_body.encode("utf-8")) > MAX_BODY_BYTES:
                return 413, {"error": f"request body exceeds {MAX_BODY_BYTES} bytes", "code": "body_too_large"}
            try:
                body = json.loads(raw_body or "{}") if isinstance(raw_body, str) else (raw_body or {})
            except json.JSONDecodeError:
                return 400, {"error": "request body is not JSON", "code": "body_invalid"}
            if not isinstance(body, dict):
                return 400, {"error": "request body must be a JSON object", "code": "body_invalid"}
            args.update(body)
        groups = match.groups()
        if groups:
            for key in ("planId", "ref")[:len(groups)]:
                if key in args:
                    return 400, {"error": f"{key} comes from the path", "code": "unknown_field"}
            args.update(dict(zip(("planId", "ref"), groups)))
        return dispatch(service, operation, args, caller)
    return 404, {"error": "route not found", "code": "route_not_found"}


# ---------------------------------------------------------------------- MCP tools
TOOL_PREFIX = "platform_assistant_"
_PROPERTY_SCHEMAS: dict[str, dict[str, Any]] = {
    "project": {"type": "string", "description": "Project (namespace contract) the plan belongs to."},
    "prompt": {"type": "string", "maxLength": 2000},
    "selection": {"type": "array", "maxItems": 10, "items": {"type": "object"}},
    "plan": {"type": "object", "description": "provision-plan/v1 (platform/assistant/provision-plan.schema.json)."},
    "idempotencyKey": {"type": "string", "pattern": "^[A-Za-z0-9_-]{8,64}$"},
    "confirm": {"type": "object"},
    "planId": {"type": "string", "pattern": "^[0-9a-f]{32}$"},
    "ref": {"type": "string", "pattern": "^[a-z][a-z0-9]{0,15}$"},
    "expectedAttempt": {"type": "integer", "minimum": 1},
}


def mcp_tools() -> list[dict[str, Any]]:
    tools = []
    for name, spec in OPERATIONS.items():
        fields = list(spec["required"]) + list(spec["optional"])
        tools.append({"name": TOOL_PREFIX + name, "description": spec["description"],
                      "inputSchema": {"type": "object", "additionalProperties": False,
                                      "required": list(spec["required"]),
                                      "properties": {f: _PROPERTY_SCHEMAS[f] for f in fields}}})
    return tools


def mcp_call(service: AssistantService, name: str, arguments: Any, caller: Caller) -> dict[str, Any]:
    """`caller` is the principal the MCP server authenticated (the corporate SSO alias), with channel "mcp".
    Tool arguments never carry identity."""
    operation = name[len(TOOL_PREFIX):] if isinstance(name, str) and name.startswith(TOOL_PREFIX) else ""
    status, body = dispatch(service, operation, arguments if arguments is not None else {}, caller)
    return {"isError": status >= 400, "structuredContent": {"status": status, **body},
            "content": [{"type": "text", "text": json.dumps({"status": status, **body}, ensure_ascii=False)}]}


def mcp_jsonrpc(service: AssistantService, message: dict[str, Any], caller: Caller) -> dict[str, Any]:
    method, rid = message.get("method"), message.get("id")
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": mcp_tools()}}
    if method == "tools/call":
        params = message.get("params") or {}
        return {"jsonrpc": "2.0", "id": rid,
                "result": mcp_call(service, params.get("name"), params.get("arguments"), caller)}
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}}
