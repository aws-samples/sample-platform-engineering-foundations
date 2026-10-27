"""GitOps scaffolder: a validated AgentDraft becomes a branch, a commit and a merge request.

This module never writes to the cluster, and it holds no cluster credential. Its only output
is a change proposed to Git, which keeps Git the single write path (invariant I5) and keeps
the merge request the review gate (ADR-0004).

It drives the established GitLab abstraction of `scripts/open_provision_mrs.py`: any object
with `call(method, path, body=None) -> (status, parsed_body)`. That shape is the seam the
tests fake, so collisions, retries, partial failures and malicious names are exercised
without a token.

Four properties the tests pin down:

- **Create-only.** A manifest already on `main` fails the request instead of being
  overwritten (invariant I10). Editing an existing agent goes through GitLab or `op: disable`.
- **No duplicate name.** A second pending request for the same agent is refused while the
  first branch is still open, instead of two merge requests fighting over one path.
- **Idempotent.** The branch is a pure function of (op, name, request id), so re-driving a
  request resumes: existing branch is reused, existing open merge request is returned, and
  nothing is written twice.
- **Resumable after a lost response.** When a write returns 5xx the scaffolder re-reads the
  state before giving up, so a commit that actually landed is detected rather than repeated.
"""
from __future__ import annotations

import base64
import json
import re
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol, Sequence

from .catalog import COMPILER, fixed
from .compiler import compile_manifest, disable_manifest, draft_sha256, manifest_owner
from .paths import (
    OP_CREATE,
    OP_DISABLE,
    assert_request_id,
    assert_safe_name,
    branch_name,
    branch_search_prefix,
    custom_branch,
    git_path,
    mirror_path,
    name_from_git_path,
)
from .validator import Issue, normalize_draft, validate_draft

MAX_AGENTS = 20
MAX_ACTIVE_PER_REQUESTER = 3
RETRY_STATUSES = (429, 500, 502, 503, 504)
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 1.0
TARGET_BRANCH = "main"

# Persisted states of the Auto-MR item (design secao 6.1). The scaffolder writes none of
# them; it reports which one its outcome maps to, and the caller does the UpdateItem.
PERSISTED_STATUSES = ("pending", "processing", "mr_open", "merged", "failed", "closed")
TERMINAL_STATUSES = ("merged", "failed", "closed")

REFUSAL_CODES = (
    "invalid_draft",
    "already_exists",
    "not_found",
    "duplicate",
    "not_owner",
    "mr_merged",
    "mr_closed",
    "limit_agents",
    "limit_active",
    "manifest_mismatch",
    "gitlab_error",
)


