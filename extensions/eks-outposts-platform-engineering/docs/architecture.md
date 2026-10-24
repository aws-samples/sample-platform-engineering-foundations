# Architecture

## Goal

The Platform Engineering demo on Amazon EKS local clusters on AWS Outposts runs the Kubernetes API, etcd, self-managed workers, and the platform services on the Outpost. Platform data lives on Amazon EBS gp2 volumes on the Outpost. Regional APIs are required for provisioning and reconciliation of regional AWS resources. Local Git, registry, metrics, logs, DNS cache, and policy enforcement keep operating when the regional link is unavailable.

![CloudFormation and Terraform are alternative infrastructure inputs to a shared platform contract. Inside a customer data center, an AWS Outposts rack runs the EKS local control plane, self-managed worker nodes, Gitea, Harbor, Argo CD, local observability, DNS and policy services, platform applications, Crossplane, and Amazon EBS gp2. A dashed Service Link reaches Regional lifecycle APIs and a labeled disconnection marker separates the local paths that continue from the Regional calls that stop.](images/eks-outposts-platform-engineering.png)

*Figure 1: Current architecture and the connected-versus-disconnected operating boundary. The editable source is [eks-outposts-platform-engineering.drawio](diagrams/eks-outposts-platform-engineering.drawio).*

## Two infrastructure fronts, one platform

CloudFormation and Terraform provision equivalent network, cluster, node, add-on, and Pod Identity resources. Each front emits `platform-contract.json`. The shared bootstrap is the only consumer of that contract and the only implementation of the platform layer.

| Stage | CloudFormation path | Terraform path | Shared outcome |
|---|---|---|---|
| Infrastructure | Deploy stacks | Apply Terraform modules | Network, cluster, nodes with `AmazonEBSCSIDriverPolicy` on the node role, add-ons, and Pod Identity resources |
| Contract | Emit `platform-contract.json` | Emit `platform-contract.json` | One normalized interface for the platform layer |
| Platform | Use the shared bootstrap | Use the shared bootstrap | EBS CSI driver and StorageClass, local Git, registry, Argo CD, and GitOps-managed services |

The contract contains the cluster name, Region, account identifier, Outpost ARN, Kubernetes version, registry service IP, network ranges, the credential endpoint of the EBS CSI controller, and the local Git URL. It contains no credentials.

## Storage

- The shared bootstrap installs the `aws-ebs-csi-driver` EKS add-on at a pinned version and applies `platform-ebs-gp2` (`ebs.csi.aws.com`, `type: gp2`, encrypted, `WaitForFirstConsumer`). Outposts offer gp2 only.
- The driver uses the worker node instance profile, so it has credentials from node boot, before any per-pod identity agent runs. Both fronts attach `AmazonEBSCSIDriverPolicy` to the node role. The controller NetworkPolicy allows port 80 only to the instance metadata endpoint.
- Harbor, Gitea, VictoriaMetrics, Grafana, Alertmanager, and VictoriaLogs name `platform-ebs-gp2` explicitly. The class is not the cluster default.

### Storage decision for disconnected operations

The cluster control-plane backing store and the workload persistent-storage path are separate decisions:

- Configuring EKS local-cluster control plane and etcd instances with EC2 instance store keeps Kubernetes cluster operations local during a Service Link interruption. It does not provide persistent volumes to workloads.
- The implemented workload path is Amazon EBS. It is durable on the Outpost, but volume mutations and snapshots require Regional APIs.
- A platform that must mutate stateful workloads during a prolonged disconnect needs a locally reachable alternative storage mechanism. The primary candidate is an enterprise array with a vendor-supported Kubernetes CSI driver. Replicated software-defined storage is an alternative with higher node, disk, network, and operational overhead.
- The EC2 Local Instance Store CSI Driver is an ephemeral option, not a durable replacement for the platform claims. It remains outside the automatic deployment and has not been validated on an EKS local cluster.

The complete recommendation, prerequisites, validation status, and sources are in [Storage strategy](../platform/components/storage/README.md).

## Local dependency chain

1. The EBS CSI driver and `platform-ebs-gp2` provide persistent volumes on the Outpost.
2. Harbor and Gitea start while connected.
3. Images and pinned Helm charts are copied locally. Harbor's final local image references are pre-pulled to every current node before the release switches away from upstream references.
4. Argo CD reads the platform repository from Gitea.
5. VictoriaMetrics, VictoriaLogs, NodeLocal DNSCache, NetworkPolicies, Crossplane, and sample apps reconcile from local Git and images.

## Failure boundaries

- During a network disconnect, pods backed by Amazon EBS cannot be created, updated, or scaled, because volume operations call the regional EBS API. Schedule platform changes and node replacement while connected.
- EBS snapshots are created in the AWS Region and cannot be created or deleted during a disconnect.
- Pod Identity, S3, DynamoDB, and other regional APIs stop reconciling when the regional link is unavailable.
- A cold replacement node cannot bootstrap from the local registry until routing, DNS, trust, and the registry are available.
- This assembled package has not been deployed end to end. See the validation boundary in the [README](../README.md#validation-boundary).
