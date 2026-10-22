# Changelog

All notable changes to the Amazon EKS on AWS Outposts Platform Engineering extension are documented here.

## 2026-10-22

- Added equivalent CloudFormation and Terraform infrastructure fronts for Amazon EKS local clusters on AWS Outposts configured with EC2 instance store.
- Added one normalized infrastructure contract consumed by a shared GitOps platform implementation.
- Added local Git, registry, observability, logging, DNS caching, NetworkPolicy, PodDisruptionBudget, Crossplane recipes, and a NetworkPolicy demonstration.
- Added pinned Helm chart versions with fail-closed SHA-256 verification before extraction.
- Added offline validation, runtime paired controls, and scoped cleanup procedures.
- Documented that the public package has not yet completed its hardware validation on an EC2 instance store Outpost.
