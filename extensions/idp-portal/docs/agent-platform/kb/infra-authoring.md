# Infrastructure Manifest Authoring Standard

## Purpose

Generate short, reviewable Kubernetes manifests for infrastructure capabilities implemented with
kro and AWS Controllers for Kubernetes (ACK). Git is the only write path. Argo CD is the only
component that applies desired state.

## Preferred abstraction

Users request a kro instance, not raw AWS resources. Use raw ACK only when authoring or debugging a
ResourceGraphDefinition.

```yaml
apiVersion: kro.run/v1alpha1
kind: PostgresDatabase
metadata:
  name: example
  namespace: appmod
spec:
  owner: team-name
  size: small
  environment: internal
  deletionPolicy: Retain
```

## kro ResourceGraphDefinition rules

- `apiVersion: kro.run/v1alpha1` and `kind: ResourceGraphDefinition`.
- Schema exposes user intent, never ARN, subnet ID, security group ID or secret value.
- Guardrails belong in the composition: encryption, backup, network, tags and retention.
- Data resources default to `deletionPolicy: Retain`.
- Nested resource graphs reuse the same infra capability inside and outside an Agent.
- Status fields expose Ready, endpoint reference and reconciliation errors without secret data.

## ACK rules

- ACK API groups end in `services.k8s.aws`.
- Prefer service controllers delivered by the EKS ACK Capability.
- Every AWS resource must receive tag `auto-delete: no` through the composition.
- Never place credentials in YAML. Write only a `Secret` reference or Secrets Manager reference.
- No public S3 bucket, public database, Lambda Function URL, public API or wildcard IAM principal.
- Do not expose `LoadBalancer`, `NodePort`, Ingress or HTTPRoute for platform workloads.
- Scope IAM permissions to the resources derived from the capability request.

## Lint invariants

Reject a manifest when any condition is true:

1. YAML is invalid or has multiple documents when one was requested.
2. `apiVersion`, `kind`, `metadata.name` or `spec` is absent.
3. Container image uses `:latest`.
4. Service uses `LoadBalancer` or `NodePort`.
5. Manifest contains inline password, token, secret key or private key.
6. Data deletion policy is not explicit or defaults to deletion.
7. Raw ACK resource weakens encryption, public-access blocking, backup or network guardrails.
8. Name is not a lowercase Kubernetes DNS label.

## Current platform facts

- EKS cluster: `appmod-agent-platform-lab`, region `sa-east-1`.
- EKS Capabilities: Argo CD `3.3.10-eks-7`, ACK `46.137.1-eks-1`, kro `0.9.2-eks-3`.
- Current working RGD: `ScheduledAgent` in `platform/compositions/scheduled-agent-rgd.yaml`.
- Current working instance: `platform/instances/hello-agent.yaml`.

## Authoritative references

- EKS Argo CD Capability: https://docs.aws.amazon.com/eks/latest/userguide/argocd.html
- ACK documentation: https://aws-controllers-k8s.github.io/community/docs/
- kro documentation: https://kro.run/docs/
- Local platform design: `docs/agent-platform/design.md`
