"""Plan runs: deterministic reconcile of a confirmed plan through the governed control plane.

`advance` is the whole executor. It is idempotent and safe to call any number of times, from a
UI poll or a scheduled sweep: every write it makes is a conditional put under an id derived
from (plan, step, attempt), so a repeated call, a lost response or two concurrent callers can
never create a request twice. Every state comes from something read in the same call (the
request record the CI writes, the object the cluster-api reads), never from what the assistant
hopes happened, and every change of state becomes one timeline event.

Step states:

    planned -> waiting -> submitted -> mr_open -> syncing -> reconciling -> ready
                               \\-> failed | cancelled          (retry allowed, nothing was created)
    blocked: a dependency failed, or the requester can no longer write (project_not_writable)

Compensation (only after an explicit preview and a confirmation of its hash) walks the steps
this plan CREATED in reverse dependency order:

    undo_planned -> undo_submitted -> undo_mr_open -> removing -> removed
    undo_blocked: the confirmer can no longer write, or the approval could not be signed; resumes
                  on the next advance once the authority or KMS is back

Every removal request carries a KMS HMAC approval proof (approval.py) over its identity, who
requested and who confirmed it and its expiry. Without the proof no removal is written: the CI
and the GitOps mirror refuse any removal that lacks it, so a record forged in the table by another
pipeline can never become a delete.
"""
from __future__ import annotations

import hashlib
from typing import Any, Callable

from . import approval, planner
from .ports import REMOVAL_KIND, REMOVAL_PENDING, ObservationUnavailable, RequestStore, ResourceObserver
from .schema import validate as validate_schema

MAX_EVENTS = 200
REQUEST_TTL_SECONDS = 30 * 24 * 3600
ASSISTANT_ACTOR = {"type": "agent", "persona": "Catalog Agent", "identity": "platform-assistant"}
CI_ACTOR = {"type": "system", "persona": "GitLab CI", "identity": "open-provision-mrs"}
GITOPS_ACTOR = {"type": "system", "persona": "Argo CD + kro", "identity": "cluster"}

IN_FLIGHT = {"submitted", "mr_open", "syncing", "reconciling"}
CREATED = {"syncing", "reconciling", "ready"}
RETRYABLE = {"failed", "cancelled"}
UNDO_IN_FLIGHT = {"undo_submitted", "undo_mr_open", "removing"}


def derive_id(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:32]


def plan_id_for(requester: str, project: str, idempotency_key: str) -> str:
    """Same caller, project and key: same plan. Another caller reusing the key gets another plan."""
    return derive_id("plan", requester, project, idempotency_key)


def step_request_id(plan_id: str, ref: str, attempt: int) -> str:
    return derive_id("step", plan_id, ref, str(attempt))


def removal_request_id(plan_id: str, ref: str) -> str:
    return derive_id("undo", plan_id, ref)


def _event(run: dict[str, Any], now: int, ref: str | None, kind: str, source: str, actor: dict[str, Any],
           before: str = "", after: str = "", detail: dict[str, Any] | None = None) -> None:
    run["events"].append({"seq": len(run["events"]) + run.get("eventsDropped", 0), "at": now, "ref": ref,
                          "type": kind, "source": source, "from": before, "to": after,
                          "actor": actor, "detail": detail or {}})
    if len(run["events"]) > MAX_EVENTS:
        run["events"].pop(0)
        run["eventsDropped"] = run.get("eventsDropped", 0) + 1


def _transition(run: dict[str, Any], now: int, ref: str, new: str, source: str, actor: dict[str, Any],
                detail: dict[str, Any] | None = None) -> None:
    step = run["steps"][ref]
    old = step["state"]
    if old == new and not detail:
        return
    if old == new and detail == step.get("lastDetail"):
        return
    step["state"] = new
    step["lastDetail"] = detail or {}
    _event(run, now, ref, "step_state", source, actor, old, new, detail)


