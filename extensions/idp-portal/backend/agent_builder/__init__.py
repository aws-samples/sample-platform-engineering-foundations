"""Agent Builder core: validate an AgentDraft, compile it, and scaffold the Git change.

Shared by the platform-api (preview and request), the BFF (validation of what the model
produced) and the CI job that opens the merge request. One implementation, so the preview
the user approves and the manifest the CI pushes cannot disagree.

The module has no cluster credential and no cluster client. Its only write surface is Git,
through an injected GitLab port, which is what keeps Git the single write path.

    from agent_builder import plan_create, scaffold, validate_draft

    validation = validate_draft(draft, caller_is_admin=False)
    plan = plan_create(draft, requester="platform-admin", request_id=request_id)
    result = scaffold(gitlab, plan, pipeline_url=pipeline_url)

Contract and fixtures: `docs/agent-platform/design-agent-builder.md` (secoes 3, 4 and 5.10),
`platform/agent-builder/` and `tests/fixtures/agent-builder/`. Consumers import the package
by putting `backend/` on `sys.path`; nothing here is copied into another module.
"""
from __future__ import annotations

from .catalog import COMPILER, CatalogUnavailable, catalog_path, fixed, load_catalog, tool_names, tool_server
from .compiler import (
    API_VERSION,
    KIND,
    MANAGED_BY,
    PART_OF,
    POD_MANAGED_BY_LABEL,
    PREVIEW_REQUEST_ID,
    REQUESTER_LABEL,
    CompileError,
    build_manifest,
    canonical_bytes,
    compile_manifest,
    disable_manifest,
    draft_sha256,
    manifest_owner,
    system_message,
)
from .paths import (
    IDEMPOTENCY_KEY_PATTERN,
    OP_CREATE,
    OP_DISABLE,
    OPS,
    REQUEST_ID_PATTERN,
    UnsafeName,
    assert_safe_name,
    branch_name,
    custom_branch,
    git_path,
    mirror_path,
    name_from_git_path,
)
from .scaffolder import (
    MAX_ACTIVE_PER_REQUESTER,
    MAX_AGENTS,
    PERSISTED_STATUSES,
    REFUSAL_CODES,
    TERMINAL_STATUSES,
    ExistingAgent,
    GitLabPort,
    ScaffoldPlan,
    ScaffoldRefused,
    ScaffoldResult,
    check_limits,
    describe_manifest,
    persisted_status,
    plan_create,
    plan_disable,
    read_directory,
    scaffold,
    status_detail_field,
    verify_recompiled,
)
from .validator import (
    LANGUAGES,
    MAX_DRAFT_BYTES,
    NAME_PATTERN,
    SCHEMA_VERSION,
    SECRET_LIKE_PATTERN,
    SINGLE_LINE_PATTERN,
    SKILL_ID_PATTERN,
    Issue,
    Validation,
    normalize_draft,
    validate_draft,
)

__all__ = [
    "API_VERSION",
    "COMPILER",
    "CatalogUnavailable",
    "CompileError",
    "ExistingAgent",
    "GitLabPort",
    "IDEMPOTENCY_KEY_PATTERN",
    "Issue",
    "KIND",
    "LANGUAGES",
    "MANAGED_BY",
    "MAX_ACTIVE_PER_REQUESTER",
    "MAX_AGENTS",
    "MAX_DRAFT_BYTES",
    "NAME_PATTERN",
    "OPS",
    "OP_CREATE",
    "OP_DISABLE",
    "PART_OF",
    "POD_MANAGED_BY_LABEL",
    "PERSISTED_STATUSES",
    "PREVIEW_REQUEST_ID",
    "REFUSAL_CODES",
    "REQUESTER_LABEL",
    "REQUEST_ID_PATTERN",
    "SCHEMA_VERSION",
    "SECRET_LIKE_PATTERN",
    "SINGLE_LINE_PATTERN",
    "SKILL_ID_PATTERN",
    "ScaffoldPlan",
    "ScaffoldRefused",
    "ScaffoldResult",
    "TERMINAL_STATUSES",
    "UnsafeName",
    "Validation",
    "assert_safe_name",
    "branch_name",
    "build_manifest",
    "canonical_bytes",
    "catalog_path",
    "check_limits",
    "compile_manifest",
    "custom_branch",
    "describe_manifest",
    "disable_manifest",
    "draft_sha256",
    "fixed",
    "git_path",
    "load_catalog",
    "manifest_owner",
    "mirror_path",
    "name_from_git_path",
    "normalize_draft",
    "persisted_status",
    "plan_create",
    "plan_disable",
    "read_directory",
    "scaffold",
    "status_detail_field",
    "system_message",
    "tool_names",
    "tool_server",
    "validate_draft",
    "verify_recompiled",
]
