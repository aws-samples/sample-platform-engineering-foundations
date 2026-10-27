"""Deterministic planner around the model: ProvisionPlan in, validated steps and manifests out.

The model, when there is one, only ever produces a candidate `provision-plan/v1` JSON object.
This module treats that object as untrusted data, exactly like a plan the user edited by
hand: it resolves every item against the published capability index, validates every input
against the capability's versioned schema, fills and REPORTS the defaults, derives the
dependency graph, and compiles each kro instance itself. Nothing the model wrote becomes a
manifest byte except as a JSON-quoted scalar inside a field the schema declares.

What the plan cannot carry, by construction: a manifest, an action, a requester, a project,
a namespace, a label. Those come from the server (session, selected project, this compiler).
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any

from .schema import validate as validate_schema

SCHEMA_VERSION = "provision-plan/v1"
COMPILER = "platform-assistant/v1"
MANAGED_BY = "platform-assistant"
MAX_ITEMS = 6
MAX_MODEL_OUTPUT_BYTES = 16_384
MAX_STRING = 512
# `ref` é só a chave do `dependsOn` dentro do plano (nunca vira nome de recurso nem identificador CEL), então
# hífen é inofensivo. Medido em 26/10/2026 no portal: o modelo emite `orders-table`/`docs-site` com naturalidade
# e o padrão sem hífen bloqueava TODO plano com dois recursos antes de qualquer MR.
REF_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,31}")
# DNS-1123 label, capped at 53 so a kro child resource can still append a short suffix.
NAME_PATTERN = re.compile(r"[a-z0-9]([a-z0-9-]{0,51}[a-z0-9])?")
LABEL_VALUE = re.compile(r"[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?")
CONTROL = re.compile(r"[\x00-\x1f\x7f\u2028\u2029]")
SECRET_LIKE = re.compile(
    r"(AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|(?i:aws_secret_access_key|password\s*[=:])"
)
PLAN_KEYS = frozenset({"schemaVersion", "summary", "items"})
ITEM_KEYS = frozenset({"ref", "capability", "name", "inputs", "dependsOn"})
REFERENCE_KEYS = frozenset({"fromRef", "output"})
INSTANCE_PATH = "platform/instances/{name}.yaml"
DELETION_POLICIES = ("retain", "delete")
LABELS = ("managed-by", "plan-id", "plan-step", "project", "requester", "owner")


def declares_deletion_policy(capability: dict[str, Any]) -> bool:
    """True only when the PUBLISHED schema of the capability declares `deletionPolicy`. Only then
    does the composition read the instance value; everywhere else it hardcodes the catalog policy."""
    schema = capability.get("schema") if isinstance(capability, dict) else None
    props = schema.get("properties") if isinstance(schema, dict) else None
    return isinstance(props, dict) and "deletionPolicy" in props


def effective_deletion_policy(capability: dict[str, Any], chosen: Any) -> str:
    """What kro/ACK apply on delete: the instance value when the schema declares the field, else the
    catalog value. An undeclared `deletionPolicy` on an instance is ignored, never honored."""
    default = str((capability or {}).get("deletionPolicy") or "unknown")
    if declares_deletion_policy(capability) and isinstance(chosen, str) and chosen in DELETION_POLICIES:
        return chosen
    return default


@dataclass(frozen=True)
class Issue:
    path: str
    code: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"path": self.path, "code": self.code, "message": self.message}


@dataclass
class Step:
    ref: str
    capability: dict[str, Any]
    name: str
    inputs: dict[str, Any]
    defaults: list[dict[str, Any]] = field(default_factory=list)
    references: list[dict[str, str]] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)
    index: int = 0

    @property
    def path(self) -> str:
        return INSTANCE_PATH.format(name=self.name)

    @property
    def deletion_policy(self) -> str:
        """The policy the instance gets on delete. Only a capability whose published schema declares
        `deletionPolicy` (static-web-app) lets the plan choose; otherwise it is the catalog value."""
        return effective_deletion_policy(self.capability, self.inputs.get("deletionPolicy"))


@dataclass
class Plan:
    """The validated, normalized plan. `steps` is in execution (topological) order."""
    summary: str
    steps: list[Step]
    errors: list[Issue]
    warnings: list[Issue]

    @property
    def valid(self) -> bool:
        return not self.errors

    def normalized(self) -> dict[str, Any]:
        """The plan as the server will execute it, defaults included, in execution order."""
        return {"schemaVersion": SCHEMA_VERSION, "summary": self.summary, "items": [
            {"ref": s.ref, "capability": s.capability["id"], "name": s.name, "inputs": s.inputs,
             "dependsOn": s.depends_on} for s in self.steps]}


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def plan_sha256(normalized: dict[str, Any], project: str, namespace: str) -> str:
    """What the human confirms. Any edit, default or scope change produces a new hash."""
    return hashlib.sha256(canonical({"plan": normalized, "project": project, "namespace": namespace,
                                     "compiler": COMPILER})).hexdigest()


def is_reference(value: Any) -> bool:
    return isinstance(value, dict) and "fromRef" in value


# ---------------------------------------------------------------------- model boundary
def interpret_model_output(text: Any) -> tuple[dict[str, Any] | None, list[Issue]]:
    """Parse what the model returned. Only a JSON object survives; prose, YAML, a manifest or a
    tool call is refused here, before any validation, and nothing in it is executed."""
    if not isinstance(text, str) or not text.strip():
        return None, [Issue("/", "model_output_invalid", "the model returned no plan")]
    if len(text.encode("utf-8")) > MAX_MODEL_OUTPUT_BYTES:
        return None, [Issue("/", "model_output_invalid", f"model output exceeds {MAX_MODEL_OUTPUT_BYTES} bytes")]
    body = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*\n(.*)\n```", body, flags=re.S)
    if fenced:
        body = fenced.group(1)
    try:
        candidate = json.loads(body)
    except json.JSONDecodeError:
        return None, [Issue("/", "model_output_invalid", "the model output is not a JSON plan")]
    if not isinstance(candidate, dict):
        return None, [Issue("/", "model_output_invalid", "the model output must be a JSON object")]
    return candidate, []


def model_instructions(index: dict[str, Any]) -> str:
    """System prompt for the model. Data only: the capability ids, fields and outputs it may use."""
    lines = [
        "You translate a platform request into a provision-plan/v1 JSON object and nothing else.",
        "Return only JSON. Never return a Kubernetes manifest, YAML, commands or prose.",
        "Use only the capabilities listed below, and only their listed fields.",
        'To use another item\'s output, set the field to {"fromRef": "<ref>", "output": "<output>"}.',
        "If the request needs something not listed, return it in summary and leave it out of items.",
        'Shape: {"schemaVersion": "provision-plan/v1", "summary": "...", "items": '
        '[{"ref": "db", "capability": "<id>", "name": "<dns-label>", "inputs": {}}]}',
        "Capabilities:",
    ]
    for cid, cap in sorted(index["capabilities"].items()):
        fields = ", ".join(sorted((cap["schema"].get("properties") or {})))
        lines.append(f"- {cid}: {cap['displayName']}. fields: {fields}. outputs: {', '.join(cap['outputs']) or '-'}")
    return "\n".join(lines)


# ---------------------------------------------------------------------- validation
def _scan_strings(value: Any, path: str, issues: list[Issue]) -> None:
    if isinstance(value, str):
        if CONTROL.search(value):
            issues.append(Issue(path, "not_single_line", "text must be a single line without control characters"))
        if len(value) > MAX_STRING:
            issues.append(Issue(path, "too_long", f"text longer than {MAX_STRING} characters"))
        if SECRET_LIKE.search(value):
            issues.append(Issue(path, "secret_like", "looks like a credential; secrets never go in a plan"))
    elif isinstance(value, dict):
        for key in sorted(value):
            _scan_strings(key, f"{path}/{key}", issues)
            _scan_strings(value[key], f"{path}/{key}", issues)
    elif isinstance(value, list):
        for i, item in enumerate(value):
            _scan_strings(item, f"{path}/{i}", issues)


def _toposort(steps: list[Step]) -> tuple[list[Step], bool]:
    """Kahn's algorithm; ties broken by the order the plan listed them, so it is deterministic."""
    position = {s.ref: i for i, s in enumerate(steps)}
    remaining = {s.ref: set(s.depends_on) for s in steps}
    ordered: list[Step] = []
    by_ref = {s.ref: s for s in steps}
    while remaining:
        ready = sorted((r for r, deps in remaining.items() if not deps), key=position.__getitem__)
        if not ready:
            return ordered, False
        current = ready[0]
        ordered.append(by_ref[current])
        del remaining[current]
        for deps in remaining.values():
            deps.discard(current)
    return ordered, True


