---
name: ack-resource-adoption
description: >
  Guides the adoption of existing AWS resources into ACK (AWS Controllers for Kubernetes)
  management using the ResourceAdoption feature gate and adopt-or-create policy.
  Use this skill when migrating resources created via Terraform, CloudFormation, Pulumi,
  Click-Ops, or any other tool into GitOps/ACK control. Covers discovery, manifest
  generation, deletion policy, validation, and gotchas. Keywords: ACK adoption,
  adopt-or-create, ResourceAdoption, migrate to ACK, ACK feature gate, existing AWS resources.
---

# ACK Resource Adoption

Adopts existing AWS resources into ACK management using the `ResourceAdoption` Feature Gate with `adopt-or-create` policy.
The source tool (Terraform, CFN, Pulumi, Click-Ops) is irrelevant - ACK reads the current state directly from AWS.

---

## Step 0 — Validate ACK Documentation Freshness (MANDATORY)

Run BEFORE generating any adoption manifest. ACK ships new fields without bumping the API
version, so a manifest written from a stale skill snapshot can fail reconciliation with
`Terminal: True` after apply. This step is non-skippable.

### 0.1 — Service controllers matrix

Fetch and inspect the [ACK service controllers status](https://aws-controllers-k8s.github.io/community/docs/community/services/) page:

1. Confirm the target service is listed.
2. Confirm its maintenance phase:
   - **GENERALLY AVAILABLE** → safe to adopt in production.
   - **PREVIEW** → adopt only in non-prod; expect breaking changes.
   - **MAINTENANCE** → community-supported, validate carefully.
3. If the service is missing or in PREVIEW/MAINTENANCE → flag this in the output before proceeding.

### 0.2 — Per-service schema diff (current vs. skill examples)

For the target Kind, fetch the current API definition from the upstream repo:

```
https://github.com/aws-controllers-k8s/<service>-controller/blob/main/apis/v1alpha1/<kind>_types.go
```

(Or browse the rendered docs at https://aws-controllers-k8s.github.io/community/reference/.)

Compare against the example in this skill:

| Validation | Action |
|-----------|--------|
| Field used in skill example NOT in current spec | Remove from generated manifest + flag deprecation |
| Required field in current spec NOT in skill example | Add to generated manifest + warn user |
| New optional field with adoption value (e.g., new identifier in status) | Update `references/adoption-fields-ref.md` |
| API version bumped (e.g., v1alpha1 → v1beta1) | Update `apiVersion` in manifest + flag |

### 0.3 — Record freshness in generated YAML

Add a comment header to the generated manifest with the validation timestamp:

```yaml
# ACK adoption manifest
# Service controller status checked: <ISO timestamp>
# Schema validated against: aws-controllers-k8s/<service>-controller@main
apiVersion: <service>.services.k8s.aws/v1alpha1
kind: <Kind>
...
```

If Step 0 surfaces any change → present a summary to the user and ask for confirmation
before emitting the final manifest.

---

## Prerequisites

- ACK controller for the target service installed (via EKS Capabilities or Helm)
- `ResourceAdoption` Feature Gate enabled (see note below)
- IRSA configured with permissions for the target service

> **EKS Capabilities:** The `ResourceAdoption` feature gate is **enabled by default** when installing ACK controllers via EKS Capabilities. No additional configuration needed.
> For self-managed Helm installs, the feature gate is disabled by default and must be explicitly enabled.

### Verify Feature Gate is active

```bash
# Check current feature gate status
kubectl get deployment -n ack-system -o yaml | grep -A5 "featureGates"

# Helm install - enable if not using EKS Capabilities
helm upgrade ack-$SERVICE-controller \
  oci://public.ecr.aws/aws-controllers-k8s/$SERVICE-chart \
  --namespace ack-system \
  --set featureGates.ResourceAdoption=true
```

---

## Adoption Flow

```
1. Discovery  →  2. Manifest  →  3. Apply  →  4. Validate  →  5. Reconcile
   (AWS CLI)      (YAML)          (kubectl)    (conditions)    (ACK becomes source of truth)
```

---

## Step 1 — Discovery: find the resource identifier

Query AWS to get the exact identifier needed in `adoption-fields`.
See full reference table in `references/adoption-fields-ref.md`.

```bash
# Quick reference by service
aws eks list-clusters
aws ec2 describe-vpcs --query 'Vpcs[*].{ID:VpcId,Name:Tags[?Key==`Name`].Value|[0]}'
aws sqs list-queues
aws rds describe-db-instances --query 'DBInstances[*].DBInstanceIdentifier'
aws s3api list-buckets --query 'Buckets[*].Name'
aws dynamodb list-tables
aws sns list-topics --query 'Topics[*].TopicArn'
aws iam list-roles --query 'Roles[*].{Name:RoleName,ARN:Arn}'
```

---

## Step 2 — Manifest with adopt-or-create

### Required pattern

```yaml
apiVersion: <service>.services.k8s.aws/v1alpha1
kind: <Kind>
metadata:
  name: <k8s-object-name>
  annotations:
    services.k8s.aws/adoption-policy: "adopt-or-create"   # ALWAYS use this
    services.k8s.aws/deletion-policy: "retain"             # ALWAYS use this - see Gotchas
    # adoption-fields: only needed when the identifier lives in status (not spec)
    # services.k8s.aws/adoption-fields: |
    #   {"fieldName": "value"}
spec:
  # Populate with fields required for find + create
  # ACK will overwrite with the actual AWS state after adoption
```

### adopt-or-create behavior

- Resource **exists** in AWS → adopts it, populates spec + status, then syncs to declared state
- Resource **does not exist** in AWS → creates it from spec
- After successful adoption → ACK becomes source of truth and applies updates

---

## Examples by service

### EKS Cluster

```yaml
apiVersion: eks.services.k8s.aws/v1alpha1
kind: Cluster
metadata:
  name: my-cluster
  annotations:
    services.k8s.aws/adoption-policy: "adopt-or-create"
    services.k8s.aws/deletion-policy: "retain"
spec:
  name: my-cluster
  roleARN: arn:aws:iam::123456789012:role/eks-cluster-role
  version: "1.32"
  resourcesVPCConfig:
    endpointPrivateAccess: true
    endpointPublicAccess: true
    subnetIDs:
      - subnet-xxxxxxxxxxxxxxxxx
      - subnet-yyyyyyyyyyyyyyyyy
```

### VPC (adoption-fields required - vpcID lives in status)

```yaml
apiVersion: ec2.services.k8s.aws/v1alpha1
kind: VPC
metadata:
  name: my-vpc
  annotations:
    services.k8s.aws/adoption-policy: "adopt-or-create"
    services.k8s.aws/deletion-policy: "retain"
    services.k8s.aws/adoption-fields: |
      {"vpcID": "vpc-0abc123def456"}
spec:
  cidrBlocks:
    - "10.0.0.0/16"
```

### SQS Queue (adoption-fields required - queueURL lives in status)

```yaml
apiVersion: sqs.services.k8s.aws/v1alpha1
kind: Queue
metadata:
  name: my-queue
  annotations:
    services.k8s.aws/adoption-policy: "adopt-or-create"
    services.k8s.aws/deletion-policy: "retain"
    services.k8s.aws/adoption-fields: |
      {"queueURL": "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue"}
spec:
  queueName: my-queue
```

### S3 Bucket

```yaml
apiVersion: s3.services.k8s.aws/v1alpha1
kind: Bucket
metadata:
  name: my-bucket
  annotations:
    services.k8s.aws/adoption-policy: "adopt-or-create"
    services.k8s.aws/deletion-policy: "retain"
spec:
  name: my-bucket
```

### DynamoDB Table

```yaml
apiVersion: dynamodb.services.k8s.aws/v1alpha1
kind: Table
metadata:
  name: my-table
  annotations:
    services.k8s.aws/adoption-policy: "adopt-or-create"
    services.k8s.aws/deletion-policy: "retain"
spec:
  tableName: my-table
```

### SNS Topic (adoption-fields required - ARN lives in status)

```yaml
apiVersion: sns.services.k8s.aws/v1alpha1
kind: Topic
metadata:
  name: my-topic
  annotations:
    services.k8s.aws/adoption-policy: "adopt-or-create"
    services.k8s.aws/deletion-policy: "retain"
    services.k8s.aws/adoption-fields: |
      {"arn": "arn:aws:sns:us-east-1:123456789012:my-topic"}
spec:
  name: my-topic
```

---

## Step 3 — Apply

```bash
kubectl apply -f resource.yaml

# Watch reconciliation
kubectl get <kind> <name> -w
```

---

## Step 4 — Validate Status Conditions

```bash
kubectl describe <kind> <name>
```

| Condition | Expected after adoption | Meaning |
|-----------|------------------------|---------|
| `ACK.Adopted` | `True` | Resource successfully adopted |
| `ACK.ResourceSynced` | `True` | State in sync with AWS |
| `ACK.Terminal` | `False` | No fatal spec errors |
| `ACK.Recoverable` | `False` | No transient errors |
| `ACK.ReferencesResolved` | `True` | Cross-resource references resolved |

- `ACK.Terminal: True` → invalid or incompatible spec field. Fix and re-apply.
- `ACK.Recoverable: True` → transient error (credentials, throttle). Wait or check IRSA.

---

## Critical Gotchas

### 1. ALWAYS set deletion-policy: retain

```yaml
# Without this, deleting the K8s CR will delete the actual AWS resource
annotations:
  services.k8s.aws/deletion-policy: "retain"
```

Can be set at 3 levels (precedence: resource > namespace > controller):

```bash
# Entire namespace (recommended for bulk adoption environments)
kubectl annotate namespace <ns> s3.services.k8s.aws/deletion-policy=retain

# Controller-wide via Helm
helm upgrade ... --set deletionPolicy=retain
```

### 2. adopt-or-create will attempt updates after adoption

After adopting, ACK compares the declared spec against the real AWS state and tries to reconcile.
If the spec differs from the actual resource, ACK will attempt to update AWS.
- Ensure the spec reflects the current resource state before applying
- Or use `adopt` (without `-or-create`) for pure adoption with no drift risk

### 3. adoption-fields: when to use

Only needed when the identifier field lives in **status** (not spec).
Examples: `vpcID`, `queueURL`, SNS `arn`. See full table in `references/adoption-fields-ref.md`.

### 4. ReadOnly after adoption (optional)

To observe a resource without ACK applying any updates:

```yaml
annotations:
  services.k8s.aws/adoption-policy: "adopt"
  services.k8s.aws/read-only: "true"
  services.k8s.aws/adoption-fields: |
    {"name": "my-cluster"}
```

Useful for shared resources where you want K8s visibility without active management.
Docs: https://aws-controllers-k8s.github.io/community/docs/user-docs/features/#readonlyresources

---

## References

- Feature Gates: https://aws-controllers-k8s.github.io/community/docs/user-docs/features/
- Deletion Policy: https://aws-controllers-k8s.github.io/community/docs/user-docs/deletion-policy/
- Adoption fields reference by service: `references/adoption-fields-ref.md`
