# Storage strategy

## Implemented baseline: Amazon EBS

Platform PersistentVolumeClaims use `platform-ebs-gp2`, a StorageClass served by the Amazon EBS CSI driver (`ebs.csi.aws.com`) with `type: gp2`. The shape follows the Amazon EKS guidance for local clusters on AWS Outposts: [Amazon EBS on Outposts supports gp2 volumes only](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-local-cluster-create.html), and [self-managed nodes on Outposts need the EBS CSI driver and a gp2 storage class](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-self-managed-nodes.html).

- The shared bootstrap installs the `aws-ebs-csi-driver` EKS add-on at a pinned version. Neither infrastructure front declares it.
- The driver authenticates with the worker node instance profile. Both fronts attach `AmazonEBSCSIDriverPolicy` to the node role, and the `ebs-csi-controller` NetworkPolicy opens only the instance metadata endpoint on port 80 for that credential.
- The class is not the cluster default. Every platform chart names it explicitly, so a second default class cannot capture a platform volume.
- Volumes stay on the Outpost and survive pod rescheduling and node replacement while the Regional EBS API is reachable.
- EBS snapshots of these volumes are created in the AWS Region, not on the Outpost.

> [!WARNING]
> During a network disconnect, EBS-backed pods cannot be created, updated, rescheduled, or scaled because volume operations call the Regional EBS API. EBS snapshots also cannot be created or deleted. Existing running pods can continue, but Amazon EBS cannot be the only persistent storage path when disconnected stateful mutations are a requirement.

## Recommendation for prolonged disconnection

| Priority | Storage option | Best fit | Disconnected behavior | Status in this extension |
|---|---|---|---|---|
| 1 | Enterprise storage with a vendor-supported Kubernetes CSI driver, such as NetApp ONTAP with Trident | Enterprise support, dynamic provisioning, snapshots, replication, recovery, and an existing on-premises array | The data path can remain on the local network, subject to the array, CSI driver, routing, DNS, and authentication design | Candidate architecture, not installed or validated by this extension |
| 2 | Replicated software-defined storage, such as Longhorn or OpenEBS | No enterprise array and acceptance of additional node, disk, network, and operational overhead | Uses local disks and cluster networking; behavior depends on replica placement, node survival, rebuild capacity, and local backup targets | Candidate architecture, not installed or validated by this extension |
| 3 | Amazon EBS CSI driver with `platform-ebs-gp2` | Workloads that can remain on existing pods and do not require storage mutations during a disconnect | Existing pods can continue; create, update, reschedule, scale, snapshot creation, and snapshot deletion require Regional APIs | Implemented baseline and complementary storage path |
| Separate | EC2 Local Instance Store CSI Driver | Ephemeral scratch, cache, build workspace, or data that can be recreated | Volume lifecycle is local, but the physical data is lost with the node | Experimental source component only; not validated on an EKS local cluster |

> [!IMPORTANT]
> Instance store for EKS control-plane and etcd instances is not a persistent-storage solution for workloads. It keeps the Kubernetes control plane local during a Service Link interruption, but it does not make Amazon EBS, AWS STS, IRSA, or EKS Pod Identity available and does not create a durable workload StorageClass.

## Prerequisites for an alternative storage path

- Connect the storage system to the local network used by the Outpost and worker nodes.
- Validate VLAN, routing, MTU, DNS, firewall, multipath, and failure-domain behavior end to end. AWS technicians configure the Local Gateway connectivity required by the Outposts third-party block-storage integration.
- Configure the array, volumes, initiator mapping, access policy, encryption, and credentials before relying on the path.
- Confirm the node OS, kernel, transport, Kubernetes version, CSI version, and Outposts hardware are supported by the storage vendor.
- Keep spare compute, disk, and network capacity for pod rescheduling and replica rebuild during a disconnect.
- Use a local backup target when backup or restore must operate without Regional services.
- Establish active support for the array and CSI driver. AWS documents that customers manage the third-party array and contact the vendor for its hardware, software, and connectivity issues.
- Run connected, disconnected, node-loss, replica-rebuild, backup, and restore tests before production use.

## Validation boundary

`smoke-test.yaml` proves only the implemented Amazon EBS path: it writes a sentinel to a 1 GiB volume. `bash ../../../scripts/validate.sh --runtime` checks that the PersistentVolume was provisioned by `ebs.csi.aws.com`, checks that every platform claim is bound to `platform-ebs-gp2`, and removes the test namespace.

An alternative becomes eligible only after the paired controls in [Validation](../../../docs/validation.md#alternative-storage-acceptance) pass on the target rack. A green CSI controller, a Bound PVC, or a vendor support statement is not proof of disconnected behavior.

## Sources

- [Amazon EKS local-cluster network-disconnection preparation](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-network-disconnects.html)
- [Amazon EKS instance-store local-cluster overview](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-instance-store-local-cluster-overview.html)
- [Amazon EKS instance-store disconnection preparation](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-instance-store-network-disconnects.html)
- [Third-party block storage on Outposts racks](https://docs.aws.amazon.com/outposts/latest/userguide/outpost-third-party-block-storage.html)
- [NetApp Trident overview](https://docs.netapp.com/us-en/trident/trident-get-started/intro.html)
- [Longhorn overview](https://longhorn.io/docs/1.10.1/what-is-longhorn/)
- [OpenEBS documentation](https://openebs.io/docs/main/)