def new_run(*, plan: planner.Plan, plan_id: str, idempotency_key: str, sha: str, project: str, namespace: str,
            requester: str, persona: str, channel: str, now: int) -> dict[str, Any]:
    human = {"type": "human", "alias": requester, "persona": persona, "channel": channel}
    run: dict[str, Any] = {
        "planId": plan_id, "idempotencyKey": idempotency_key, "planSha256": sha, "compiler": planner.COMPILER,
        "project": project, "namespace": namespace, "requester": requester, "persona": persona, "channel": channel,
        "plan": plan.normalized(), "order": [s.ref for s in plan.steps], "state": "running",
        "createdAt": now, "updatedAt": now, "version": 1, "events": [], "compensation": None,
        "steps": {s.ref: {"state": "planned", "attempt": 1, "requestId": None, "mrUrl": "", "error": "",
                          "outputs": {}, "observed": None, "observedError": "", "createdByPlan": False,
                          "lastDetail": {}} for s in plan.steps},
    }
    _event(run, now, None, "plan_confirmed", "assistant", human, detail={"planSha256": sha, "steps": run["order"]})
    return run


def _plan_steps(run: dict[str, Any], index: dict[str, Any]) -> dict[str, planner.Step]:
    """Rebuild the steps from the stored normalized plan. Validated again: the index may have
    changed since confirmation, and a capability that left the catalog must stop the plan."""
    plan = planner.build_plan(run["plan"], index)
    if not plan.valid:
        raise PlanNoLongerValid([e.as_dict() for e in plan.errors])
    return {s.ref: s for s in plan.steps}


class PlanNoLongerValid(RuntimeError):
    def __init__(self, errors: list[dict[str, str]]):
        super().__init__("the stored plan no longer validates against the published catalog")
        self.errors = errors


def _resolve(step: planner.Step, run: dict[str, Any]) -> tuple[dict[str, str], list[dict[str, str]]]:
    """Take each referenced value from the OBSERVED outputs of its dependency, then validate it
    against the target field's schema. An output is data from the cluster, not trusted input."""
    resolved: dict[str, str] = {}
    problems: list[dict[str, str]] = []
    props = step.capability["schema"].get("properties") or {}
    for ref in step.references:
        value = run["steps"][ref["fromRef"]]["outputs"].get(ref["output"])
        if not isinstance(value, str) or not value:
            problems.append({"field": ref["field"], "code": "output_missing",
                             "message": f"{ref['fromRef']} is Ready but did not publish {ref['output']}"})
            continue
        issues = validate_schema(value, props.get(ref["field"]) or {})
        if issues or planner.CONTROL.search(value) or len(value) > planner.MAX_STRING:
            problems.append({"field": ref["field"], "code": "output_invalid",
                             "message": f"{ref['fromRef']}.{ref['output']} does not fit {ref['field']}"})
            continue
        resolved[ref["field"]] = value
    return resolved, problems


def _creation_request(run: dict[str, Any], step: planner.Step, manifest: str, now: int) -> dict[str, Any]:
    state = run["steps"][step.ref]
    return {
        # Exactly the fields the CI job reads for kind=infra, plus the plan trail it ignores.
        "requestId": state["requestId"], "status": "pending", "requester": run["requester"], "kind": "infra",
        "name": step.name, "capability": step.capability["id"], "path": step.path, "manifest": manifest,
        "planId": run["planId"], "planStep": step.ref, "attempt": state["attempt"], "project": run["project"],
        "namespace": run["namespace"], "channel": run["channel"], "createdAt": now,
        "expiresAt": now + REQUEST_TTL_SECONDS,
    }


def _owned(observation: dict[str, Any] | None, run: dict[str, Any], ref: str) -> bool:
    labels = (observation or {}).get("labels") or {}
    return (labels.get("platform.appmod/plan-id") == run["planId"]
            and labels.get("platform.appmod/plan-step") == ref)


