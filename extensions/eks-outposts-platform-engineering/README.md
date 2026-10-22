# Amazon EKS local clusters on AWS Outposts configured with EC2 instance store

This extension adds a disconnected-platform demo without changing the repository's existing workshop or self-paced flow.

## Choose one infrastructure front

| Front | Entry point | State and rollback | Best fit |
|---|---|---|---|
| CloudFormation | `bash infrastructure/cloudformation/deploy.sh` | CloudFormation stacks and change sets | Teams standardized on AWS-native IaC |
| Terraform | `infrastructure/terraform/main.tf` | Terraform state, plan, and destroy | Teams standardized on Terraform |

Choose exactly one front for an environment. Both converge on the same architecture and emit the same normalized `platform-contract.json` keys:

```json
{
  "cluster_name": "platform-outposts",
  "aws_region": "<AWS_REGION>",
  "account_id": "<AWS_ACCOUNT_ID>",
  "outpost_arn": "<OUTPOST_ARN>",
  "kubernetes_version": "<SUPPORTED_KUBERNETES_VERSION>",
  "registry_service_ip": "172.20.0.20",
  "node_subnet_cidr": "10.40.1.0/24",
  "bastion_subnet_cidr": "10.40.0.0/24",
  "kubernetes_service_ip_cidr": "172.20.0.1/32",
  "cluster_dns_service_ip": "172.20.0.10",
  "ebs_csi_controller_credential_cidr": "169.254.170.23/32",
  "gitea_repo": "http://gitea-http.git-local.svc.cluster.local:3000/platform-admin/platform-demo.git"
}
```

No platform implementation is duplicated between the fronts. Neither CloudFormation nor Terraform declares the VPC CNI add-on. The shared bootstrap is the single owner of strict NetworkPolicy enforcement and policy event logging. The shared path is:

1. `bash scripts/fetch-charts.sh` downloads pinned third-party charts while connected and verifies every package against `scripts/charts.lock`. Charts and returned license files stay in the ignored runtime directory and are not committed to the public repository.
2. The selected IaC front creates the network, cluster, self-managed nodes, core add-ons, and the Crossplane identity boundary.
3. `bash platform/gitops/bootstrap.sh platform-contract.json` installs the local registry, local Git, Argo CD, instance store CSI add-on, logging add-on, and shared GitOps applications.
4. The shared bootstrap configures the CoreDNS add-on. Argo CD reconciles NodeLocal DNSCache, local observability and logging, NetworkPolicies, Crossplane recipes, and the NetworkPolicy sample.
5. `bash scripts/validate.sh --runtime` checks the running paths. Follow `docs/validation.md` for the paired controls and disconnected test.

## Prerequisites

- An Outpost with capacity for the selected control plane, etcd, and worker instance types.
- A worker instance type supported by the EC2 local instance store CSI driver.
- AWS CLI, CloudFormation or Terraform, `kubectl`, Helm, Git, `curl`, `jq`, `shasum`, and Python 3.
- A TLS certificate and private key for `harbor.local`, plus its public CA certificate. The certificate and key stay outside Git.
- Pinned versions for the instance store CSI, Pod Identity agent, VPC CNI, CoreDNS, and fluent-bit EKS add-ons.

## Deliberately omitted source features

The public package omits the source MetalLB L2 and dedicated L4 VIP paths. The selected source did not provide a completed, hardware-validated external reachability path for an Outposts VPC subnet. The NetworkPolicy demo remains internal to the cluster and uses paired pod-to-pod controls. Add an external exposure method only after validating ownership and routing for the target subnet.

## Validation boundary

The selected source was not validated on an EC2 instance store Outpost. The package preserves the authored controls and provides a runnable validation contract, but it must not be described as hardware-validated until the target Outpost passes the connected and disconnected checks. Instance store volumes are ephemeral and do not survive node termination.

## Cleanup

Use `bash scripts/cleanup.sh` with the chosen front. The script requires an explicit `DELETE` confirmation and targets only the named stacks or Terraform state supplied by the operator.

See [Architecture](docs/architecture.md) and [Validation](docs/validation.md).
