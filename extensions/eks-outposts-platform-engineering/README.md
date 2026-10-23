# Platform Engineering demo on Amazon EKS local clusters on AWS Outposts

This extension is a Platform Engineering demo that runs on [Amazon EKS local clusters on AWS Outposts](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-local-cluster-overview.html). The Kubernetes control plane, self-managed worker nodes, and a local platform (Git, registry, GitOps, observability, DNS caching, NetworkPolicies, and Crossplane recipes) run on the Outpost. Platform data lives on Amazon EBS gp2 volumes on the Outpost through the Amazon EBS CSI driver. The extension does not change the repository's existing workshop or self-paced flow.

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
  "ebs_csi_controller_credential_cidr": "169.254.169.254/32",
  "gitea_repo": "http://gitea-http.git-local.svc.cluster.local:3000/platform-admin/platform-demo.git"
}
```

No platform implementation is duplicated between the fronts. Neither CloudFormation nor Terraform declares the VPC CNI or the Amazon EBS CSI driver add-on. The shared bootstrap is the single owner of both: strict NetworkPolicy enforcement with policy event logging, and the pinned `aws-ebs-csi-driver` add-on with the `platform-ebs-gp2` StorageClass. Both fronts attach `AmazonEBSCSIDriverPolicy` to the worker node role, so the driver authenticates with the node instance profile, and `ebs_csi_controller_credential_cidr` opens only the instance metadata endpoint to the controller.

`python3 scripts/check-iac-parity.py` exercises both contract emitters with the same synthetic environment, compares all 12 normalized keys and values, checks both entry points, compares the Crossplane Pod Identity trust and permission boundaries, and checks the EBS storage boundary: add-on ownership and bootstrap order, the node role policy in both fronts, the controller credential endpoint and its NetworkPolicy rule, the StorageClass, and the class named in every platform values file. Mutation controls prove that the gate detects contract, identity, permission, VPC CNI ownership, EBS CSI ownership and order, node policy, controller credential, StorageClass, and entry-point drift. When the pinned charts are fetched, `bash scripts/validate.sh` also renders them and requires every claim to use `platform-ebs-gp2`. `bash scripts/validate.sh` runs this gate automatically.

The shared path is:

1. `bash scripts/fetch-charts.sh` downloads pinned third-party charts while connected and verifies every package against `scripts/charts.lock`. Charts and returned license files stay in the ignored runtime directory and are not committed to the public repository.
2. The selected IaC front creates the network, cluster, self-managed nodes, core add-ons, and the Crossplane identity boundary.
3. `bash platform/gitops/bootstrap.sh platform-contract.json` installs the Amazon EBS CSI driver and the `platform-ebs-gp2` StorageClass, then the local registry, local Git, Argo CD, logging add-on, and shared GitOps applications.
4. The shared bootstrap configures the CoreDNS add-on. Argo CD reconciles NodeLocal DNSCache, local observability and logging, NetworkPolicies, Crossplane recipes, and the NetworkPolicy sample.
5. `bash scripts/validate.sh --runtime` checks the running paths, including an EBS-backed smoke volume and the class of every platform claim. Follow `docs/validation.md` for the paired controls and disconnected test.

## Prerequisites

- An Outpost rack with Amazon EBS available, and capacity for the selected control plane, etcd, and worker instance types. The local cluster provisions its own control plane EBS volumes, as described in [capacity considerations](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-capacity-considerations.html).
- Amazon EBS gp2 capacity for the worker root volumes (100 GiB per node by default) and about 143 GiB of platform claims (Harbor 56 GiB, Gitea 20 GiB, VictoriaMetrics with Grafana and Alertmanager 37 GiB, VictoriaLogs 30 GiB). [Outposts support Amazon EBS gp2 volumes only](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-local-cluster-create.html).
- AWS CLI, CloudFormation or Terraform, `kubectl`, Helm, Git, `curl`, `jq`, `shasum`, and Python 3.
- A TLS certificate and private key for `harbor.local`, plus its public CA certificate. The certificate and key stay outside Git.
- Pinned versions for the Amazon EBS CSI driver (`EBS_CSI_ADDON_VERSION`), Pod Identity agent, VPC CNI, CoreDNS, and fluent-bit EKS add-ons.

## Deliberately omitted source features

The public package omits the source MetalLB L2 and dedicated L4 VIP paths. The selected source did not provide a completed, hardware-validated external reachability path for an Outposts VPC subnet. The NetworkPolicy demo remains internal to the cluster and uses paired pod-to-pod controls. Add an external exposure method only after validating ownership and routing for the target subnet.

## Validation boundary

The storage architecture comes from a source implementation that ran on an Outpost rack offering gp2 only, with Kubernetes 1.33 local clusters built by both fronts and self-managed `c5d.xlarge` workers. On both clusters, platform claims were bound to EBS gp2 volumes on the Outpost through the `aws-ebs-csi-driver` add-on. On the Terraform-built cluster the controller used the node instance profile, which is the credential path this package implements. On the CloudFormation-built cluster the controller used a dedicated Pod Identity role during those measurements; there, data survived pod deletion, and a database volume moved between nodes. That run bound the platform claims through the cluster-provided `gp2` class. This package names the CSI gp2 class from the Amazon EKS guidance explicitly; the source exercised that class with standalone volumes on the same rack. This public package as assembled here has not been deployed end to end. Run the connected and disconnected checks in `docs/validation.md` on the target Outpost before describing a deployment as validated.

During a network disconnect, [pods backed by Amazon EBS cannot be created, updated, or scaled](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-network-disconnects.html), and EBS snapshots cannot be created or deleted, because those operations call regional APIs.

Outposts configured with EC2 instance store use the updated local-cluster architecture. Because the entire Kubernetes cluster runs locally, applications remain available and cluster operations can continue during cloud disconnections when local authentication, DNS, images, observability, and spare capacity are prepared. This does not make regional APIs available, so workloads that depend on Amazon EBS, IRSA, or EKS Pod Identity still need the dependency planning described above. See the official [instance-store local-cluster overview](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-instance-store-local-cluster-overview.html) and [network-disconnection preparation guide](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-instance-store-network-disconnects.html).

## Cleanup

Use `bash scripts/cleanup.sh` with the chosen front. The script requires an explicit `DELETE` confirmation and targets only the named stacks or Terraform state supplied by the operator. Before it removes the infrastructure, it writes an inventory of the EBS volumes that the EBS CSI driver provisioned through `platform-ebs-gp2` with reclaim policy `Delete`, outside Git. Afterwards it deletes only those volumes, only after they are `available` and carry the driver's `ebs.csi.aws.com/cluster` and matching `CSIVolumeName` tags. Volumes it cannot delete stay in the inventory, and `bash scripts/cleanup.sh volumes <inventory-file>` retries only that step.

See [Architecture](docs/architecture.md), [Validation](docs/validation.md), and [Amazon EBS storage](platform/components/storage/README.md).
