# Optional module: migrating legacy IaC to ACK and kro

The labs build platform APIs on a clean environment. This module addresses the situation you
actually walk into: hundreds of AWS resources already exist, created by CloudFormation, Terraform,
Pulumi, or the console, and you need them under Kubernetes and GitOps control **without recreating
anything**.

Two implementations of the same migration, so you can pick the one that fits how your team works.

| | [`iac-to-ack-kiro-skill`](iac-to-ack-kiro-skill) | [`iac-to-ack-atx-custom`](iac-to-ack-atx-custom) |
|---|---|---|
| Runs in | Kiro, or any agent that loads skills | AWS Transform custom, via the `atx` CLI |
| Interaction | Conversational, resource by resource | Batch, whole repository in one run |
| Input | The resource you point it at | Your IaC source tree |
| Output | An adoption manifest, produced with you | Manifests plus `ADOPTION_REPORT.md`, unattended |
| Reads your IaC | No, reads live AWS state | Yes, parses CloudFormation, Terraform, and Pulumi |
| Generates kro RGDs | No | Yes, from modules and nested stacks |
| Best for | Learning the mechanics, one-off adoptions, a service you have not adopted before | Migrating an estate at scale, repeatable and auditable |

Both produce the same shape of artefact and follow the same two non-negotiable rules: the
`adopt-or-create` adoption policy, and `deletion-policy: retain` on every manifest so deleting a
Kubernetes object never deletes the AWS resource behind it.

## What the workshop IDE gets from this folder

Module 4 of the workshop runs inside the browser IDE, which seeds two directories from the assets
bucket at provisioning time. `scripts/upload-iac-migration-assets.sh` publishes them:

| In this repository | Bucket key | In the IDE |
|---|---|---|
| [`legacy-estate/`](legacy-estate) | `iac-migration/legacy-estate/` | `~/environment/legacy-iac` (initialised as a git repository) |
| [`iac-to-ack-atx-custom/`](iac-to-ack-atx-custom) | `iac-migration/ack-resource-adoption-from-iac/` | `~/environment/ack-adoption-transformation` (without `README.md` and `BENCHMARKS.md`) |

The estate is a small payments platform in Terraform, CloudFormation and Crossplane, written to be
read and transformed, **never applied**. Its security findings are deliberate; see
[legacy-estate/README.md](legacy-estate/README.md).

**Suggested path.** Do one resource by hand with the Kiro Skill first. Adoption has a failure mode
that is easy to hit and hard to diagnose from a batch report, and doing it once manually makes the
batch output legible. Then run the ATX transformation across the real repository.

---

## Front 1: Kiro Skill

Conversational adoption. You point it at an existing resource, it walks discovery, generates the
manifest, and validates the ACK status conditions with you.

```
iac-to-ack-kiro-skill/
├── SKILL.md                            the procedure
└── references/adoption-fields-ref.md   which identifier each service needs, per Kind
```

Opens with a mandatory freshness check against the ACK service controller matrix and the upstream
API definition, because ACK adds fields without bumping the API version and a manifest written from
a stale reference fails reconciliation with `Terminal: True`.

**Prerequisites:** the ACK controller for the target service, the `ResourceAdoption` feature gate
(on by default with EKS Capabilities, off by default on a self-managed Helm install), and IAM
permissions through EKS Pod Identity or IRSA.

Reads perfectly well as a human runbook if you would rather work through it yourself.

## Front 2: AWS Transform custom

Batch migration. Parses your IaC, emits adoption manifests for everything it can map, translates
reusable modules and nested stacks into kro `ResourceGraphDefinition`s, and reports what it refused
to guess.

