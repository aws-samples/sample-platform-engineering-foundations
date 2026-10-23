# CloudFormation entry point

This front deploys the infrastructure of the Platform Engineering demo on Amazon EKS local clusters on AWS Outposts: the network, the local cluster, self-managed worker nodes with an Amazon EBS gp2 root volume and the `AmazonEBSCSIDriverPolicy` on the node role, and the Crossplane Pod Identity role. It declares no Amazon EKS add-on; the shared bootstrap installs the Amazon EBS CSI driver and the other add-ons.

1. Copy `parameters.example.json` to a file outside Git and replace every angle-bracket value.
2. Run `bash deploy.sh /path/to/parameters.json` while connected.
3. Wait for worker nodes to become `Ready`.
4. Continue with `bash ../../platform/gitops/bootstrap.sh ../../platform-contract.json`.

The CloudFormation deploy entry point writes the same normalized contract as the Terraform front. Cleanup is handled by `bash ../../scripts/cleanup.sh cloudformation /path/to/parameters.json`.
