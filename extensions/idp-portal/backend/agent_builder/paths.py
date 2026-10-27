"""Deterministic, safe Git paths and branch names derived from an agent name.

Every path the scaffolder writes is a pure function of the agent name, and the name has
already been through `NAME_PATTERN`. That pattern is what makes traversal impossible:
`ab-` followed by `[a-z0-9-]` admits no `/`, `.`, `\\`, `%`, NUL or newline, so
`../../.gitlab-ci.yml` is refused as a name long before it could become a path.

Two independent enforcement points, because one regex is a single point of failure:

1. `assert_safe_name` rejects the name.
2. `_guard` re-reads the produced path and refuses it unless it is still the template with
   one segment substituted, normalises to itself, and stays under the expected directory.

Step 2 catches a future edit that loosens the pattern without anyone noticing.
"""
from __future__ import annotations

import posixpath
import re

from .catalog import fixed
from .validator import BUILDER_PREFIX, NAME_PATTERN

OP_CREATE = "create"
OP_DISABLE = "disable"
OPS = (OP_CREATE, OP_DISABLE)

BRANCH_PREFIX = {OP_CREATE: "provision", OP_DISABLE: "disable"}
REQUEST_ID_PATTERN = r"^[0-9a-f]{32}$"
IDEMPOTENCY_KEY_PATTERN = r"^[0-9a-z][0-9a-z-]{0,38}[0-9a-z]$"

_NAME = re.compile(NAME_PATTERN)
_REQUEST_ID = re.compile(REQUEST_ID_PATTERN)
_IDEMPOTENCY_KEY = re.compile(IDEMPOTENCY_KEY_PATTERN)


class UnsafeName(ValueError):
    """The name cannot be turned into a path. Never sanitised: a name that needs repair is a
    name the user did not approve in the preview, and repairing it hides the attempt."""


def assert_safe_name(name: object) -> str:
    if not isinstance(name, str):
        raise UnsafeName(f"name must be a string, got {type(name).__name__}")
    if not _NAME.fullmatch(name):
        raise UnsafeName(f"name {name[:60]!r} does not match {NAME_PATTERN}")
    if not name.startswith(BUILDER_PREFIX):
        raise UnsafeName(f"name {name[:60]!r} does not carry the builder prefix {BUILDER_PREFIX!r}")
    return name


def assert_request_id(request_id: object) -> str:
    if not isinstance(request_id, str) or not _REQUEST_ID.fullmatch(request_id):
        raise UnsafeName(f"request id {str(request_id)[:60]!r} is not 32 lowercase hex characters")
    return request_id


def assert_op(op: object) -> str:
    if op not in OPS:
        raise UnsafeName(f"op must be one of {OPS}, got {str(op)[:40]!r}")
    return str(op)


def _guard(path: str, template: str, name: str) -> str:
    expected = template.format(name=name)
    if path != expected or posixpath.normpath(path) != path or path.startswith("/") or ".." in path.split("/"):
        raise UnsafeName(f"derived path {path[:120]!r} is not the safe form of {template!r}")
    directory = posixpath.dirname(template.format(name="x"))
    if posixpath.dirname(path) != directory:
        raise UnsafeName(f"derived path {path[:120]!r} escapes {directory!r}")
    return path


def git_path(name: str) -> str:
    """Path in this repository, the only place a builder agent is authored."""
    safe = assert_safe_name(name)
    template = str(fixed()["gitPath"])
    return _guard(template.format(name=safe), template, safe)


def mirror_path(name: str) -> str:
    """Path in the CodeCommit mirror that Argo CD reads."""
    safe = assert_safe_name(name)
    template = str(fixed()["mirrorPath"])
    return _guard(template.format(name=safe), template, safe)


def name_from_git_path(path: str) -> str:
    """Inverse of `git_path`, used to read the current directory without trusting filenames."""
    template = str(fixed()["gitPath"])
    directory = posixpath.dirname(template.format(name="x"))
    if posixpath.dirname(path) != directory or not path.endswith(".json"):
        raise UnsafeName(f"path {path[:120]!r} is not an agent manifest path")
    return assert_safe_name(posixpath.basename(path)[: -len(".json")])


def branch_name(op: str, name: str, request_id: str) -> str:
    """The branch is also the idempotency key: deterministic in (op, name, request id), so
    re-driving the same request resumes the same branch instead of opening a second MR."""
    return f"{BRANCH_PREFIX[assert_op(op)]}/{assert_safe_name(name)}-{assert_request_id(request_id)[:8]}"


def branch_search_prefix(op: str, name: str) -> str:
    """Prefix shared by every branch for this agent and op, which is how a second pending
    request for the same name is detected before two MRs fight over one path."""
    return f"{BRANCH_PREFIX[assert_op(op)]}/{assert_safe_name(name)}-"


def custom_branch(op: str, name: str, idempotency_key: str) -> str:
    """Branch for a caller-supplied idempotency key, for a retry driven outside the request
    id (a replayed CI job, a manual re-drive). Same character class as a branch segment."""
    if not isinstance(idempotency_key, str) or not _IDEMPOTENCY_KEY.fullmatch(idempotency_key):
        raise UnsafeName(f"idempotency key {str(idempotency_key)[:60]!r} does not match {IDEMPOTENCY_KEY_PATTERN}")
    return f"{BRANCH_PREFIX[assert_op(op)]}/{assert_safe_name(name)}-{idempotency_key}"