```
iac-to-ack-atx-custom/
├── README.md          overview, usage, troubleshooting
├── SKILL.md           the transformation definition
├── BENCHMARKS.md      end-to-end results across Terraform, CloudFormation, Pulumi and Crossplane
└── references/
    ├── iac-to-ack-mapping.md      IaC resource type to ACK Kind
    ├── adoption-fields-ref.md     per-Kind identifier reference with discovery commands
    ├── kro-patterns.md            module and nested stack to RGD translation rules
    ├── crossplane-to-ack-kro.md   Crossplane managed resources and Compositions to ACK and kro
    └── examples-iac-to-ack.md     worked before and after examples
```

**Prerequisites:** the AWS Transform CLI
(`curl -fsSL https://transform-cli.awsstatic.com/install.sh | bash`), Node.js 22 or later, a Git
repository with at least one commit, and AWS credentials carrying
`AWSTransformCustomExecuteTransformations` or `AWSTransformCustomFullAccess`. The workshop IDE
installs `atx` 3.9.0 for you.

**Region note for South America.** AWS Transform custom runs in `us-east-1`, `eu-central-1`,
`eu-west-2`, `ca-central-1`, `ap-northeast-1`, `ap-northeast-2`, `ap-southeast-2`, and `ap-south-1`.
It is **not available in `sa-east-1`**. Set `AWS_REGION=us-east-1` for the transformation: it reads
your code, not your clusters, so where your workloads run is unaffected.

`atx custom def publish` rejects a definition directory that contains anything other than
`SKILL.md`, `references/` and `scripts/`, so publish from a copy without the two documentation files
(the workshop IDE already has one, at `~/environment/ack-adoption-transformation`):

```bash
mkdir -p /tmp/ack-adoption-def
cp -R iac-to-ack-atx-custom/SKILL.md iac-to-ack-atx-custom/references /tmp/ack-adoption-def/

atx custom def publish -n ack-resource-adoption-from-iac \
    --sd /tmp/ack-adoption-def \
    --description "Generates ACK adoption manifests and kro RGDs from CloudFormation, Terraform, Pulumi and Crossplane"

atx custom def exec -n ack-resource-adoption-from-iac -p /path/to/your-iac-repo -x -t
```

> The transformation name stays `ack-resource-adoption-from-iac`, matching the upstream submission,
> while the directory is named for the delivery mechanism. Publish with the name, not the folder.

### Source

Vendored from the AWS Transform custom samples, pinned so the workshop does not change under you
when upstream moves. For your own migrations, start from the upstream version.

| | |
|---|---|
| Upstream | [aws-transform-custom-samples, `community-sourced-transformations/ack-resource-adoption-from-iac`](https://github.com/aws-samples/aws-transform-custom-samples/tree/main/community-sourced-transformations/ack-resource-adoption-from-iac) |
| Introduced by | [aws-samples/aws-transform-custom-samples#74](https://github.com/aws-samples/aws-transform-custom-samples/pull/74) |
| Synced with | upstream commit `02f758b` (adds Crossplane as the fourth IaC flavor) |

---

## The two rules that matter

Everything else in both fronts is mechanics. These two are the difference between a migration and an
outage.

**1. `deletion-policy: retain`, always.**

```yaml
metadata:
  annotations:
    services.k8s.aws/deletion-policy: "retain"
```

Without it, `kubectl delete` on the Kubernetes object deletes the production AWS resource. Set it at
the namespace or controller level as well as per resource, so a manifest that forgets it inherits the
safe default.

**2. `adopt-or-create` reconciles after adopting.**

Once adopted, ACK compares your declared spec against real AWS state and moves AWS toward your spec.
If your manifest is an approximation of the resource, adoption succeeds and then quietly changes
production. Either make the spec reflect reality before applying, or use `adopt` on its own for pure
observation with no drift risk.

---

## Where to go next

Once resources are adopted and reconciling, the natural progression is fleet management, which
applies the same kro and ACK pair one level up: the EKS cluster itself becomes a resource with an
API. That is a separate AWS sample:
[aws-samples/fleet-management-on-amazon-eks-workshop](https://github.com/aws-samples/fleet-management-on-amazon-eks-workshop).
