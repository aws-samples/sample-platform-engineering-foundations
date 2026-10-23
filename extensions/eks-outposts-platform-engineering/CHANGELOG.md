# Changelog

All notable changes to the Platform Engineering demo on Amazon EKS local clusters on AWS Outposts are documented here.

## 2026-10-23

- Renamed the extension to the Platform Engineering demo on Amazon EKS local clusters on AWS Outposts, in the README, both IaC fronts, the docs, and the root README Related Demo reference.
- Replaced the EC2 instance store storage path with Amazon EBS gp2 through the Amazon EBS CSI driver. Removed the instance store CSI add-on, its StorageClass, smoke test, and node preflight.
- The shared bootstrap now installs the pinned `aws-ebs-csi-driver` add-on (`EBS_CSI_ADDON_VERSION` replaces `INSTANCE_STORE_CSI_VERSION`) and applies the `platform-ebs-gp2` StorageClass. Every platform chart, including the Harbor job log volume, names that class.
- Both fronts attach `AmazonEBSCSIDriverPolicy` to the node role. The Terraform example now sets `node_attach_ebs_csi_policy = true`, and the Terraform add-on module no longer declares the EBS CSI driver: `enable_ebs_csi_driver` and the `aws-ebs-csi-driver` keys of `addon_versions` and `core_addon_configuration_values` were removed.
- `ebs_csi_controller_credential_cidr` is now `169.254.169.254/32`, the instance metadata endpoint of the node instance profile credential.
- The runtime validation checks an EBS-backed smoke volume and the class and binding of every platform claim. Cleanup records and deletes the EBS volumes provisioned through the platform class after the infrastructure is removed.
- The parity gate checks EBS CSI ownership and bootstrap order, the node policy wiring in both fronts, the controller credential endpoint and its NetworkPolicy rule, the StorageClass, and values references, each with a mutation control. `bash scripts/validate.sh` renders the fetched charts and requires every claim to use the platform class.
- Upgrading an existing Terraform state: the add-on module no longer manages the EBS CSI driver. Run `terraform state rm 'module.addons.aws_eks_addon.ebs_csi_driver[0]'` before the next apply so Terraform does not delete the add-on, then run the shared bootstrap, which adopts it.
- Documented the hardware boundary of the source implementation and the documented EBS limits during a network disconnect.
- Added the official instance-store local-cluster path immediately after the EBS limitation: the local control plane keeps applications and cluster operations available during disconnection when local dependencies are prepared, while Region-backed EBS, IRSA, and Pod Identity constraints remain explicit.

## 2026-10-22

- Added a deterministic CloudFormation and Terraform parity gate for all 12 normalized contract keys, both entry points, the shared bootstrap handoff, and the Crossplane Pod Identity boundary.
- Added six mutation controls that prove the gate detects contract, identity, permission, VPC CNI ownership, and entry-point drift.

- Added equivalent CloudFormation and Terraform infrastructure fronts for Amazon EKS local clusters on AWS Outposts configured with EC2 instance store.
- Added one normalized infrastructure contract consumed by a shared GitOps platform implementation.
- Added local Git, registry, observability, logging, DNS caching, NetworkPolicy, PodDisruptionBudget, Crossplane recipes, and a NetworkPolicy demonstration.
- Added pinned Helm chart versions with fail-closed SHA-256 verification before extraction.
- Added offline validation, runtime paired controls, and scoped cleanup procedures.
- Documented that the public package has not yet completed its hardware validation on an EC2 instance store Outpost.
