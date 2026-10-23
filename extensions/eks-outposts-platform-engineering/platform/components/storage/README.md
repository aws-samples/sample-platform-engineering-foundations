# Amazon EBS storage

Platform PersistentVolumeClaims use `platform-ebs-gp2`, a StorageClass served by the Amazon EBS CSI driver (`ebs.csi.aws.com`) with `type: gp2`. The shape follows the Amazon EKS guidance for local clusters on AWS Outposts: [Amazon EBS on Outposts supports gp2 volumes only](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-local-cluster-create.html), and [self-managed nodes on Outposts need the EBS CSI driver and a gp2 storage class](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-self-managed-nodes.html).

- The shared bootstrap installs the `aws-ebs-csi-driver` EKS add-on at a pinned version. Neither infrastructure front declares it.
- The driver authenticates with the worker node instance profile. Both fronts attach `AmazonEBSCSIDriverPolicy` to the node role, and the `ebs-csi-controller` NetworkPolicy opens only the instance metadata endpoint on port 80 for that credential.
- The class is not the cluster default. Every platform chart names it explicitly, so a second default class cannot capture a platform volume.
- Volumes stay on the Outpost and survive pod rescheduling and node replacement. [During a network disconnect, EBS-backed pods cannot be created, updated, or scaled](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-network-disconnects.html), because volume operations call the regional EBS API.
- EBS snapshots of these volumes are created in the AWS Region, not on the Outpost.

`smoke-test.yaml` writes a sentinel to a 1 GiB volume. `bash ../../../scripts/validate.sh --runtime` applies it, checks that the PersistentVolume was provisioned by `ebs.csi.aws.com`, checks that every platform claim is bound to `platform-ebs-gp2`, and removes the test namespace.
