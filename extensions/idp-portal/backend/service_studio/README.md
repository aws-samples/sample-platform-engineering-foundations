# service_studio

Core of the Service Owner Studio (issue #11): a Service Owner describes a capability, alone or
with a model, and gets a governed catalog package proposed as a merge request.

## What it does and does not do

| Does | Does not |
|---|---|
| Validate a `ServiceDraft` deterministically, closed at every level | Call a model itself (`invoke` is injected) or trust anything it returns |
| Compile `capability.yaml`, `schema.json`, `examples/instance.yaml` and `docs.md` from one draft | Write a new RGD (that creates AWS resources: platform-team change) |
| Bind the form to an existing composition and refuse any field it does not accept | Let a field carry a Secret, IAM, a namespace, an account, a region or the deletion policy |
| Compute a structured diff, the breaking changes and a policy verdict | Approve anything: every MR needs a human, `elevated_review` needs a platform reviewer |
| Plan and drive one branch, one commit, one MR through an injected GitLab port | Merge, push to `main`, or touch `platform/instances/` and `platform/compositions/` |
| Authorize by owner team (`SERVICE_OWNER_TEAMS`) and admin | Write to DynamoDB (it returns the item; the caller stores it) |

Stdlib only, like `agent_builder`: it runs in the platform-api Lambda bundle. A test asserts it
imports no `boto3`, Kubernetes, HTTP, socket or subprocess client.

## Contract

- **ServiceDraft v1** (`contract.py`): `schemaVersion`, `domain`, `name`, `version`, display names
  and descriptions (en-US + pt-BR), `owner`, `engine` (`ack`/`kro`), `pattern`, `lifecycle`
  (`planned`/`preview`; `available` is a platform promotion), `goldenPath`, optional `rgdRef`,
  `requires`, `fields[]`, `docs`.
- Domain `agent/` is refused: agents are created by the Agent Builder (ADR-0008).
- A draft without `rgdRef` can only be `planned`. With `rgdRef`, every field must exist in that
  composition with the same type, and every input it requires must be asked; when a required
  input is forbidden (the Lambda RGD requires `roleArn`) the capability cannot be self-service.
- One error per JSON Pointer, first failing rule wins, nothing is ever repaired.
- `deletionPolicy: retain` and `targetAccounts` are imposed by the compiler, never read from the draft.

## Integration hooks (wired on 2026-10-22, behind `SERVICE_STUDIO_ENABLED`)

The core stays isolable; the shared files below call it. End-to-end proof:
`tests/test_dev_platform_integration.py`.

| Consumer | Calls | Note |
|---|---|---|
| platform-api `POST /platform/service-drafts/preview` | `preview(body, alias=, is_admin=, teams=parse_teams(env), compositions=load_compositions())` | returns `(status, body)`; 200 `invalid` and 403 `unauthorized` are answers |
| platform-api `POST /platform/provision-requests` with `kind: service-capability` | `request_item(...)` then `PutItem` of the returned item | refuses compiled artifacts in the body; binds to `previewSha256` |
| BFF `POST /gateway/service-drafts/generate` | `generate_draft(body, invoke=_invoke_gateway, model_alias=, compositions=, context=, sources=)` | payload has no tools; KB retrieval optional |
| CI `open-provision-mrs` | pin `main` to its head SHA, snapshot catalog and compositions at it, read base with `existing_files(ref=sha)` + PyYAML, `draft_from_package`, `recheck_on_main`, `plan_publish`, `verify_recompiled`, `with_capability_index`, `verify_index`, `scaffold` | recheck authorization against the owner on `main` before planning |
| CI sweep `reconcile` (every 15 min) | reads each `mr_open` MR; closed -> `closed`, merged -> `merged`, still open -> stamps `statusCheckedAt` | the platform-api cannot reach GitLab, so this stamp is the only server-side proof of how recent "MR open" is. `GET /platform/provision-requests/{id}` returns `statusCheckedAt` and `statusAgeSeconds` |

## Request status in the page (`#studio/<requestId>`)

Measured on 2026-10-22: MR !45 was closed at 08:30:45Z, the 08:33Z sweep wrote `closed`, and the
page kept saying "open" because its 30-minute polling window had already ended. The page now
grades the status it shows (`statusConfidence` in `serviceStudioModel.ts`): `mr_open` confirmed by
the CI within 35 minutes (two sweeps plus margin) reads "open, confirmed N min ago"; older, or
never stamped, reads "last read: MR open, not reconfirmed" with a warning icon. Coming back to the
tab and **Check again** re-read the request and open a new polling window.

## Generation and the two keys models drop

The prompt lists every `REQUIRED_ROOT` key from the same tuple the validator uses, with the
formats of `version` (`v1` for a new capability) and `goldenPath` (`GP-<letter><1-2 digits>`).
The contract stays blocking: a draft without either is `invalid` with `required`, nothing is
filled in on the server, and the Studio form has a Version input and a Golden path autosuggest
(codes the catalog already uses, the one of the capability that composes the same RGD first).

## Catalog identity of a package that reuses an RGD

A Studio MR may publish a new id over an existing RGD (`e2e-dp-1022-orders` -> `dynamodb-table`).
That is legitimate, and `src/platform/kdpProductJourney.test.tsx` checks it by invariant instead
of a closed list: `rgdRef` resolves, the live identity is the RGD `metadata.name`, every
`schema.json` field exists in the RGD with the same type, every required RGD input is asked, and
the example instantiates the RGD kind. Ids that share a live identity resolve back to the
canonical one: the id equal to the live name, then the most mature lifecycle, then catalog order.

## Capability index in the same MR

`backend/platform_assistant/capability-index.json` is a committed cache of the catalog, and
`tests/test_platform_assistant.py::test_index_is_a_cache_of_the_catalog` regenerates it and
compares bytes. So a package MR must carry the regenerated index, or its own pipeline fails (MR
!45 did). The CI does it in the same commit:

- `with_capability_index(plan, repo_root)` copies `platform/catalog` and `platform/compositions`
  from `repo_root` to a temporary tree, applies the package actions exactly as the commit will,
  and runs the canonical builder (`platform_assistant.catalog`). It adds one index write only when
  the bytes change, and discards any index already in the plan.
- In the CI, `repo_root` is NOT the job checkout: `open-provision-mrs` reads the head SHA of
  `main` from GitLab, writes `platform/catalog`, `platform/compositions` and the current index at
  that SHA into a temporary directory, and plans against it (base package, existing files and
  compositions read at the same SHA). The plan carries `base_sha`; `scaffold` re-reads the head
  right before the commit and refuses `stale_base` (nothing written) when `main` moved, and the
  commit starts from `start_sha = base_sha`. The CI replans once on a new head, then fails.
- `verify_index(plan, repo_root)` regenerates again and compares bytes before the commit; any
  difference is `manifest_mismatch` and nothing is written.
- `assert_publish_paths(paths, directory)` is the closed allowlist: files of the EXACT validated
  package directory, plus that one index path. Nothing else, ever.

The index never comes from the request: the platform-api refuses `capabilityIndex`, `files` and
`actions` in the body, and the CI never reads such a field from the stored item. If `main` moves
between the snapshot and the commit, `scaffold` refuses `stale_base` before writing; if it moves
after the commit, the MR pipeline still regenerates and compares bytes, and a concurrent index
change conflicts in the MR, so a stale index fails closed. Proof: `tests/test_service_studio.py` (MR !45 fixture and mutations) and
`tests/test_dev_platform_integration.py` (browser, stored item and the CI recheck).

Lambda bundle: copy `platform/compositions/*-rgd.yaml` to `service_studio/compositions/` (or set
`SERVICE_STUDIO_COMPOSITIONS`); without them the package raises `StudioUnavailable` and the route
should answer 503, never guess.

## Frontend

`src/platform/serviceStudio/`: `schemaForm.ts` is the schema-to-form model the wizard should
reuse so the preview equals the post-merge render; `ServiceOwnerStudio.tsx` is the page, with an
injected API and starting points (bundled RGDs and catalog packages, or a pasted CRD).

## Tests

```bash
python3 -m pytest tests/test_service_studio.py -q
npx vitest run src/platform/serviceStudio
```

`tests/fixtures/service-studio/` holds the golden schema and the package-to-draft fixture that
both the Python and the TypeScript side compare against.