def _observe_created(run: dict[str, Any], step: planner.Step, observer: ResourceObserver, now: int) -> None:
    state = run["steps"][step.ref]
    try:
        observation = observer.observe(run["namespace"], step.capability["kind"], step.name)
    except ObservationUnavailable as error:
        if state["observedError"] != str(error):
            state["observedError"] = str(error)
            _event(run, now, step.ref, "observation_unavailable", "cluster", GITOPS_ACTOR, detail={"error": str(error)})
        return
    state["observedError"] = ""
    if observation is None:
        _transition(run, now, step.ref, "syncing", "argo", GITOPS_ACTOR, {"message": "merged; waiting for Argo CD"})
        return
    if not _owned(observation, run, step.ref):
        # Something with this name exists but this plan did not create it. Never adopt it.
        _transition(run, now, step.ref, "failed", "cluster", GITOPS_ACTOR,
                    {"code": "foreign_object", "message": "an object with this name is not owned by this plan"})
        return
    state["observed"] = {k: observation.get(k) for k in ("ready", "readyReason", "readyCondition", "conditions", "argo")}
    if observation.get("ready") is True:
        state["outputs"] = {k: v for k, v in (observation.get("outputs") or {}).items() if k in step.capability["outputs"]}
        _transition(run, now, step.ref, "ready", "condition", GITOPS_ACTOR,
                    {"readyCondition": observation.get("readyCondition", ""), "argo": observation.get("argo", {})})
    else:
        _transition(run, now, step.ref, "reconciling", "condition", GITOPS_ACTOR,
                    {"reason": observation.get("readyReason", ""), "argo": observation.get("argo", {})})


def _advance_creation(run: dict[str, Any], steps: dict[str, planner.Step], requests: RequestStore,
                      observer: ResourceObserver, now: int, can_write: Callable[[str], bool]) -> None:
    for ref in run["order"]:
        step, state = steps[ref], run["steps"][ref]
        if state["state"] == "ready":
            continue
        dep_states = [run["steps"][d]["state"] for d in step.depends_on]
        if state["requestId"] is None:
            if any(s in RETRYABLE | {"blocked"} for s in dep_states):
                _transition(run, now, ref, "blocked", "assistant", ASSISTANT_ACTOR,
                            {"message": "a dependency failed; this step will not be submitted"})
                continue
            if any(s != "ready" for s in dep_states):
                _transition(run, now, ref, "waiting", "assistant", ASSISTANT_ACTOR,
                            {"waitingFor": [d for d in step.depends_on if run["steps"][d]["state"] != "ready"]})
                continue
            resolved, problems = _resolve(step, run)
            if problems:
                _transition(run, now, ref, "failed", "assistant", ASSISTANT_ACTOR, {"code": problems[0]["code"],
                            "message": problems[0]["message"]})
                state["error"] = problems[0]["message"]
                continue
            # Absence is OBSERVED right before the write, never assumed from the preview: something
            # may have appeared since. A read failure keeps the step planned; it never adopts.
            try:
                existing = observer.observe(run["namespace"], step.capability["kind"], step.name)
            except ObservationUnavailable as error:
                _transition(run, now, ref, "planned", "cluster", GITOPS_ACTOR,
                            {"code": "existence_unchecked", "message": f"the cluster could not be read: {error}"})
                continue
            if existing is not None:
                code = "already_exists" if _owned(existing, run, ref) else "foreign_object"
                state["error"] = f"{step.capability['kind']} {step.name} already exists in {run['namespace']}"
                _transition(run, now, ref, "failed", "cluster", GITOPS_ACTOR, {"code": code, "message": state["error"]})
                continue
            # Write authority is re-read now, not taken from the confirmation: a project that went
            # read-only, or a requester who left it, stops the plan before the next request.
            if not can_write(run["requester"]):
                _transition(run, now, ref, "blocked", "assistant", ASSISTANT_ACTOR,
                            {"code": "project_not_writable",
                             "message": f"{run['requester']} can no longer write in {run['project']}"})
                continue
            manifest = planner.compile_instance(step, plan_id=run["planId"], project=run["project"],
                                                namespace=run["namespace"], requester=run["requester"],
                                                resolved=resolved)
            state["requestId"] = step_request_id(run["planId"], ref, state["attempt"])
            created = requests.put_if_absent(_creation_request(run, step, manifest, now))
            _transition(run, now, ref, "submitted", "request", ASSISTANT_ACTOR,
                        {"requestId": state["requestId"], "attempt": state["attempt"], "path": step.path,
                         "replayed": not created})
            continue
        record = requests.get(state["requestId"]) or {}
        status = record.get("status", "")
        if status == "processing":
            _transition(run, now, ref, "submitted", "request", CI_ACTOR, {"requestStatus": "processing"})
        elif status == "pending":
            pass  # still queued for the CI job; nothing new to show
        elif status == "mr_open":
            state["mrUrl"] = record.get("mrUrl", "")
            _transition(run, now, ref, "mr_open", "mr", CI_ACTOR, {"mrUrl": state["mrUrl"]})
        elif status == "failed":
            state["error"] = record.get("error", "")[:300]
            _transition(run, now, ref, "failed", "request", CI_ACTOR, {"code": "request_failed", "message": state["error"]})
        elif status == "closed" and not state["createdByPlan"]:
            _transition(run, now, ref, "cancelled", "mr", CI_ACTOR, {"message": "merge request closed without merge"})
        elif status in ("merged", "closed"):
            if not state["createdByPlan"]:
                state["createdByPlan"] = True
                state["mrUrl"] = state["mrUrl"] or record.get("mrUrl", "")
                _event(run, now, ref, "mr_merged", "mr", CI_ACTOR, detail={"mrUrl": state["mrUrl"]})
            _observe_created(run, step, observer, now)
        # Missing record or an unknown status: stay put. A guess here would be a fake state.


