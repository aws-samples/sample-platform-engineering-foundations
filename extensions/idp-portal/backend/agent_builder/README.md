# agent_builder

Core of the governed Agent Builder: validate an `AgentDraft`, compile it into a kagent
`Agent` manifest, and scaffold the Git change that proposes it.

Contract: [`docs/agent-platform/design-agent-builder.md`](../../docs/agent-platform/design-agent-builder.md)
(sections 3, 4 and 5.10). Machine-readable contract:
[`platform/agent-builder/`](../../platform/agent-builder/). Fixtures:
`tests/fixtures/agent-builder/`.

## What it does and does not do

| Does | Does not |
|---|---|
| Validate a draft exactly as the preview and the CI do | Call the model, or read anything it produced except as data |
| Compile a draft into canonical manifest bytes | Accept a manifest from a client |
| Derive safe Git paths and branch names | Write to the cluster, or hold a cluster credential |
| Create a branch, a commit and a merge request through an injected GitLab port | Merge anything, or touch `main` |
| Refuse an overwrite, a duplicate name and a non-owner disable | Delete an agent (that is the ADR-0007 gate) |
| Report which Auto-MR status its outcome maps to | Write to DynamoDB |

The module imports no `boto3`, no Kubernetes client and no HTTP client. A test asserts that,
because the one thing that would break invariant I5 is this module growing a write path of
its own.

## Shape

| File | Holds |
|---|---|
| `catalog.py` | the closed tool catalog and the fixed values every manifest carries |
| `validator.py` | the stdlib validator, including the three rules JSON Schema cannot express |
| `compiler.py` | the deterministic compiler, the draft hash and the disable transform |
| `paths.py` | safe path and branch derivation, with malicious names refused twice |
| `scaffolder.py` | planning, the GitLab drive, idempotency, limits and status mapping |
| `tool-catalog.json` | a byte-identical copy of the contract catalog, so a Lambda bundle that ships only this package still resolves it |

The copy exists because a bundle containing only `agent_builder/` has no
`platform/agent-builder/` next to it. It is not a second source of truth:
`tests/test_agent_builder_contract.py` compares the two by SHA-256, so a change to either
turns the suite red rather than letting the runtime and the contract disagree. Resolution
order is `AGENT_BUILDER_CATALOG`, then this copy, then the repository file.

## Use

Consumers put `backend/` on `sys.path` and import the package. Nothing here is copied into
another module.

```python
import sys
sys.path.insert(0, "backend")

from agent_builder import plan_create, scaffold, validate_draft

validation = validate_draft(draft, caller_is_admin=False)      # preview, no side effect
if not validation.valid:
    return 422, {"error": "draft invalid", **validation.as_dict()}

plan = plan_create(draft, requester=alias, request_id=request_id)
result = scaffold(gitlab, plan, pipeline_url=pipeline_url)      # branch, commit, merge request
table.update_item(..., {status_detail_field(result.status): result.mr_url or result.detail})
```

`gitlab` is any object with `call(method, path, body=None) -> (status, parsed_body)`, which
is the abstraction `scripts/open_provision_mrs.py` already uses. That seam is what lets the
tests fake every write.

## Integration hook per consumer

| Consumer | Calls | Note |
|---|---|---|
| platform-api, preview (5.2) | `validate_draft`, `normalize_draft`, `compile_manifest`, `draft_sha256`, `git_path` | `request_id="preview"` via `PREVIEW_REQUEST_ID`; the response `manifest` is `compile_manifest(...).decode("utf-8")` |
| platform-api, request (5.3) | `validate_draft`, `plan_create`, `plan_disable` | store `plan.manifest`, `plan.draft_sha256`, `plan.provenance`; a `manifest` field in the body is a `400`, because the server computes it |
| CI `open-provision-mrs` (5.10) | `verify_recompiled`, `read_directory`, `check_limits`, `plan_create`, `plan_disable`, `scaffold`, `persisted_status`, `status_detail_field` | call `verify_recompiled` **before** `scaffold`: a non-empty return is `failed: compiled manifest mismatch` |
| CI `validate-agent-manifests` (5.11) | `fixed`, `tool_names`, `tool_server`, `name_from_git_path`, `describe_manifest` | the key allowlist of section 4 lives in the contract test; reuse these for the constants |
| BFF (5.1) | `validate_draft` | returns the draft even when invalid, with the errors, so the user can correct it |

`ScaffoldRefused` carries a `code` from `REFUSAL_CODES`, so a caller maps an outcome to a
status and a message without parsing prose. `persisted_status` returns one of
`PERSISTED_STATUSES`: the scaffolder invents no state of its own.

## Properties the tests pin down

`tests/test_agent_builder_contract.py` (criterios A1, A2, A3) and
`tests/test_agent_builder_scaffolder.py`:

- the compiled bytes equal the golden manifests, for the active and the disabled form, and
  the two disable paths agree;
- the 24 fixture cases return exactly the expected `(path, code)` pairs;
- the schema enum equals the catalog, and the validator's regexes equal the schema's;
- re-driving a request writes nothing twice, and a commit whose response was lost is
  detected rather than repeated;
- a manifest already on `main` fails the request, and so does a second open request for the
  same name;
- 25 malicious names are refused before any path is derived.

Every consistency check is run twice: once on the real files, where it must find nothing,
and once on a deliberately broken copy, where it must find something. The `test_control_*`
cases are that second half, and without them a green suite would not show that the checks
can fail at all.

```bash
python3 -m pytest tests/test_agent_builder_contract.py tests/test_agent_builder_scaffolder.py -q
```

`jsonschema` is used only by the concordance test and is skipped when absent; everything
else is stdlib, because this code runs in a Lambda bundle that has neither.
