# Terraform entry point

This front composes the network, cluster, node, add-on, and identity modules of the Platform Engineering demo on Amazon EKS local clusters on AWS Outposts. Worker nodes use an Amazon EBS gp2 root volume, and `node_attach_ebs_csi_policy = true` attaches `AmazonEBSCSIDriverPolicy` to the node role, matching the CloudFormation front. The add-on module does not declare the Amazon EBS CSI driver; the shared bootstrap owns it.

1. Copy `terraform.tfvars.example` to `terraform.tfvars` and replace every angle-bracket value.
2. Run `terraform init`, `terraform validate`, review `terraform plan`, then run `terraform apply` while connected.
3. Run `python3 ../../scripts/emit-contract.py terraform --directory . > ../../platform-contract.json`.
4. Continue with `bash ../../platform/gitops/bootstrap.sh ../../platform-contract.json`.

Choose this front or CloudFormation, never both for the same environment. Cleanup is handled by `bash ../../scripts/cleanup.sh terraform .`.