def _undo_targets(run: dict[str, Any]) -> list[str]:
    return [ref for ref in reversed(run["order"]) if run["steps"][ref]["createdByPlan"]
            and run["steps"][ref]["state"] != "failed"]


def removal_effect(deletion_policy: str) -> str:
    """What removing the platform object does to the AWS resource. One text for the preview and the MR."""
    if deletion_policy == "retain":
        return "removes the platform object; the AWS resource is RETAINED (deletionPolicy retain)"
    return "removes the platform object and the AWS resource"


def compensation_preview(run: dict[str, Any], index: dict[str, Any]) -> dict[str, Any]:
    """What a rollback of THIS plan would do, before anyone confirms it. Pure read."""
    steps = _plan_steps(run, index)
    in_flight = [ref for ref in run["order"] if run["steps"][ref]["state"] in IN_FLIGHT - CREATED]
    targets, untouched = [], []
    for ref in reversed(run["order"]):
        state, step = run["steps"][ref], steps[ref]
        if ref in _undo_targets(run):
            targets.append({"ref": ref, "name": step.name, "path": step.path, "capability": step.capability["id"],
                            "kind": step.capability["kind"], "requestId": state["requestId"],
                            "deletionPolicy": step.deletion_policy, "effect": removal_effect(step.deletion_policy)})
        else:
            untouched.append({"ref": ref, "name": step.name, "reason": (
                "foreign object: not created by this plan"
                if state.get("lastDetail", {}).get("code") in ("foreign_object", "already_exists")
                else f"nothing was created ({state['state']})")})
    blocking = []
    if in_flight:
        blocking.append({"code": "in_flight", "message": "resolve the open requests or merge requests first: "
                         + ", ".join(in_flight)})
    if not targets:
        blocking.append({"code": "nothing_to_undo", "message": "this plan has not created anything"})
    sha = hashlib.sha256(planner.canonical({"planId": run["planId"], "targets": targets})).hexdigest()
    return {"planId": run["planId"], "compensationSha256": sha, "order": [t["ref"] for t in targets],
            "targets": targets, "untouched": untouched, "blocking": blocking, "allowed": not blocking}


