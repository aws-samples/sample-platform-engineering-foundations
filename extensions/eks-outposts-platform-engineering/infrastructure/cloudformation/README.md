# CloudFormation entry point

This front deploys the network, Amazon EKS local clusters on AWS Outposts configured with EC2 instance store, self-managed worker nodes, and the Crossplane Pod Identity role.

1. Copy `parameters.example.json` to a file outside Git and replace every angle-bracket value.
2. Run `bash deploy.sh /path/to/parameters.json` while connected.
3. Wait for worker nodes to become `Ready`.
4. Continue with `bash ../../platform/gitops/bootstrap.sh ../../platform-contract.json`.

The CloudFormation deploy entry point writes the same normalized contract as the Terraform front. Cleanup is handled by `bash ../../scripts/cleanup.sh cloudformation /path/to/parameters.json`.
