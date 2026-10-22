# Terraform entry point

This front composes the verified network, cluster, node, add-on, and identity modules for Amazon EKS local clusters on AWS Outposts configured with EC2 instance store.

1. Copy `terraform.tfvars.example` to `terraform.tfvars` and replace every angle-bracket value.
2. Run `terraform init`, `terraform validate`, review `terraform plan`, then run `terraform apply` while connected.
3. Run `python3 ../../scripts/emit-contract.py terraform --directory . > ../../platform-contract.json`.
4. Continue with `bash ../../platform/gitops/bootstrap.sh ../../platform-contract.json`.

Choose this front or CloudFormation, never both for the same environment. Cleanup is handled by `bash ../../scripts/cleanup.sh terraform .`.
