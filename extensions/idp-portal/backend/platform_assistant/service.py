"""AssistantService: the one implementation behind the portal route and the MCP tool.

Every operation takes the caller as resolved by the transport (the internal gateway session alias for the
portal, the MCP server's authenticated principal for MCP) and authorizes it HERE, server-side,
against the project contract. Hiding a button changes nothing: a direct call from someone
outside the project is refused by the same code that serves the UI.

ACTIONS is the allowlist. There is no action that writes to AWS, Kubernetes or Git: the writes
are provision requests and plan records (see ports.py), and the CI and GitOps do the rest.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from . import planner, runs
from .catalog import load_index
from .ports import ObservationUnavailable, PlanStore, ProjectDirectory, RequestStore, ResourceObserver

# action -> needs a write role in the project
ACTIONS: dict[str, bool] = {
    "draft": False, "preview": False, "get": False, "refresh": False, "compensation_preview": False,
    "submit": True, "retry": True, "compensation_confirm": True,
}
WRITE_ROLES = frozenset({"owner", "developer"})
CHANNELS = frozenset({"portal", "mcp"})
PROJECT_PATTERN = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
IDEMPOTENCY_KEY_PATTERN = re.compile(r"[A-Za-z0-9_-]{8,64}")
PLAN_ID_PATTERN = re.compile(r"[0-9a-f]{32}")
SHA_PATTERN = re.compile(r"[0-9a-f]{64}")
MAX_PROMPT = 2000
MAX_SELECTION = 10
SAVE_ATTEMPTS = 3


@dataclass(frozen=True)
class Caller:
    alias: str
    is_admin: bool
    channel: str


class AssistantError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any):
        super().__init__(message)
        self.status, self.code, self.extra = status, code, extra

    def body(self) -> dict[str, Any]:
        return {"error": str(self), "code": self.code, **self.extra}


class Model(Protocol):
    def propose(self, instructions: str, prompt: str, context: dict[str, Any]) -> str: ...


def sanitize_selection(selection: Any) -> list[dict[str, str]]:
    """The context the model may see: at most MAX_SELECTION (capability, name) pairs, each checked."""
    picked = []
    for entry in (selection if isinstance(selection, list) else [])[:MAX_SELECTION]:
        if isinstance(entry, dict) and isinstance(entry.get("name"), str) and planner.NAME_PATTERN.fullmatch(entry["name"]) \
                and isinstance(entry.get("capability"), str) and len(entry["capability"]) <= 80:
            picked.append({"capability": entry["capability"], "name": entry["name"]})
    return picked


def propose_plan(model: Model, index: dict[str, Any], project: str, prompt: Any,
                 selection: Any = None) -> tuple[dict[str, Any] | None, list[planner.Issue]]:
    """Ask the model for a provision-plan/v1 object. Returns (candidate, issues) and writes nothing.

    The one model boundary shared by the platform-api and the BFF (which is where the gateway is
    reachable): the prompt length is checked, the context is only the sanitized selection, and the
    answer is DATA that `interpret_model_output` accepts or refuses. A candidate still has to pass
    `preview` before anything can be submitted.
    """
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT:
        raise AssistantError(400, "prompt_invalid", f"prompt is 1 to {MAX_PROMPT} characters")
    context = {"project": project, "selection": sanitize_selection(selection)}
    output = model.propose(planner.model_instructions(index), prompt, context)
    return planner.interpret_model_output(output)


class AssistantService:
    def __init__(self, *, plans: PlanStore, requests: RequestStore, observer: ResourceObserver,
                 projects: ProjectDirectory, model: Model | None = None,
                 index: Callable[[], dict[str, Any]] = load_index, clock: Callable[[], float] = time.time,
                 approver: Callable[[bytes], bytes] | None = None):
        """`approver` MACs a confirmed removal (approval.KmsMac.generate over the platform-api key).
        Without it a rollback stays `undo_blocked` and writes nothing: there is no unsigned removal."""
        self._plans, self._requests, self._observer = plans, requests, observer
        self._projects, self._model, self._index, self._clock = projects, model, index, clock
        self._approver = approver

    # ------------------------------------------------------------------ authz
    def _now(self) -> int:
        return int(self._clock())

    def _authorize(self, caller: Caller, project: Any, action: str):
        if action not in ACTIONS:
            raise AssistantError(400, "action_not_allowed", f"{action!r} is not an assistant action")
        if caller.channel not in CHANNELS:
            raise AssistantError(400, "channel_invalid", "unknown channel")
        if not isinstance(project, str) or not PROJECT_PATTERN.fullmatch(project):
            raise AssistantError(400, "project_invalid", "project is a lowercase DNS label")
        member = self._projects.membership(project, caller.alias)
        if member is None:
            if caller.is_admin and not ACTIONS[action]:
                return None
            raise AssistantError(403, "not_a_project_member", f"{caller.alias} is not a member of {project}")
        if ACTIONS[action] and member.role not in WRITE_ROLES:
            raise AssistantError(403, "role_cannot_write", f"role {member.role} cannot {action} in {project}")
        return member

    def _load(self, caller: Caller, plan_id: Any, action: str) -> tuple[dict[str, Any], Any]:
        if not isinstance(plan_id, str) or not PLAN_ID_PATTERN.fullmatch(plan_id):
            raise AssistantError(400, "plan_id_invalid", "planId is 32 hex characters")
        run = self._plans.get(plan_id)
        if run is None:
            raise AssistantError(404, "plan_not_found", "plan not found")
        try:
            member = self._authorize(caller, run["project"], action)
        except AssistantError as error:
            # Someone else's plan answers like a missing one, so plan ids cannot be probed.
            if error.code == "not_a_project_member":
                raise AssistantError(404, "plan_not_found", "plan not found") from None
            raise
        return run, member

    def _mutate(self, plan_id: str, change: Callable[[dict[str, Any]], Any]) -> tuple[dict[str, Any], Any]:
        for _ in range(SAVE_ATTEMPTS):
            run = self._plans.get(plan_id)
            version = run["version"]
            result = change(run)
            run["version"] = version + 1
            if self._plans.save(run, version):
                return run, result
        raise AssistantError(409, "concurrent_update", "the plan changed concurrently; read it again")

    def _can_write(self, project: str) -> Callable[[str], bool]:
        """Re-reads the project contract for an alias at the instant of a write. Read-only or
        retired project, removed membership, viewer role or an unsupported project: False."""
        def check(alias: str) -> bool:
            try:
                member = self._projects.membership(project, alias)
            except AssistantError:
                return False
            return member is not None and member.role in WRITE_ROLES
        return check

    @staticmethod
    def _require_owner(caller: Caller, run: dict[str, Any], action: str) -> None:
        """Retry and rollback act on someone's plan: only its requester, or a platform admin."""
        if caller.alias != run["requester"] and not caller.is_admin:
            raise AssistantError(403, "not_plan_owner", f"only {run['requester']} or a platform admin can {action} this plan")

    def _advance(self, run: dict[str, Any]) -> None:
        try:
            runs.advance(run, self._index(), self._requests, self._observer, self._now(),
                         can_write=self._can_write(run["project"]), approver=self._approver)
        except runs.PlanNoLongerValid as error:
            raise AssistantError(409, "plan_no_longer_valid", str(error), errors=error.errors) from None

    @staticmethod
    def _actor(caller: Caller, member: Any) -> dict[str, Any]:
        # The alias is always the CALLER: an admin acting on someone's plan is recorded as the admin.
        persona = "Platform Admin" if caller.is_admin or member is None else member.persona
        return {"type": "human", "alias": caller.alias, "persona": persona, "channel": caller.channel}

    def _check_absent(self, step: planner.Step, namespace: str, errors: list, warnings: list) -> None:
        """A preexisting object is refused: the plan never creates over it, so it can never undo it."""
        where = f"/items/{step.index}/name"
        try:
            existing = self._observer.observe(namespace, step.capability["kind"], step.name)
        except ObservationUnavailable:
            # Not knowing is not absence: the plan cannot be confirmed until the cluster answers.
            errors.append(planner.Issue(where, "existence_unchecked",
                                        "the cluster could not be read, so absence is unknown; try again"))
            return
        if existing is not None:
            errors.append(planner.Issue(where, "already_exists",
                                        f"{step.capability['kind']} {step.name} already exists in {namespace}"))

    # ------------------------------------------------------------------ preview
    def _preview(self, caller: Caller, project: str, raw: Any, member: Any, check_existing: bool = True) -> dict[str, Any]:
        index = self._index()
        plan = planner.build_plan(raw, index)
        namespace = member.namespace if member else "appmod"
        errors, warnings = list(plan.errors), list(plan.warnings)
        steps: list[dict[str, Any]] = []
        for label in (project, caller.alias):
            if not planner.LABEL_VALUE.fullmatch(label):
                errors.append(planner.Issue("/", "label_invalid", f"{label!r} cannot be a Kubernetes label value"))
        for position, step in enumerate(plan.steps):
            if check_existing:
                self._check_absent(step, namespace, errors, warnings)
            steps.append({
                "ref": step.ref, "order": position + 1, "capability": step.capability["id"],
                "displayName": step.capability["displayName"], "displayNamePt": step.capability["displayNamePt"],
                "lifecycle": step.capability["lifecycle"], "kind": step.capability["kind"], "name": step.name,
                "path": step.path, "change": "create", "dependsOn": step.depends_on, "inputs": step.inputs,
                "defaults": step.defaults, "references": step.references,
                "deletionPolicy": step.deletion_policy, "readyCondition": step.capability["readyCondition"],
                "outputs": step.capability["outputs"], "cost": step.capability["cost"],
                "manifest": planner.compile_instance(step, plan_id="preview", project=project, namespace=namespace,
                                                     requester=caller.alias) if not errors else None,
            })
        normalized = plan.normalized()
        valid = not errors
        return {
            "valid": valid, "errors": [e.as_dict() for e in errors], "warnings": [w.as_dict() for w in warnings],
            "project": project, "namespace": namespace, "summary": plan.summary, "plan": normalized,
            "planSha256": planner.plan_sha256(normalized, project, namespace) if valid else None,
            "compiler": planner.COMPILER, "steps": steps,
            "executor": {"requestedBy": self._actor(caller, member), "executedBy": runs.ASSISTANT_ACTOR,
                         "writePath": "provision request -> GitLab CI merge request -> Argo CD -> kro/ACK"},
            "secrets": "never shown here: use the authorized retrieval of each capability",
        }

    def preview(self, caller: Caller, project: Any, plan: Any) -> dict[str, Any]:
        member = self._authorize(caller, project, "preview")
        return self._preview(caller, project, plan, member)

    def draft(self, caller: Caller, project: Any, prompt: Any, selection: Any = None) -> dict[str, Any]:
        member = self._authorize(caller, project, "draft")
        if self._model is None:
            raise AssistantError(503, "model_unavailable", "no model is configured; write or edit the plan instead")
        candidate, issues = propose_plan(self._model, self._index(), project, prompt, selection)
        if candidate is None:
            return {"modelOutputAccepted": False, "errors": [i.as_dict() for i in issues], "preview": None}
        return {"modelOutputAccepted": True, "errors": [], "preview": self._preview(caller, project, candidate, member)}

    # ------------------------------------------------------------------ submit
    def submit(self, caller: Caller, project: Any, plan: Any, idempotency_key: Any, confirm_sha: Any) -> tuple[int, dict[str, Any]]:
        member = self._authorize(caller, project, "submit")
        if not isinstance(idempotency_key, str) or not IDEMPOTENCY_KEY_PATTERN.fullmatch(idempotency_key):
            raise AssistantError(400, "idempotency_key_invalid", "idempotencyKey is 8 to 64 of [A-Za-z0-9_-]")
        plan_id = runs.plan_id_for(caller.alias, project, idempotency_key)
        existing = self._plans.get(plan_id)
        # A replay compares the plan only: its objects exist now, BECAUSE of this plan.
        preview = self._preview(caller, project, plan, member, check_existing=existing is None)
        if not preview["valid"]:
            # Fails before ANY request record: no MR can exist for an invalid plan.
            raise AssistantError(422, "plan_invalid", "the plan does not validate", errors=preview["errors"])
        sha = preview["planSha256"]
        if existing is None:
            if confirm_sha != sha:
                raise AssistantError(409, "confirmation_mismatch",
                                     "confirm the plan you previewed: it changed or was not confirmed", planSha256=sha)
            run = runs.new_run(plan=planner.build_plan(plan, self._index()), plan_id=plan_id,
                               idempotency_key=idempotency_key, sha=sha, project=project, namespace=preview["namespace"],
                               requester=caller.alias, persona=member.persona, channel=caller.channel, now=self._now())
            if self._plans.create(run):
                run, _ = self._mutate(plan_id, self._advance)
                return 201, {"replayed": False, "run": run}
            existing = self._plans.get(plan_id)
        if existing["planSha256"] != sha:
            raise AssistantError(409, "idempotency_key_reused", "this idempotencyKey already confirmed a different plan",
                                 planId=plan_id)
        return 200, {"replayed": True, "run": existing}

    # ------------------------------------------------------------------ lifecycle
    def get(self, caller: Caller, plan_id: Any) -> dict[str, Any]:
        run, _ = self._load(caller, plan_id, "get")
        return {"run": run}

    def refresh(self, caller: Caller, plan_id: Any) -> dict[str, Any]:
        self._load(caller, plan_id, "refresh")
        run, _ = self._mutate(plan_id, self._advance)
        return {"run": run}

    def retry(self, caller: Caller, plan_id: Any, ref: Any, expected_attempt: Any) -> dict[str, Any]:
        loaded, member = self._load(caller, plan_id, "retry")
        self._require_owner(caller, loaded, "retry")
        if not isinstance(expected_attempt, int) or isinstance(expected_attempt, bool):
            raise AssistantError(400, "attempt_invalid", "expectedAttempt is an integer")

        def change(run: dict[str, Any]) -> bool:
            try:
                fresh = runs.retry(run, str(ref), expected_attempt, self._actor(caller, member), self._now())
            except runs.RetryRefused as error:
                raise AssistantError(409, error.code, str(error)) from None
            if fresh:
                self._advance(run)
            return fresh

        run, fresh = self._mutate(plan_id, change)
        return {"replayed": not fresh, "run": run}

    def compensation_preview(self, caller: Caller, plan_id: Any) -> dict[str, Any]:
        run, _ = self._load(caller, plan_id, "compensation_preview")
        try:
            return runs.compensation_preview(run, self._index())
        except runs.PlanNoLongerValid as error:
            raise AssistantError(409, "plan_no_longer_valid", str(error), errors=error.errors) from None

    def compensation_confirm(self, caller: Caller, plan_id: Any, confirm_sha: Any) -> dict[str, Any]:
        loaded, member = self._load(caller, plan_id, "compensation_confirm")
        self._require_owner(caller, loaded, "roll back")
        if not isinstance(confirm_sha, str) or not SHA_PATTERN.fullmatch(confirm_sha):
            raise AssistantError(400, "confirmation_invalid", "send the compensationSha256 you previewed")

        def change(run: dict[str, Any]) -> bool:
            current = run.get("compensation")
            if current:
                if current["compensationSha256"] != confirm_sha:
                    raise AssistantError(409, "compensation_already_started", "a different rollback is running")
                return False
            preview = runs.compensation_preview(run, self._index())
            if preview["blocking"]:
                raise AssistantError(409, preview["blocking"][0]["code"], preview["blocking"][0]["message"])
            if preview["compensationSha256"] != confirm_sha:
                raise AssistantError(409, "confirmation_mismatch", "the rollback changed since you previewed it",
                                     compensationSha256=preview["compensationSha256"])
            runs.start_compensation(run, preview, self._actor(caller, member), self._now())
            self._advance(run)
            return True

        run, fresh = self._mutate(plan_id, change)
        return {"replayed": not fresh, "run": run}
