# Architecture

## Goal

Amazon EKS local clusters on AWS Outposts configured with EC2 instance store runs the Kubernetes API, etcd, self-managed workers, and the platform services on the Outpost. Regional APIs are required for provisioning and reconciliation of regional AWS resources. Local Git, registry, metrics, logs, DNS cache, and policy enforcement keep operating when the regional link is unavailable.

## Two infrastructure fronts, one platform

CloudFormation and Terraform provision equivalent network, cluster, node, add-on, and Pod Identity resources. Each front emits `platform-contract.json`. The shared bootstrap is the only consumer of that contract and the only implementation of the platform layer.

| Stage | CloudFormation path | Terraform path | Shared outcome |
|---|---|---|---|
| Infrastructure | Deploy stacks | Apply Terraform modules | Network, cluster, nodes, add-ons, and Pod Identity resources |
| Contract | Emit `platform-contract.json` | Emit `platform-contract.json` | One normalized interface for the platform layer |
| Platform | Use the shared bootstrap | Use the shared bootstrap | Local Git, registry, Argo CD, and GitOps-managed services |

The contract contains the cluster name, Region, account identifier, Outpost ARN, Kubernetes version, registry service IP, and local Git URL. It contains no credentials.

## Local dependency chain

1. The instance store CSI add-on provides ephemeral local volumes.
2. Harbor and Gitea start while connected.
3. Images and pinned Helm charts are copied locally. Harbor's final local image references are pre-pulled to every current node before the release switches away from upstream references.
4. Argo CD reads the platform repository from Gitea.
5. VictoriaMetrics, VictoriaLogs, NodeLocal DNSCache, NetworkPolicies, Crossplane, and sample apps reconcile from local Git and images.

## Failure boundaries

- Instance store data is lost with its node. Network disconnection and node loss are different failure modes.
- Pod Identity, S3, DynamoDB, and other regional APIs stop reconciling when the regional link is unavailable.
- A cold replacement node cannot bootstrap from the local registry until routing, DNS, trust, and the registry are available.
- The implementation has not been validated on an EC2 instance store Outpost. Run the validation contract before describing it as hardware-validated.