def start_compensation(run: dict[str, Any], preview: dict[str, Any], actor: dict[str, Any], now: int) -> None:
    run["compensation"] = {"compensationSha256": preview["compensationSha256"], "confirmedAt": now,
                           "confirmedBy": actor, "order": preview["order"],
                           "steps": {t["ref"]: {"state": "undo_planned", "requestId": None, "mrUrl": "", "error": "",
                                                "target": t} for t in preview["targets"]}}
    run["state"] = "compensating"
    _event(run, now, None, "compensation_confirmed", "assistant", actor,
           detail={"compensationSha256": preview["compensationSha256"], "order": preview["order"]})


def _undo_transition(run: dict[str, Any], now: int, ref: str, new: str, source: str, actor: dict[str, Any],
                     detail: dict[str, Any] | None = None) -> None:
    undo = run["compensation"]["steps"][ref]
    if undo["state"] == new:
        return
    old, undo["state"] = undo["state"], new
    _event(run, now, ref, "undo_state", source, actor, old, new, detail)


def _advance_compensation(run: dict[str, Any], requests: RequestStore, observer: ResourceObserver, now: int,
                          can_write: Callable[[str], bool], approver: Callable[[bytes], bytes] | None) -> None:
    comp = run["compensation"]
    confirmer = (comp.get("confirmedBy") or {}).get("alias", "")
    for position, ref in enumerate(comp["order"]):
        undo = comp["steps"][ref]
        if undo["state"] == "removed":
            continue
        # Dependents first: a step is undone only after everything after it is gone.
        if any(comp["steps"][prev]["state"] != "removed" for prev in comp["order"][:position]):
            return
        target = undo["target"]
        if undo["requestId"] is None:
            # Same rule as a creation: the one who confirmed must still be able to write, now.
            if not confirmer or not can_write(confirmer):
                _undo_transition(run, now, ref, "undo_blocked", "assistant", ASSISTANT_ACTOR,
                                 {"code": "project_not_writable",
                                  "message": f"{confirmer or 'the confirmer'} can no longer write in {run['project']}"})
                return
            request_id = removal_request_id(run["planId"], ref)
            # `requester` stays the plan's owner (the label on the file); `confirmer` is who
            # confirmed THIS rollback, which the CI re-checks against the plan record.
            item = {
                "requestId": request_id, "status": REMOVAL_PENDING, "requester": run["requester"],
                "confirmer": confirmer, "kind": REMOVAL_KIND, "op": "remove", "name": target["name"], "capability": target["capability"],
                "path": target["path"], "planId": run["planId"], "planStep": ref, "project": run["project"],
                "namespace": run["namespace"], "channel": run["channel"], "createdAt": now,
                "issuedAt": now, "expiresAt": now + REQUEST_TTL_SECONDS}
            try:
                item.update(approval.sign(item, approver))
            except approval.ApprovalUnavailable as error:
                # No proof, no request: the CI would refuse it anyway. Nothing was written, so the
                # next advance signs and writes it once KMS answers again.
                _undo_transition(run, now, ref, "undo_blocked", "assistant", ASSISTANT_ACTOR,
                                 {"code": "approval_unavailable", "message": str(error)[:300]})
                return
            undo["requestId"] = request_id
            created = requests.put_if_absent(item)
            _undo_transition(run, now, ref, "undo_submitted", "request", ASSISTANT_ACTOR,
                             {"requestId": undo["requestId"], "path": target["path"], "replayed": not created,
                              "effect": target["effect"]})
            return
        record = requests.get(undo["requestId"]) or {}
        status = record.get("status", "")
        if status == "mr_open":
            undo["mrUrl"] = record.get("mrUrl", "")
            _undo_transition(run, now, ref, "undo_mr_open", "mr", CI_ACTOR, {"mrUrl": undo["mrUrl"]})
            return
        if status == "failed" or status == "closed":
            undo["error"] = record.get("error", "")[:300] or "removal merge request closed without merge"
            _undo_transition(run, now, ref, "undo_failed", "request", CI_ACTOR, {"message": undo["error"]})
            return
        if status != "merged":
            return
        try:
            observation = observer.observe(run["namespace"], target["kind"], target["name"])
        except ObservationUnavailable:
            return
        if observation is None:
            _undo_transition(run, now, ref, "removed", "argo", GITOPS_ACTOR, {"effect": target["effect"]})
            continue
        _undo_transition(run, now, ref, "removing", "argo", GITOPS_ACTOR, {"message": "merged; waiting for Argo CD prune"})
        return


