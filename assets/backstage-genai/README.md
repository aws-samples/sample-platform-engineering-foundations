# Backstage + GenAI plugin - build assets

Files consumed by the workshop's build pipeline. They live here, versioned, so a
participant can read the recipe that produced the image they are running, and so
a fix to them actually reaches Workshop Studio.

| File | Role |
|------|------|
| `Dockerfile` | Builds the Backstage image with the GenAI plugin. Seven commented steps |
| `app-config.genai.yaml` | Agent definition: prompt, tools, Bedrock model |
| `app-config.workshop.yaml` | Runtime overrides: portal URL, catalog paths, CSP |
| `apply-genai-patches.js` | The three source edits the plugin docs ask for, idempotent |
| `add-genai-resolutions.js` | Pins a LangChain transitive dependency (see the file for why) |
| `k8s/backstage.yaml` | Deployment applied by the participant during the lab |
| `lambda/*/handler.py` | CloudFormation custom resources used by the workshop stack |

---

## Publishing to Workshop Studio

Committing to git is **not** enough. Workshop Studio has two separate asset
mechanisms, and this folder feeds the one that is **not** driven by git:

| | Repository Assets | S3 Assets |
|--|------------------|-----------|
| What | Text files, version controlled | Non-text items the infrastructure needs at deploy time, such as Lambda zips |
| How they get published | `git push` plus a content build | `aws s3 sync` with vended credentials, plus a content build |
| Referenced from CloudFormation by | Asset URL directive | `{{.AssetsBucketName}}` / `{{.AssetsBucketPrefix}}` |

The workshop stack reads the Lambda zips and the Dockerfile through the magic
variables, so they must be in the **S3 Assets** bucket. A commit alone leaves
`Code.S3Bucket`/`S3Key` pointing at objects that do not exist, and provisioning
fails on the four custom resources plus the CodeBuild pre-build gate.

### Procedure

1. On the workshop details page in Workshop Studio, click **Credentials**.
2. Copy the temporary environment variables for your OS and paste them into your
   terminal, or store them in a named AWS profile.
3. Expand **Assets access instructions** and note the bucket name and prefix.
4. Publish this folder plus the packaged Lambdas:

   ```bash
   ./scripts/upload-backstage-genai-assets.sh <assets-bucket> <region> [aws-profile] [prefix]
   ```

   The script gates on `py_compile` for every handler, so a syntax error fails
   here rather than halfway through provisioning.

5. **Trigger a new content build in Workshop Studio.** This is mandatory:
   assets are copied to the build artifacts only when a build runs, never when
   they are modified. Skipping it means the event still uses the previous set.
6. Create or restart the test event.

### The `assets/` prefix trap

You upload objects **without** `assets/` in the key, but you **reference** them
with it. `{{.AssetsBucketPrefix}}` already ends in `assets/`, so an object
uploaded to `<uuid>/lambda/prewarm.zip` is referenced as
`<uuid>/assets/lambda/prewarm.zip`. The template is written for that, but the
mismatch is easy to introduce and costs a full provisioning cycle to notice.

### Uploads are scanned, so check the Assets tab afterwards

Workshop Studio scans every object on upload, for malware and - for a specific
set of file types - for static code findings with checkov. The protected types
are `.yaml`, `.yml`, `.json`, `.template`, `.py`, `.sh` and `.bash`, which is
most of what this folder publishes.

The two outcomes behave very differently:

| Outcome | Effect |
|---|---|
| Code findings | **Non-blocking.** Counts and a report link appear on the workshop's Assets tab; sync and event creation still work |
| Malware detected | The file is **truncated to 0 bytes** and removed. The key stays, so the object still appears to exist |

The malware case is the dangerous one: a 0-byte Lambda zip is still a valid S3
object, so nothing fails until CloudFormation tries to create the function. After
publishing, confirm the Assets tab shows no truncated file rather than assuming
that a successful `aws s3 cp` means the object is intact.

### Quotas

500 files, 1 GB per file, 3 GB in total, counted separately from Repository
Assets. This folder uses around ten files.

---

## Local iteration

Changing anything here means rebuilding the image:

```bash
./scripts/upload-backstage-genai-assets.sh <bucket> <region> [profile] [prefix]
aws codebuild start-build --project-name psp-backstage-build --region <region>
aws logs tail /aws/codebuild/psp-backstage-build --follow --region <region>
```

Roughly four minutes. Each of the Dockerfile's seven steps prints its own `OK:`
line, so a failure points straight at the step that broke.

Configuration changes do **not** need a rebuild if you only want to try them:
edit the running deployment instead, and restart it.

```bash
kubectl -n backstage exec deployment/backstage -- cat app-config.genai.yaml
```