def build_plan(raw: Any, index: dict[str, Any]) -> Plan:
    errors: list[Issue] = []
    warnings: list[Issue] = []
    if not isinstance(raw, dict):
        return Plan("", [], [Issue("/", "plan_not_object", "the plan must be a JSON object")], [])
    for key in sorted(set(raw) - PLAN_KEYS):
        errors.append(Issue(f"/{key}", "unknown_field", "the plan accepts only schemaVersion, summary and items"))
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        errors.append(Issue("/schemaVersion", "schema_version", f"must be {SCHEMA_VERSION}"))
    summary = raw.get("summary", "")
    if not isinstance(summary, str):
        errors.append(Issue("/summary", "type", "expected string"))
        summary = ""
    _scan_strings(summary, "/summary", errors)
    items = raw.get("items")
    if not isinstance(items, list) or not items:
        errors.append(Issue("/items", "empty_plan", "the plan has no resource to create"))
        return Plan(summary, [], errors, warnings)
    if len(items) > MAX_ITEMS:
        errors.append(Issue("/items", "too_many_items", f"at most {MAX_ITEMS} resources per plan"))
        return Plan(summary, [], errors, warnings)

    capabilities, excluded = index["capabilities"], index.get("excluded") or {}
    steps: list[Step] = []
    refs: set[str] = set()
    names: set[str] = set()
    for i, item in enumerate(items):
        base = f"/items/{i}"
        if not isinstance(item, dict):
            errors.append(Issue(base, "type", "expected object"))
            continue
        for key in sorted(set(item) - ITEM_KEYS):
            errors.append(Issue(f"{base}/{key}", "unknown_field",
                                "an item accepts only ref, capability, name, inputs and dependsOn"))
        ref, name, cid = item.get("ref"), item.get("name"), item.get("capability")
        if not isinstance(ref, str) or not REF_PATTERN.fullmatch(ref):
            errors.append(Issue(f"{base}/ref", "ref_invalid", "ref is a short lowercase identifier (a-z, 0-9, -)"))
            continue
        if ref in refs:
            errors.append(Issue(f"{base}/ref", "ref_duplicate", f"ref {ref!r} is used twice"))
            continue
        refs.add(ref)
        if not isinstance(name, str) or not NAME_PATTERN.fullmatch(name):
            errors.append(Issue(f"{base}/name", "name_invalid", "name is a lowercase DNS label up to 53 characters"))
            continue
        if name in names:
            errors.append(Issue(f"{base}/name", "name_duplicate", f"name {name!r} is used twice; each is its own file"))
            continue
        names.add(name)
        if not isinstance(cid, str) or cid not in capabilities:
            if isinstance(cid, str) and cid in excluded:
                errors.append(Issue(f"{base}/capability", "capability_not_published",
                                    f"{cid} is not published for self-service: {excluded[cid]}"))
            else:
                errors.append(Issue(f"{base}/capability", "capability_unknown",
                                    "not a capability of the published catalog"))
            continue
        capability = capabilities[cid]
        inputs = item.get("inputs", {})
        if not isinstance(inputs, dict):
            errors.append(Issue(f"{base}/inputs", "type", "expected object"))
            continue
        depends = item.get("dependsOn", [])
        if not isinstance(depends, list) or not all(isinstance(d, str) for d in depends):
            errors.append(Issue(f"{base}/dependsOn", "type", "expected a list of refs"))
            depends = []
        steps.append(Step(ref, capability, name, dict(inputs), depends_on=list(dict.fromkeys(depends)), index=i))

    refs_by_name = {s.ref: s for s in steps}
    for step in steps:
        base = f"/items/{step.index}"
        props = step.capability["schema"].get("properties") or {}
        if "deletionPolicy" in step.inputs and not declares_deletion_policy(step.capability):
            # The composition hardcodes the catalog policy; carrying the field would make the preview
            # manifest say one thing while kro/ACK do another. It is dropped and REPORTED.
            del step.inputs["deletionPolicy"]
            warnings.append(Issue(f"{base}/inputs/deletionPolicy", "field_ignored",
                                  f"{step.capability['id']} does not declare deletionPolicy; the catalog policy "
                                  f"{step.capability['deletionPolicy']} applies"))
        concrete: dict[str, Any] = {}
        for key in sorted(step.inputs):
            value = step.inputs[key]
            where = f"{base}/inputs/{key}"
            if not is_reference(value):
                concrete[key] = value
                continue
            if set(value) - REFERENCE_KEYS or not isinstance(value.get("fromRef"), str) or not isinstance(value.get("output"), str):
                errors.append(Issue(where, "reference_invalid", 'a reference is {"fromRef": ref, "output": name}'))
                continue
            source = refs_by_name.get(value["fromRef"])
            if value["fromRef"] == step.ref:
                errors.append(Issue(where, "reference_self", "an item cannot depend on itself"))
            elif source is None:
                errors.append(Issue(where, "reference_unknown_ref", f"no item has ref {value['fromRef']!r}"))
            elif value["output"] not in source.capability["outputs"]:
                errors.append(Issue(where, "reference_unknown_output",
                                    f"{source.capability['id']} publishes outputs: {', '.join(source.capability['outputs'])}"))
            elif (props.get(key) or {}).get("type") != "string":
                errors.append(Issue(where, "reference_type", "only a string field can take another item's output"))
            else:
                step.references.append({"field": key, "fromRef": source.ref, "output": value["output"]})
                if source.ref not in step.depends_on:
                    step.depends_on.append(source.ref)
        for dep in step.depends_on:
            if dep not in refs_by_name:
                errors.append(Issue(f"{base}/dependsOn", "depends_on_unknown", f"no item has ref {dep!r}"))
            elif dep == step.ref:
                errors.append(Issue(f"{base}/dependsOn", "reference_self", "an item cannot depend on itself"))
        # Defaults the user did not choose are applied here and REPORTED, so the preview shows them.
        if "name" in props and "name" not in step.inputs:
            concrete["name"] = step.name
            step.defaults.append({"field": "name", "value": step.name, "basis": "item name"})
        for key in sorted(props):
            if key not in step.inputs and key not in concrete and "default" in props[key]:
                concrete[key] = props[key]["default"]
                step.defaults.append({"field": key, "value": props[key]["default"], "basis": "schema default"})
        referenced = {r["field"] for r in step.references}
        relaxed = dict(step.capability["schema"])
        relaxed["required"] = [k for k in relaxed.get("required") or [] if k not in referenced]
        for path, code, message in validate_schema(concrete, relaxed):
            errors.append(Issue(f"{base}/inputs{'' if path == '/' else path}", code, message))
        _scan_strings(concrete, f"{base}/inputs", errors)
        step.inputs = {**concrete, **{r["field"]: {"fromRef": r["fromRef"], "output": r["output"]}
                                      for r in step.references}}
        step.inputs = {k: step.inputs[k] for k in sorted(step.inputs)}

    ordered, acyclic = _toposort(steps)
    if not acyclic:
        errors.append(Issue("/items", "dependency_cycle", "the dependencies form a cycle"))
        ordered = steps
    for step in ordered:
        if step.capability["lifecycle"] == "preview":
            warnings.append(Issue(f"/items/{step.index}/capability", "capability_preview",
                                  f"{step.capability['id']} is in preview"))
    return Plan(summary, ordered, errors, warnings)