def summarize(run: dict[str, Any]) -> str:
    if run.get("compensation"):
        states = [s["state"] for s in run["compensation"]["steps"].values()]
        if all(s == "removed" for s in states):
            return "compensated"
        return "compensation_failed" if "undo_failed" in states else "compensating"
    states = [run["steps"][ref]["state"] for ref in run["order"]]
    if all(s == "ready" for s in states):
        return "ready"
    progressing = any(s in IN_FLIGHT or s in ("planned", "waiting") for s in states)
    if progressing:
        return "running"
    created = any(s in CREATED for s in states)
    return "partial" if created else "failed"


def advance(run: dict[str, Any], index: dict[str, Any], requests: RequestStore, observer: ResourceObserver,
            now: int, can_write: Callable[[str], bool],
            approver: Callable[[bytes], bytes] | None = None) -> dict[str, Any]:
    """`can_write(alias)` is asked right before every request is written, so authority is the one
    of THIS moment, never the one the plan had when it was confirmed. `approver` MACs a removal
    request (approval.KmsMac.generate); without it a compensation never writes one."""
    before = run["state"]
    if run.get("compensation"):
        _advance_compensation(run, requests, observer, now, can_write, approver)
    else:
        _advance_creation(run, _plan_steps(run, index), requests, observer, now, can_write)
    run["state"] = summarize(run)
    if run["state"] != before:
        _event(run, now, None, "plan_state", "assistant", ASSISTANT_ACTOR, before, run["state"])
    run["updatedAt"] = now
    return run


def retry(run: dict[str, Any], ref: str, expected_attempt: int, actor: dict[str, Any], now: int) -> bool:
    """Re-submit ONE failed step. Returns False when this exact retry already happened (a double
    click), so the caller answers with the current run instead of creating a second attempt."""
    if run.get("compensation"):
        raise RetryRefused("compensating", "the plan is being rolled back")
    state = run["steps"].get(ref)
    if state is None:
        raise RetryRefused("unknown_step", f"no step {ref!r}")
    if expected_attempt == state["attempt"] - 1 and state["state"] not in RETRYABLE:
        return False
    if expected_attempt != state["attempt"]:
        raise RetryRefused("attempt_mismatch", f"step is at attempt {state['attempt']}")
    if state["state"] not in RETRYABLE or state["createdByPlan"]:
        raise RetryRefused("not_retryable", f"step is {state['state']}; only a step that created nothing can be retried")
    previous = state["requestId"]
    state.update({"attempt": state["attempt"] + 1, "requestId": None, "error": "", "mrUrl": "", "state": "planned"})
    _event(run, now, ref, "retry", "assistant", actor, detail={"previousRequestId": previous, "attempt": state["attempt"]})
    for other in run["order"]:
        if run["steps"][other]["state"] == "blocked":
            run["steps"][other]["state"] = "planned"
    return True


class RetryRefused(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
