# platform_assistant

Governed multi-resource provisioning plans for the portal and the platform-mcp-server
(GitLab issue #12). A request such as "a function and an HTTP API for the todo-app" becomes a
`ProvisionPlan`, a preview the user can edit, one confirmation, one provision request per
resource in dependency order, and a single timeline from request to Ready. A rollback removes
only what the same plan created, after its own preview and confirmation.

Contract: [`platform/assistant/provision-plan.schema.json`](../../platform/assistant/provision-plan.schema.json).
Fixtures and golden outputs: `tests/fixtures/platform-assistant/`. Tests:
`tests/test_platform_assistant.py` (backend) and `src/platform/assistant/PlatformAssistant.test.tsx` (UI).

## Shape

| File | Holds |
|---|---|
| `catalog.py` | the published capability index, generated from `platform/catalog/**` and the RGDs |
| `capability-index.json` | that index, committed because the Lambda has no PyYAML; a test regenerates it and compares bytes, and a Service Studio MR carries it regenerated in the same commit (`backend/service_studio/README.md`) |
| `schema.py` | stdlib validator for the JSON Schema subset the catalog uses; the index refuses any other keyword |
| `planner.py` | model boundary, plan validation, defaults, dependency graph, kro instance compiler |
| `runs.py` | the executor: idempotent `advance`, step and plan states, retry, compensation, timeline |
| `ports.py` | request store, plan store, observer and project directory, with DynamoDB and cluster-api adapters |
| `service.py` | `AssistantService`: authorization and the eight allowlisted actions |
| `transport.py` | one operation table served as portal routes (`handle_http`) and MCP tools (`mcp_jsonrpc`) |
| `removal.py` | CI side of a compensation: the delete commit and merge request, refused unless the file carries this plan's labels |

## Invariants the tests pin down

| Invariant | Mechanism |
|---|---|
| The model never writes a manifest | it returns JSON data; `interpret_model_output` refuses prose, YAML and non-objects; the compiler emits every value as a JSON-quoted scalar |
| Only published capabilities | `capability-index.json`: lifecycle `available`/`preview`, a schema and an RGD; agents stay in the Agent Builder; `database/postgres/v1` is refused as `planned` |
| Invalid plan, no MR | `submit` re-validates server-side and raises 422 before any request record |
| No duplicate on retry | plan id = hash(requester, project, idempotencyKey); request id = hash(plan, step, attempt); every write is a conditional put |
| Human confirms what was previewed | `submit` needs `planSha256`; any edit or default change changes it |
| Partial failure keeps what was created | no automatic rollback; compensation needs its own preview hash and confirmation |
| Never touch a preexisting object | an existing name fails the preview; absence is observed AGAIN right before every request, and an object found there fails the step (`foreign_object` / `already_exists`), is never adopted and never enters a rollback |
| Not knowing is not absence | a cluster read failure is `existence_unchecked`: an error in the preview (nothing to confirm), and in a run the step stays `planned` until the cluster answers |
| Authority of the moment, not of the confirmation | `advance` asks `can_write(alias)` right before every request: the requester for a creation, the confirmer for a removal. Read-only project, retired project or removed member: the step is `blocked` / `undo_blocked` with `project_not_writable` and no request exists |
| Only the requester or an admin acts on a plan | `retry` and `compensation_confirm` answer 403 `not_plan_owner` to any other member; the actor recorded is always the caller, so an admin rollback says the admin, never the owner |
| Who confirmed is on the removal | the removal request carries `confirmer`; the CI re-reads the plan record and requires `compensation.confirmedBy.alias == confirmer`, and that the confirmer is the requester or in `PLATFORM_ADMINS`; the MR names both |
| Deletion effect of the instance | `deletionPolicy` comes from the instance input only when the published schema of the capability declares it (static-web-app may say `delete`); otherwise the planner drops the field with a `field_ignored` warning and the catalog value applies. The CI applies the same rule to `spec.deletionPolicy` of the file on `main` |
| Same authz for portal and MCP | both transports call `dispatch`; identity comes from the transport; `requester`, `manifest`, `namespace` are 400 |
| No direct write client | an AST test forbids `boto3`, `kubernetes`, `urllib`, `requests`, `http`, `subprocess`, `socket` in this package |

## Write path

```text
UI / MCP ─▶ AssistantService ─▶ provision request (kind infra, status pending)
                                   │  same table and fields the CI job already reads
                                   ▼
                      open-provision-mrs ─▶ merge request ─▶ merge ─▶ mirror ─▶ Argo CD ─▶ kro/ACK
                                                                                 │
   timeline ◀── advance() ◀── request status (CI) + GET /cluster/instance (cluster-api) ◀┘
```

A dependent step is submitted only after its dependency is Ready, with the referenced value
taken from the dependency's OBSERVED outputs and validated against the target field's schema.

## Integration hooks (wired on 2026-10-22, behind `PLATFORM_ASSISTANT_ENABLED`)

Wired: platform-api (`/platform/assistant/*`), BFF (`POST /gateway/assistant/draft` through
`propose_plan`), observer (`lambda:Invoke` of the cluster-api with `platformObserve`), project
contract (`projects.ScopeProjects` over `platform_scope`) and the CI removal sweep. Still not wired:
the platform-mcp-server mount. End-to-end proof: `tests/test_dev_platform_integration.py`.

| Consumer | Hook | Note |
|---|---|---|
| platform-api | `if "/platform/assistant/" in path: return respond(*transport.handle_http(service, method, path, event["body"], Caller(alias, is_admin, "portal")))` | after the existing alias gate; behind a `PLATFORM_ASSISTANT_ENABLED` flag |
| platform-mcp-server | `transport.mcp_jsonrpc(service, message, Caller(midway_alias, is_admin, "mcp"))` | tool arguments never carry identity |
| BFF (model) | an object with `propose(instructions, prompt, context) -> str` | `planner.model_instructions(index)` is the system prompt |
| Observer transport | `ClusterApiObserver(fetch)` | the cluster-api runs in the cluster VPC; the platform-api does not reach it |
| Project contract (#10) | `projects.ScopeProjects(registry, is_admin_for, role_for)` | over `platform_scope`; admin is decided per ALIAS (`PLATFORM_ADMINS`), so a caller who is admin never makes the requester look like one at write time; `StaticProjects` stays for tests |
| CI removal | in `open_provision_mrs.run`, claim `status = pending_removal` items of `kind = assistant-removal` and apply `removal.removal_change` | wired: sweep only, and only when the plan record confirmed the removal |
| GitOps mirror delete | `scripts/sync-gitops-codecommit.py` (`assistant_owner`, `assistant_removal_proof`, `assistant_record_problem`) | wired: after the human merge, the mirror deletes `instances/<name>.yaml` from CodeCommit only with every proof (below); otherwise the file stays and the log says why |

### Mirror delete: what has to be proved

The removal MR deletes the file from `main`, but the CodeCommit mirror Argo CD reads is
append/update-only. Without this step the object stayed in the cluster and the compensation waited in
`removing` forever (E2E of 2026-10-22, MR !48). The mirror deletes the file only when ALL of these
hold, read in this order, and preserves it otherwise:

1. The file is in CodeCommit, absent from `main`, at `instances/<metadata.name>.yaml`, one
   document, labels `managed-by: platform-assistant`, `plan-id`, `plan-step` and `requester`.
2. The job commit (`CI_COMMIT_SHA`) IS the current `main` head and the checkout is at it; the
   proof below is evaluated against that head, and the head is read again right before the
   commit. Stricter than the tour on purpose: "`platform/` did not change since" is not enough.
3. The LAST first-parent commit of `main` that touched the file is a merge with two parents that
   only deletes it. History, not `HEAD^`: any later pipeline proves it, and a file recreated after
   the rollback is never deleted.
4. Its second parent is a commit by `project_<CI_PROJECT_ID>_bot_*` (author and committer) that only
   deletes the file, with the exact `removal_change` message, the plan and requester of the labels
   and the compensation id `runs.removal_request_id(plan-id, plan-step)`.
5. The merge was made by a human, from `rollback/<name>-<id8>`, and cites exactly one
   `<CI_PROJECT_PATH>!<iid>`.
6. The CodeCommit copy is byte for byte the file the bot deleted.
7. Re-read now (`PROVISION_TABLE`, mandatory): the removal request matches path, step, requester,
   confirmer, is `mr_open` or `merged` and points to that MR; the plan run confirmed the
   compensation of that step, by that confirmer, with that request id and target.

8. The confirmer is the plan's requester or an alias in the job's `PLATFORM_ADMINS` (no `*`).
9. The removal request carries a valid, unexpired KMS approval (below). Expired never counts, even
   while the item is still in the table before the TTL sweeper removes it.

Contract and mutation tests: `tests/test_gitops_mirror_assistant.py` and
`tests/test_assistant_removal_approval.py`.

### Removal approval (KMS HMAC)

Every proof above is writable by the CI role: its trust has no ref condition and it can
`UpdateItem` the table, so a branch pipeline forges the plan, the removal, the bot authorship and
the labels ([threat model](../../docs/agent-platform/threat-model-platform-assistant-removal.md)).
The approval is the one thing it cannot forge:

- `approval.canonical_message` builds versioned, deterministic bytes (`assistant-removal-approval/v1`)
  over `requestId, kind, op, planId, planStep, name, path, requester, confirmer, issuedAt, expiresAt`.
- The platform-api, right before writing a confirmed removal, calls `kms:GenerateMac`
  (`HMAC_SHA_256`) on the key in `ASSISTANT_REMOVAL_KEY_ID` and persists `proofVersion`,
  `issuedAt`, `macAlgorithm` and `mac` (base64). A creation request is never signed. Without a
  signer, or with KMS down, nothing is written: the undo step is `undo_blocked`
  (`approval_unavailable`) and the next advance retries.
- `open-provision-mrs` verifies with `kms:VerifyMac` before claiming and again before any GitLab
  write; an unverifiable proof keeps the request `pending_removal` and the job red. The mirror
  verifies through the AWS CLI (`fileb://` bytes) and loads `approval.py` by path, so the canonical
  form has one implementation. Only the platform-api role may generate, only the `GitLab` role may
  verify (key policy denies), and the key never leaves KMS. HMAC keys do not rotate automatically.

Regenerate the index after a catalog change:

```bash
cd backend && python3 -m platform_assistant.catalog
```

Regenerate the golden UI fixtures after a contract change:

```bash
REGEN_ASSISTANT_GOLDEN=1 python3 -m pytest tests/test_platform_assistant.py -k golden -q
```