# ---------------------------------------------------------------------- compiler
def _scalar(value: Any) -> str:
    # JSON strings, numbers and booleans are valid YAML flow scalars, and JSON quoting means no
    # value can open a new key, a new document or an anchor, whatever text the model wrote.
    return json.dumps(value, ensure_ascii=False)


def _emit(value: Any, indent: int) -> list[str]:
    pad = "  " * indent
    lines: list[str] = []
    for key in sorted(value):
        item = value[key]
        if isinstance(item, dict):
            if not item:
                lines.append(f"{pad}{_scalar(key)}: {{}}")
            else:
                lines.append(f"{pad}{_scalar(key)}:")
                lines += _emit(item, indent + 1)
        elif isinstance(item, list):
            lines.append(f"{pad}{_scalar(key)}: {_scalar(item)}")
        else:
            lines.append(f"{pad}{_scalar(key)}: {_scalar(item)}")
    return lines


def placeholder(reference: dict[str, str]) -> str:
    return f"<resolved after {reference['fromRef']} is Ready: {reference['output']}>"


def compile_instance(step: Step, *, plan_id: str, project: str, namespace: str, requester: str,
                     resolved: dict[str, str] | None = None) -> str:
    """kro instance bytes for one step. `resolved` maps a referenced field to the observed output;
    without it (preview) the field shows a placeholder and the manifest is not submittable."""
    spec: dict[str, Any] = {}
    for key, value in step.inputs.items():
        if is_reference(value):
            ref = {"fromRef": value["fromRef"], "output": value["output"]}
            spec[key] = (resolved or {}).get(key, placeholder(ref))
        else:
            spec[key] = value
    # `owner` = requester (ownership-model): quem pediu é o dono até alguém transferir pelo Git.
    labels = {f"platform.appmod/{k}": v for k, v in zip(LABELS, (MANAGED_BY, plan_id, step.ref, project, requester, requester))}
    for value in labels.values():
        if not LABEL_VALUE.fullmatch(value):
            raise ValueError(f"label value {value!r} is not a valid Kubernetes label value")
    lines = [
        f"apiVersion: {step.capability['apiVersion']}",
        f"kind: {step.capability['kind']}",
        "metadata:",
        f"  name: {step.name}",
        f"  namespace: {namespace}",
        "  labels:",
        *[f"    {k}: {_scalar(v)}" for k, v in sorted(labels.items())],
        "spec:" if spec else "spec: {}",
        *_emit(spec, 1),
    ]
    return "\n".join(lines) + "\n"
