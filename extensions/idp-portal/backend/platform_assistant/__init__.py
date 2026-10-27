"""Platform Assistant: governed multi-resource provisioning plans (issue #12).

    preview = service.preview(caller, "todo-app", plan)          # validates, writes nothing
    status, body = service.submit(caller, "todo-app", plan, key, preview["planSha256"])
    service.refresh(caller, body["run"]["planId"])                 # request -> MR -> Argo -> Ready

The model only proposes data (`planner.interpret_model_output`); the planner, the published
capability index and the compiler decide what becomes a manifest. The only writes are
provision requests and plan records, both consumed by the existing governed path. Mount
points: `transport.handle_http` (platform-api) and `transport.mcp_jsonrpc` (platform-mcp-server).
"""
from __future__ import annotations

from .approval import ApprovalUnavailable, KmsMac
from .catalog import CatalogUnavailable, build_index, load_index, render_index
from .planner import COMPILER, SCHEMA_VERSION, build_plan, compile_instance, interpret_model_output, model_instructions
from .ports import (ClusterApiObserver, DynamoPlanStore, DynamoRequestStore, Membership, ObservationUnavailable,
                    StaticProjects)
from .projects import ScopeProjects
from .removal import RemovalRefused, removal_change
from .service import ACTIONS, AssistantError, AssistantService, Caller, propose_plan, sanitize_selection
from .transport import OPERATIONS, dispatch, handle_http, mcp_call, mcp_jsonrpc, mcp_tools

__all__ = [
    "ACTIONS", "ApprovalUnavailable", "KmsMac", "AssistantError", "AssistantService", "COMPILER", "Caller", "CatalogUnavailable", "ClusterApiObserver",
    "DynamoPlanStore", "DynamoRequestStore", "Membership", "OPERATIONS", "ObservationUnavailable", "RemovalRefused",
    "SCHEMA_VERSION", "ScopeProjects", "StaticProjects", "build_index", "build_plan", "compile_instance", "dispatch",
    "handle_http", "interpret_model_output", "load_index", "mcp_call", "mcp_jsonrpc", "mcp_tools", "model_instructions",
    "propose_plan", "removal_change", "render_index", "sanitize_selection",
]
