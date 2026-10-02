---
title: "Legacy estate - payments platform"
---

# Legacy estate - payments platform

Read-only input for **section 4.2**. This is the inherited IaC repository the
transformation reads to produce ACK adoption manifests and kro
`ResourceGraphDefinition`s.

It is seeded into your IDE at `~/environment/legacy-iac/`.

## It is never applied

There is no `terraform init`, no `terraform apply`, no `aws cloudformation
deploy`. Applying it would create real infrastructure and cost real money, and
the exercise is about reading IaC, not provisioning it. The transformation is
read-only on both sides: it parses these files and writes manifests, and never
calls an AWS API.

## The security findings in here are deliberate - do not "fix" them

Static analysis tools (checkov, tflint, cfn-lint and similar) report findings
against these files, and they are supposed to be there: an RDS instance without
IAM authentication, S3 buckets without access logging or block-public settings,
an API Gateway without access logging.

That is the point. This is the estate a platform team *inherits*, and module 4
exists to adopt it into ACK and kro without recreating it. An estate that passes
every check would teach nothing: the participant needs to see a real one, with
the compromises real ones carry, and the `deletion-policy: retain` discipline
that makes adopting it safe.

So: these findings are accepted, permanently. They are not a backlog item, they
do not need `checkov:skip` annotations, and a future reviewer should not spend
time on them. If you harden this estate, you break the exercise.

## What is in it

A payments platform, in the three flavours you actually inherit:

```text
legacy-iac/
├── terraform/
│   ├── main.tf                       # buckets, IAM role, security group, RDS
│   ├── variables.tf                  # defaults are an identifier source
│   ├── terraform.tfvars              # so is this
│   ├── outputs.tf
│   └── modules/serverless-api/       # a composition unit -> kro RGD
├── cloudformation/
│   ├── payments-parent.yaml          # flat resources + a nested stack
│   └── nested/data-tier.yaml         # the nested stack -> kro RGD
└── crossplane/
    ├── managed/                      # managed resources -> flat ACK manifests
    ├── apis/                         # XRD + Composition -> kro RGD
    └── claims/                       # a claim -> kro instance
```

Only services this workshop enables as ACK controllers appear here: S3, RDS,
EC2, IAM, Lambda and API Gateway v2. That means the generated manifests map to
CRDs that actually exist in your cluster, so the transformation's `kubectl apply
--dry-run=client` validation stage has something to validate against.

## What it is designed to teach

The estate is mixed on purpose, so the output is worth reading rather than
uniform:

| In the estate | In the output | Why |
|:---|:---|:---|
| Bucket names, role names, DB identifiers | Resolved identifiers | These live in `spec`, and the literal is right there in the source |
| Security groups | `TODO(discovery)` | The id lives in `status` and does not exist until an apply. There is nothing in the source to resolve |
| `modules/serverless-api` | One RGD + one instance | A module is a unit that deploys and evolves together |
| `nested/data-tier.yaml` | One RGD + one instance | A nested stack is the same statement in CloudFormation |
| `terraform.tfvars` | Feeds the resolutions above | tfvars is one of the identifier sources the transformation reads |
| `crossplane/managed/` | Resolved identifiers | Crossplane already recorded the physical name in `crossplane.io/external-name` |
| `crossplane/apis/` + `claims/` | One RGD + one instance | A Composition is the Crossplane way of saying "these deploy together" |
| `deletionPolicy: Delete` on the evidence bucket | A cutover note in the report | While Crossplane still runs, two controllers would own the same bucket |

The security groups are the interesting case. A `TODO(discovery)` is not a
failure, it is the transformation refusing to guess: a wrong `adoption-fields`
value silently creates a duplicate resource, which is the exact defect you
reproduced by hand in **4.1**. An explicit gap with the CLI command to close it
is the safer output.

## Provenance

Written for this workshop, following the conventions in the
[Terraform AWS provider documentation](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)
and the [AWS CloudFormation template reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-reference.html).
It is deliberately small enough to read end to end, which a vendored real-world
repository would not be.
