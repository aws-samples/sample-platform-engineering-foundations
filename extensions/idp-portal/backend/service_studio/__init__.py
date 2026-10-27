"""Service Owner Studio core (issue #11): prompt-to-form for governed catalog capabilities.

A Service Owner, alone or helped by a model, proposes a ServiceDraft. This package validates
it deterministically, compiles the capability package from it, shows a structured diff and a
policy verdict, and plans the merge request. It never writes to the cluster and never merges:
publication is MR, CI and GitOps. Stdlib only, so it runs in the platform-api Lambda bundle.
See README.md in this directory for the contract and the integration hooks.
"""
from .authz import authorize, parse_teams
from .compiler import (
    breaking_changes, compile_package, diff_drafts, draft_sha256, package_dir, policy_verdict, schema_document,
)
from .compositions import Composition, RgdField, load_compositions, parse_rgd
from .contract import COMPILER, OPS, SCHEMA_VERSION, Issue, StudioUnavailable, Validation
from .generation import build_message, extract_draft, generate_draft
from .publish import (
    INDEX_PATH, PublishPlan, PublishRefused, PublishResult, assert_publish_paths, draft_from_package, existing_files,
    plan_publish, regenerate_index, scaffold, verify_index, verify_recompiled, with_capability_index,
)
from .service import EXECUTION_STATES, KIND, preview, recheck_on_main, request_item
from .validator import forbidden_field_code, normalize_draft, validate_draft

__all__ = [
    "COMPILER", "EXECUTION_STATES", "INDEX_PATH", "KIND", "OPS", "SCHEMA_VERSION", "Composition", "Issue", "PublishPlan",
    "PublishRefused", "PublishResult", "RgdField", "StudioUnavailable", "Validation", "assert_publish_paths", "authorize",
    "breaking_changes", "build_message", "compile_package", "diff_drafts", "draft_from_package", "draft_sha256",
    "existing_files", "extract_draft", "forbidden_field_code", "generate_draft", "load_compositions",
    "normalize_draft", "package_dir", "parse_rgd", "parse_teams", "plan_publish", "policy_verdict", "preview",
    "recheck_on_main", "regenerate_index", "request_item", "scaffold", "schema_document", "validate_draft",
    "verify_index", "verify_recompiled", "with_capability_index",
]