class GitLabPort(Protocol):
    """The established abstraction. One method, so a fake is a dozen lines."""

    def call(self, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
        ...


class ScaffoldRefused(RuntimeError):
    """The change must not be proposed. Carries a machine-readable code so the caller can
    map it to a status and a message without parsing prose."""

    def __init__(self, code: str, detail: str) -> None:
        if code not in REFUSAL_CODES:
            raise ValueError(f"unknown refusal code {code!r}")
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class ExistingAgent:
    name: str
    requester: str
    disabled: bool


@dataclass(frozen=True)
class ScaffoldPlan:
    """Everything the scaffolder will write, computed before a single call is made.

    Building the plan is pure, so the preview in the portal and the recompilation in the CI
    can both produce it and compare, which is how invariant I2 is enforced twice.
    """

    op: str
    name: str
    request_id: str
    requester: str
    owner: str
    path: str
    mirror_path: str
    branch: str
    manifest: bytes
    draft_sha256: str | None
    commit_action: str
    commit_message: str
    mr_title: str
    mr_labels: str
    provenance: dict[str, Any] = field(default_factory=dict)
    warnings: tuple[Issue, ...] = ()

    def mr_description(self, pipeline_url: str = "") -> str:
        tools = self.provenance.get("tools") or []
        rows = [
            ("Agent", f"`{self.name}`"),
            ("Arquivo", f"`{self.path}`"),
            ("Mirror", f"`{self.mirror_path}`"),
            ("Operacao", f"`{self.op}`"),
            ("Solicitante", f"@{self.requester}"),
            ("Dono", f"@{self.owner}"),
            ("Model config", f"`{self.provenance.get('model', '-')}`"),
            ("Tools", ", ".join(f"`{tool}`" for tool in tools) or "nenhuma (responde so pela conversa)"),
            ("Idioma", f"`{self.provenance.get('language', '-')}`"),
            ("Compiler", f"`{self.provenance.get('compiler', COMPILER)}`"),
            ("Request", f"`{self.request_id}`"),
            ("draft-sha256", f"`{self.draft_sha256}`" if self.draft_sha256 else "-"),
            ("Pipeline", pipeline_url or "-"),
        ]
        table = "\n".join(f"| {label} | {value} |" for label, value in rows)
        warnings = "\n".join(f"- `{issue.code}` em `{issue.path}`" for issue in self.warnings)
        body = [
            "Aberto pelo Agent Builder a partir de um AgentDraft validado.",
            "",
            "| Campo | Valor |",
            "|---|---|",
            table,
        ]
        if warnings:
            body += ["", "Avisos do validador (nao bloqueiam):", warnings]
        body += [
            "",
            "O manifest foi gerado pelo compiler do servidor; o portal nao envia manifest e o modelo "
            "nunca ve um. O CI recompila a partir do draft e compara os bytes antes de abrir este MR.",
            "",
            "O merge dispara o mirror para o CodeCommit e o Argo CD, que aplica apenas `kagent.dev/Agent` "
            "no namespace `kagent`. Revise o `systemMessage` e as tools antes de aprovar.",
        ]
        return "\n".join(body)


@dataclass(frozen=True)
class ScaffoldResult:
    status: str
    mr_url: str
    detail: str
    code: str
    reused: bool
    writes: tuple[str, ...]

    @property
    def ok(self) -> bool:
        return self.status == "mr_open"


# ------------------------------------------------------------------ planning (pure)
def plan_create(draft: Any, requester: str, request_id: str, *, caller_is_admin: bool = False) -> ScaffoldPlan:
    """Plan the creation of an agent. Refuses before touching anything when the draft does
    not validate: rendering from an unvalidated draft is the one thing this module must not do."""
    assert_request_id(request_id)
    validation = validate_draft(draft, caller_is_admin=caller_is_admin)
    if not validation.valid:
        raise ScaffoldRefused("invalid_draft", "draft invalid: " + "; ".join(f"{i.path or '/'}:{i.code}" for i in validation.errors))
    normalized = normalize_draft(draft)
    name = assert_safe_name(normalized["name"])
    manifest = compile_manifest(normalized, requester, request_id)
    digest = draft_sha256(normalized)
    return ScaffoldPlan(
        op=OP_CREATE,
        name=name,
        request_id=request_id,
        requester=requester,
        owner=requester,
        path=git_path(name),
        mirror_path=mirror_path(name),
        branch=branch_name(OP_CREATE, name, request_id),
        manifest=manifest,
        draft_sha256=digest,
        commit_action="create",
        commit_message=f"feat(agent): {name} via Agent Builder\n\nRequest {request_id} by {requester}.\ndraft-sha256 {digest}.",
        mr_title=f"feat(agent): {name}",
        mr_labels="provisioning,agent-builder",
        provenance={
            "op": OP_CREATE,
            "requester": requester,
            "owner": requester,
            "model": fixed()["modelConfig"],
            "tools": list(normalized.get("tools") or []),
            "language": normalized["language"],
            "displayName": normalized["displayName"],
            "compiler": COMPILER,
            "requestId": request_id,
            "draftSha256": digest,
            "path": git_path(name),
            "mirrorPath": mirror_path(name),
            "isAdmin": bool(caller_is_admin),
        },
        warnings=validation.warnings,
    )


def plan_disable(name: str, current_manifest: bytes, requester: str, request_id: str, *, caller_is_admin: bool = False) -> ScaffoldPlan:
    """Plan the user-facing rollback (L2). Built from the manifest that is on `main`, not
    from a draft: 5.11 allows a human to edit an agent through GitLab, so the draft is not
    authoritative for what is deployed."""
    assert_request_id(request_id)
    safe = assert_safe_name(name)
    manifest = disable_manifest(current_manifest)
    owner = manifest_owner(current_manifest)
    if owner != requester and not caller_is_admin:
        raise ScaffoldRefused("not_owner", f"{safe} belongs to {owner or 'nobody'}; only the owner or an admin can disable it")
    tools = _tools_of(current_manifest)
    return ScaffoldPlan(
        op=OP_DISABLE,
        name=safe,
        request_id=request_id,
        requester=requester,
        owner=owner,
        path=git_path(safe),
        mirror_path=mirror_path(safe),
        branch=branch_name(OP_DISABLE, safe, request_id),
        manifest=manifest,
        draft_sha256=None,
        commit_action="update",
        commit_message=f"disable: {safe}\n\nRequest {request_id} by {requester}. replicas 0, label platform.appmod/state=disabled.",
        mr_title=f"disable: {safe}",
        mr_labels="agent-builder",
        provenance={
            "op": OP_DISABLE,
            "requester": requester,
            "owner": owner,
            "model": fixed()["modelConfig"],
            "tools": tools,
            "compiler": COMPILER,
            "requestId": request_id,
            "path": git_path(safe),
            "mirrorPath": mirror_path(safe),
            "isAdmin": bool(caller_is_admin),
        },
    )


def _tools_of(manifest: bytes) -> list[str]:
    declarative = (json.loads(manifest.decode("utf-8")).get("spec") or {}).get("declarative") or {}
    for entry in declarative.get("tools") or []:
        server = entry.get("mcpServer") or {}
        if server.get("toolNames"):
            return [str(tool) for tool in server["toolNames"]]
    return []


# ------------------------------------------------------------------ verification hooks (pure)
def verify_recompiled(stored_manifest: bytes, draft: Any, requester: str, request_id: str) -> str:
    """Invariant I2, second enforcement point: recompile from the stored draft and demand
    byte equality with the stored manifest. Returns '' when they agree.

    The CI calls this before pushing, so an item edited directly in DynamoDB fails the
    request with `compiled manifest mismatch` instead of reaching Git.
    """
    try:
        expected = compile_manifest(normalize_draft(draft), requester, request_id)
    except (ValueError, KeyError, TypeError) as error:
        return f"compiled manifest mismatch: draft does not compile ({str(error)[:160]})"
    if expected != stored_manifest:
        return "compiled manifest mismatch: stored manifest is not what the draft compiles to"
    return ""


def describe_manifest(manifest: bytes) -> ExistingAgent:
    """Read an existing manifest as (name, owner, disabled), for the limit check."""
    document = json.loads(manifest.decode("utf-8"))
    metadata = document.get("metadata") or {}
    labels = metadata.get("labels") or {}
    deployment = ((document.get("spec") or {}).get("declarative") or {}).get("deployment") or {}
    return ExistingAgent(
        name=str(metadata.get("name", "")),
        requester=str(labels.get("platform.appmod/requester", "")),
        disabled=labels.get("platform.appmod/state") == "disabled" or deployment.get("replicas") == 0,
    )


def check_limits(existing: Sequence[ExistingAgent], requester: str, *, caller_is_admin: bool = False) -> str:
    """Directory limits of design secao 5.10. Returns '' when the request fits.

    A disabled agent still occupies a file, so it counts toward the directory cap, but it
    serves nobody, so it does not count toward a requester's active quota.
    """
    if len(existing) >= MAX_AGENTS:
        return f"limit reached: the builder directory already holds {len(existing)} agents (max {MAX_AGENTS})"
    if caller_is_admin:
        return ""
    active = sum(1 for agent in existing if agent.requester == requester and not agent.disabled)
    if active >= MAX_ACTIVE_PER_REQUESTER:
        return f"limit reached: {requester} already has {active} active agents (max {MAX_ACTIVE_PER_REQUESTER})"
    return ""


def persisted_status(result: ScaffoldResult) -> str:
    return result.status


def status_detail_field(status: str) -> str:
    """Which item attribute carries the detail, mirroring `finish()` in the CI script."""
    if status not in PERSISTED_STATUSES:
        raise ValueError(f"unknown status {status!r}")
    return "mrUrl" if status == "mr_open" else "error"


# ------------------------------------------------------------------ GitLab drive
class _Client:
    """Thin wrapper over the port: quoting in one place, bounded retry for reads."""

    def __init__(self, gitlab: GitLabPort, sleep: Callable[[float], None] | None = None) -> None:
        self._gitlab = gitlab
        self._sleep = sleep if sleep is not None else time.sleep
        self.writes: list[str] = []

    def get(self, path: str) -> tuple[int, Any]:
        # Reads are safe to repeat, so a 429 or a 5xx from the API is retried rather than
        # turned into a failed request. Writes are never retried blindly.
        for attempt in range(1, RETRY_ATTEMPTS + 1):
            status, body = self._gitlab.call("GET", path)
            if status not in RETRY_STATUSES or attempt == RETRY_ATTEMPTS:
                return status, body
            self._sleep(RETRY_BACKOFF_SECONDS * attempt)
        raise AssertionError("unreachable")

    def post(self, path: str, body: dict[str, Any], label: str) -> tuple[int, Any]:
        self.writes.append(label)
        return self._gitlab.call("POST", path, body)


def _quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def _file_exists(client: _Client, path: str) -> bool:
    status, body = client.get(f"/repository/files/{_quote(path)}?ref={TARGET_BRANCH}")
    if status == 200:
        return True
    if status == 404:
        return False
    raise ScaffoldRefused("gitlab_error", f"could not read {path}: HTTP {status} {str(body)[:160]}")


def _branch_exists(client: _Client, branch: str) -> bool:
    status, body = client.get(f"/repository/branches/{_quote(branch)}")
    if status == 200:
        return True
    if status == 404:
        return False
    raise ScaffoldRefused("gitlab_error", f"could not read branch {branch}: HTTP {status} {str(body)[:160]}")


def _sibling_branches(client: _Client, plan: ScaffoldPlan, branch: str) -> list[str]:
    """Branches of ANOTHER request for this same name and op that still have an open MR.

    Two filters, both needed (review of 13/10/2026, achado 1):
    - the suffix must be exactly the 8 hex characters `branch_name` derives from a request id,
      so `provision/ab-pod-health-ext-11111111` (agent `ab-pod-health-ext`) is not a sibling
      of `ab-pod-health`;
    - the branch must have an OPEN merge request. A branch left behind by an MR closed
      without merge, or by a commit whose MR POST failed, is not a pending request, and
      counting it would lock the name forever with no way out through the portal.
    The Git conflict on the second merge is still the real barrier; this is the early hint.
    """
    prefix = branch_search_prefix(plan.op, plan.name)
    status, body = client.get(f"/repository/branches?search={_quote(prefix)}")
    if status != 200 or not isinstance(body, list):
        # Not fatal: the merge request itself still has to pass CI and review. Losing the
        # duplicate hint is better than refusing a legitimate request on a flaky read.
        return []
    own = re.compile(re.escape(prefix) + r"[0-9a-f]{8}")
    names = [str((item or {}).get("name", "")) for item in body if isinstance(item, dict)]
    candidates = [name for name in names if own.fullmatch(name) and name != branch]
    return [name for name in candidates if any(_is_open_builder_mr(mr) for mr in _merge_requests(client, name))]


def _is_open_builder_mr(mr: dict[str, Any]) -> bool:
    """MR aberto E do builder. O Auto-MR legado (kind infra/agent) usa o mesmo prefixo
    `provision/<name>-<8hex>` e aceita nomes `ab-*`; sem o label, um MR legado aberto travava o
    nome do builder como `duplicate` (review de 13/10/2026, rodada 3, achado R3-4). Os dois
    `mr_labels` do builder carregam `agent-builder`."""
    labels = mr.get("labels") or []
    if isinstance(labels, str):  # o corpo do POST usa vírgulas; a resposta do GitLab, lista
        labels = labels.split(",")
    return mr.get("state") == "opened" and isinstance(labels, list) and "agent-builder" in labels


def _merge_requests(client: _Client, branch: str) -> list[dict[str, Any]]:
    status, body = client.get(f"/merge_requests?state=all&source_branch={_quote(branch)}")
    if status != 200 or not isinstance(body, list):
        return []
    return [item for item in body if isinstance(item, dict)]


def scaffold(
    gitlab: GitLabPort,
    plan: ScaffoldPlan,
    *,
    pipeline_url: str = "",
    idempotency_key: str | None = None,
    sleep: Callable[[float], None] | None = None,
) -> ScaffoldResult:
    """Propose the change in Git and return the merge request URL.

    `idempotency_key` replaces the request-id suffix in the branch, for a replay driven
    outside the original request (a re-run CI job). Omit it and the request id is the key.
    """
    client = _Client(gitlab, sleep)
    branch = custom_branch(plan.op, plan.name, idempotency_key) if idempotency_key is not None else plan.branch
    try:
        return _drive(client, plan, branch, pipeline_url)
    except ScaffoldRefused as refusal:
        return ScaffoldResult("failed", "", refusal.detail, refusal.code, False, tuple(client.writes))


def _drive(client: _Client, plan: ScaffoldPlan, branch: str, pipeline_url: str) -> ScaffoldResult:
    exists = _file_exists(client, plan.path)
    if plan.op == OP_CREATE and exists:
        raise ScaffoldRefused("already_exists", f"{plan.path} already exists on {TARGET_BRANCH}; edit it through GitLab or request a disable")
    if plan.op == OP_DISABLE and not exists:
        raise ScaffoldRefused("not_found", f"{plan.path} is not on {TARGET_BRANCH}; there is nothing to disable")

    had_branch = _branch_exists(client, branch)
    if not had_branch:
        siblings = _sibling_branches(client, plan, branch)
        if siblings:
            raise ScaffoldRefused("duplicate", f"another request for {plan.name} is already open on {siblings[0]}; wait for it to merge or close")
        _commit(client, plan, branch)

    for request in _merge_requests(client, branch):
        state, url = request.get("state"), str(request.get("web_url", ""))
        if state == "opened":
            return ScaffoldResult("mr_open", url, f"merge request already open for {branch}", "", True, tuple(client.writes))
        if state == "merged":
            raise ScaffoldRefused("mr_merged", f"{branch} was already merged; this request is done")
        if state == "closed":
            raise ScaffoldRefused("mr_closed", f"{branch} has a merge request that was closed without merging; open a new request")
    url = _open_mr(client, plan, branch, pipeline_url)
    return ScaffoldResult("mr_open", url, "merge request opened", "", False, tuple(client.writes))


def _commit(client: _Client, plan: ScaffoldPlan, branch: str) -> None:
    status, body = client.post("/repository/commits", {
        "branch": branch,
        "start_branch": TARGET_BRANCH,
        "commit_message": plan.commit_message,
        "actions": [{"action": plan.commit_action, "file_path": plan.path, "content": plan.manifest.decode("utf-8")}],
    }, "commit")
    if status == 201:
        return
    # The response was lost, not necessarily the write. The branch did not exist a moment
    # ago, so if it exists now this commit is the one that created it: resume instead of
    # repeating the POST, which would stack a second commit on the branch.
    if status in RETRY_STATUSES and _branch_exists(client, branch):
        return
    raise ScaffoldRefused("gitlab_error", f"commit failed: HTTP {status} {str(body)[:200]}")


def _open_mr(client: _Client, plan: ScaffoldPlan, branch: str, pipeline_url: str) -> str:
    status, body = client.post("/merge_requests", {
        "source_branch": branch,
        "target_branch": TARGET_BRANCH,
        "remove_source_branch": True,
        "labels": plan.mr_labels,
        "title": plan.mr_title,
        "description": plan.mr_description(pipeline_url),
    }, "merge_request")
    if status == 201 and isinstance(body, dict):
        return str(body.get("web_url", ""))
    if status in RETRY_STATUSES:
        for request in _merge_requests(client, branch):
            if request.get("state") == "opened":
                return str(request.get("web_url", ""))
    raise ScaffoldRefused("gitlab_error", f"merge request failed: HTTP {status} {str(body)[:200]}")


# ------------------------------------------------------------------ directory reading
def read_directory(gitlab: GitLabPort, *, sleep: Callable[[float], None] | None = None) -> list[ExistingAgent]:
    """List the builder agents on `main`, for `check_limits`. Files that do not parse or do
    not carry the builder label are ignored: the manifest validator is what rejects those."""
    client = _Client(gitlab, sleep)
    directory = fixed()["gitPath"].format(name="x").rsplit("/", 1)[0]
    per_page = 100
    status, body = client.get(f"/repository/tree?path={_quote(directory)}&ref={TARGET_BRANCH}&per_page={per_page}")
    if status != 200 or not isinstance(body, list):
        raise ScaffoldRefused("gitlab_error", f"could not list {directory}: HTTP {status} {str(body)[:160]}")
    if len(body) >= per_page:
        # A full page may be a truncated one, and a truncated listing counted as a total
        # would silently raise the effective cap. Refuse instead of guessing.
        raise ScaffoldRefused("gitlab_error", f"{directory} returned a full page of {per_page} entries; the listing may be truncated")
    agents: list[ExistingAgent] = []
    for entry in body:
        name = str((entry or {}).get("name", ""))
        if not name.endswith(".json"):
            continue
        path = f"{directory}/{name}"
        try:
            name_from_git_path(path)
        except ValueError:
            continue
        code, payload = client.get(f"/repository/files/{_quote(path)}?ref={TARGET_BRANCH}")
        if code != 200 or not isinstance(payload, dict):
            continue
        try:
            raw = base64.b64decode(payload["content"]) if payload.get("encoding") == "base64" else str(payload.get("content", "")).encode("utf-8")
            agents.append(describe_manifest(raw))
        except (KeyError, ValueError, json.JSONDecodeError):
            continue
    return agents
