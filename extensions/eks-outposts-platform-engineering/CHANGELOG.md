# Changelog

All notable changes to the Platform Engineering demo on Amazon EKS local clusters on AWS Outposts are documented here.

## 2026-10-31

- Added the local Retail Store under `platform/apps/retail-store`: storefront and cart of the AWS Retail Store sample application v1.6.3 with DynamoDB Local and a table initializer sidecar, images from the local Harbor by digest, no egress outside the namespace, `ClusterIP` Services only, and an ApplicationSet generator gated by the `enable_retail_store` cluster Secret label.
- Added the egress cut under `platform/components/chaos-egress`: a time-boxed Chaos Mesh 2.8.7 `NetworkChaos` partition towards the Region and the Internet, `cut` and `control` probes that publish `platform_probe_*` series, an atomic JSON report, automatic recovery and rollback, a pinned chart verified by SHA-256 before install, and an 8-minute scene enforced by `--choreography`.
- Added the Grafana dashboard **Platform connectivity during disconnection**, applied by the new `platform-dashboards` ApplicationSet element, and its single source of queries in `platform/components/observability/connectivity/queries.yaml` with the generated `QUERIES.md`.
- Added the serverless multi-tier Crossplane recipe (`XServerlessMultiTier` and four composed XRs) and the lambda, apigateway, cloudfront and cloudwatchlogs providers from the local Harbor. The recipe runs after the egress recovery.
- The serverless REST API has no authorizer, and the Crossplane README states it as a risk accepted in this sample, with the production replacement. The offline serverless test now requires stage throttling on `*/*` at no more than 10 requests per second and burst 20, with one new mutation control (24 in total).
- Both IaC fronts add one Pod Identity role and association per serverless provider, the shared function runtime role and the CloudFront origin access control, with the outputs `ServerlessRuntimeRoleArn` and `ServerlessOacId` (CloudFormation) and `serverless_runtime_role_arn` and `serverless_oac_id` (Terraform). No provider can create an IAM identity.
- The parity gate checks the serverless identity in both fronts and its least-privilege rules, with eighteen new mutation controls (36 in total). The CloudFormation check of the original Crossplane role now selects it by logical ID.
- The parity gate keeps a closed identity inventory of both fronts: any IAM, Pod Identity, access entry or origin access control resource outside the reviewed list fails, and so does any managed policy or permissions boundary on the Crossplane roles. Both fronts refuse a Crossplane cluster name longer than 38 characters.
- The Chaos Mesh dashboard Service is `ClusterIP`; `check-chart` refuses `NodePort` and `LoadBalancer` Services, and the offline tests check the real values file and the chart pin.
- `bash scripts/validate.sh` also fails on accented Latin letters and on non-English prose without accents inside the extension, on any sentence that claims a successful run on real clusters, racks or hardware, and on Markdown links to missing headings.
- Added `python3 scripts/check-reachability.py`, which proves that every committed file is reachable from the README and that no two files have the same content, and wired every new suite into `bash scripts/validate.sh`.
- Documented the omitted source features: the shared load balancer address for the Retail Store and the Backstage golden paths.

## 2026-10-24

- Scoped the architecture diagram to short Service Link disconnections: the Amazon EBS gp2 data plane on the Outpost now carries a short-disconnections-only marker, because re-replication needs the Amazon EBS control plane in the Region.
- Added Figure 2, which compares the implemented EBS-backed Outpost for short disconnections with the instance-store Outpost for prolonged disconnections that this extension does not implement. Status uses words and glyphs, and the not-implemented column uses a dashed border. Both figures pass the five `aws-architecture-diagram` geometry gates.

## 2026-10-23

- Added the editable AWS architecture diagram and embedded-source PNG to the extension landing page and architecture document. The Blog Figure mirrors the official EKS local-cluster boundary, adds the local platform and Regional lifecycle dependencies, and passes the five `aws-architecture-diagram` geometry gates.
- Added the landing-page document information block with author, role, team, scope, status, last-updated date, and maintainer contact.

- Renamed the extension to the Platform Engineering demo on Amazon EKS local clusters on AWS Outposts, in the README, both IaC fronts, the docs, and the root README Related Demo reference.
- Replaced the EC2 instance store storage path with Amazon EBS gp2 through the Amazon EBS CSI driver. Removed the instance store CSI add-on, its StorageClass, smoke test, and node preflight.
- The shared bootstrap now installs the pinned `aws-ebs-csi-driver` add-on (`EBS_CSI_ADDON_VERSION` replaces `INSTANCE_STORE_CSI_VERSION`) and applies the `platform-ebs-gp2` StorageClass. Every platform chart, including the Harbor job log volume, names that class.
- Both fronts attach `AmazonEBSCSIDriverPolicy` to the node role. The Terraform example now sets `node_attach_ebs_csi_policy = true`, and the Terraform add-on module no longer declares the EBS CSI driver: `enable_ebs_csi_driver` and the `aws-ebs-csi-driver` keys of `addon_versions` and `core_addon_configuration_values` were removed.
- `ebs_csi_controller_credential_cidr` is now `169.254.169.254/32`, the instance metadata endpoint of the node instance profile credential.
- The runtime validation checks an EBS-backed smoke volume and the class and binding of every platform claim. Cleanup records and deletes the EBS volumes provisioned through the platform class after the infrastructure is removed.
- The parity gate checks EBS CSI ownership and bootstrap order, the node policy wiring in both fronts, the controller credential endpoint and its NetworkPolicy rule, the StorageClass, and values references, each with a mutation control. `bash scripts/validate.sh` renders the fetched charts and requires every claim to use the platform class.
- Upgrading an existing Terraform state: the add-on module no longer manages the EBS CSI driver. Run `terraform state rm 'module.addons.aws_eks_addon.ebs_csi_driver[0]'` before the next apply so Terraform does not delete the add-on, then run the shared bootstrap, which adopts it.
- Documented the hardware boundary of the source implementation and the documented EBS limits during a network disconnect.
- Expanded the disconnected-storage guidance into the established recommendation pattern: ordered enterprise CSI, replicated open-source and complementary EBS options; explicit prerequisites and validation status; the control-plane instance-store versus workload-storage boundary; inline sources; and command-based paired acceptance criteria across the README, architecture, storage, and validation documents.

## 2026-10-22

- Added a deterministic CloudFormation and Terraform parity gate for all 12 normalized contract keys, both entry points, the shared bootstrap handoff, and the Crossplane Pod Identity boundary.
- Added six mutation controls that prove the gate detects contract, identity, permission, VPC CNI ownership, and entry-point drift.

- Added equivalent CloudFormation and Terraform infrastructure fronts for Amazon EKS local clusters on AWS Outposts configured with EC2 instance store.
- Added one normalized infrastructure contract consumed by a shared GitOps platform implementation.
- Added local Git, registry, observability, logging, DNS caching, NetworkPolicy, PodDisruptionBudget, Crossplane recipes, and a NetworkPolicy demonstration.
- Added pinned Helm chart versions with fail-closed SHA-256 verification before extraction.
- Added offline validation, runtime paired controls, and scoped cleanup procedures.
- Documented that the public package has not yet completed its hardware validation on an EC2 instance store Outpost.
