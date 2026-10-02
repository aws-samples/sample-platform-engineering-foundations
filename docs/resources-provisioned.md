# Resources provisioned

Complete inventory of what each CloudFormation template creates, so you can review the footprint
before deploying into an account you care about.

Counts are taken from the templates in `infrastructure/cloudformation/`.

---

## `psp-workshop-eks.yaml`

**115 resources across 25 types with the default `Environment=dev`** (121 with `prod`, which adds six
EKS Access Entries). Roughly 20 minutes to deploy.

### Compute and Kubernetes

| Type | Count | Detail |
|---|---|---|
| `AWS::EKS::Cluster` | 3 | `psp-cluster-1-platform`, `psp-cluster-2-cnoe-diy`, `psp-cluster-3-apps`. Kubernetes 1.35, Auto Mode enabled on all three |
| `AWS::EKS::Addon` | 3 | One per cluster |
| `AWS::EKS::AccessEntry` | 0 (6 with `prod`) | Only for the roles of an AWS-hosted event account. The IDE stack creates its own |
| `AWS::EKS::PodIdentityAssociation` | 7 | Portal, External Secrets, the CNOE Crossplane, External Secrets and External DNS, and the optional Tofu Controller and KubeVela Terraform controller |

No `AWS::EKS::Nodegroup` and no launch templates. Compute comes from the Auto Mode `general-purpose`
and `system` node pools.

### Networking

| Type | Count | Detail |
|---|---|---|
| `AWS::EC2::VPC` | 3 | 10.0.0.0/16, 10.1.0.0/16, 10.2.0.0/16 |
| `AWS::EC2::Subnet` | 12 | Two public and two private per VPC, across two AZs |
| `AWS::EC2::RouteTable` | 6 | |
| `AWS::EC2::Route` | 13 | Includes the peering routes, plus one from VPC 1 public subnets to VPC 2 |
| `AWS::EC2::SubnetRouteTableAssociation` | 12 | |
| `AWS::EC2::VPCPeeringConnection` | 3 | Full mesh |
| `AWS::EC2::InternetGateway` | 3 | |
| `AWS::EC2::VPCGatewayAttachment` | 3 | |
| `AWS::EC2::NatGateway` | 3 | One per VPC |
| `AWS::EC2::EIP` | 3 | Attached to the NAT Gateways |
| `AWS::EC2::SecurityGroup` | 3 | One per load balancer |
| `AWS::EC2::SecurityGroupIngress` | 1 | |

### Backstage supporting infrastructure

| Type | Count | Detail |
|---|---|---|
| `AWS::ECR::Repository` | 1 | Portal container image |
| `AWS::CodeBuild::Project` | 1 | Builds the image |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | 3 | Portal (VPC 1), shared ingress (VPC 1), CNOE ingress (VPC 2) |
| `AWS::ElasticLoadBalancingV2::TargetGroup` | 3 | Bound from inside the clusters via `TargetGroupBinding` |
| `AWS::ElasticLoadBalancingV2::Listener` | 3 | HTTP. The CNOE HTTPS listener is added by the IDE bootstrap with a self-signed certificate |
| `AWS::CloudFront::Distribution` | 1 | HTTPS entry point for the portal |

### Supporting

| Type | Count | Detail |
|---|---|---|
| `AWS::IAM::Role` | 12 | Cluster roles, node role, Lambda execution, CodeBuild, Pod Identity roles |
| `AWS::Lambda::Function` | 3 | Custom resource handlers: image build trigger, Bedrock pre-warm, model validator |
| `AWS::CloudFormation::CustomResource` | 3 | Steps CloudFormation cannot express natively |
| `AWS::SSM::Parameter` | 7 | Publishes VPC, subnet, and cluster identifiers for the IDE stacks |

No `AWS::Logs::LogGroup` on purpose. The custom resource Lambdas also run during stack deletion, so
an explicit log group would be recreated by the runtime after CloudFormation deleted it, and the next
deploy in the same account would fail on a name that already exists.
[docs/cleanup.md](cleanup.md) removes these log groups.

### Parameters

| Name | Default | Notes |
|---|---|---|
| `WorkshopName` | `psp` | Prefix for resource names and SSM parameter paths. Must match across all stacks |
| `Environment` | `dev` | `dev` or `prod`. **Keep `dev` in your own account**, see below |
| `WorkshopAssetsBucket` | *(none)* | **Required.** Bucket holding supporting assets |
| `AssetsBucketPrefix` | `""` | Key prefix within that bucket. Empty for a self-paced deploy |
| `BedrockModelId` | Claude Haiku inference profile | Model for the Backstage GenAI plugin |

> **`Environment=prod` only works in an AWS-hosted event account.** It adds six EKS Access Entries
> for `WSParticipantRole` and `WSOpsRole`, roles that do not exist anywhere else, so in your own
> account the stack rolls back. Everything else, including the Bedrock model validator, is created
> in both environments.

### Outputs (21)

| Output | Use |
|---|---|
| `Cluster1Name`, `Cluster1Endpoint` | Platform cluster |
| `Cluster2Name`, `Cluster2Endpoint` | CNOE cluster |
| `Cluster3Name`, `Cluster3Endpoint` | Apps cluster |
| `VPC1Id`, `VPC2Id`, `VPC3Id` | |
| `PublicSubnet1AId`, `PublicSubnet1BId` | Consumed by the IDE stacks |
| `IngressDNS` | DNS name of the shared ingress ALB in VPC 1 |
| `CnoeIngressDNS` | DNS name of the CNOE ALB in VPC 2. The domain for the CNOE installation |
| `IngressGroupName` | Ingress group for the shared load balancer |
| `BackstagePortalUrl` | Portal URL over HTTPS, live before the lab starts |
| `BackstageECRRepositoryUri` | Image destination |
| `BackstageTargetGroupArn` | For `TargetGroupBinding` |
| `BackstageManifestS3Uri` | Kubernetes manifest for the portal, including the GenAI plugin phase |
| `BackstageCodeBuildProjectName` | |
| `CrossplaneProviderRoleArn` | Assumed through Pod Identity |
| `NextSteps` | Post-deploy instructions |

---

## `psp-workshop-code-editor.yaml`

**19 resources across 14 types.** The recommended IDE.

| Type | Count | Detail |
|---|---|---|
| `AWS::EC2::Instance` | 1 | `t3.medium`, Amazon Linux 2023 x86_64, 60 GB gp3 encrypted, deleted on termination |
| `AWS::EC2::SecurityGroup` | 1 | |
| `AWS::IAM::Role` | 3 | Instance role and two Lambda roles |
| `AWS::IAM::InstanceProfile` | 1 | |
| `AWS::EKS::AccessEntry` | 3 | Access to all three clusters |
| `AWS::SSM::Document` | 1 | Provisions code-server 4.131.0 |
| `AWS::SSM::Association` | 1 | Applies the document through State Manager |
| `AWS::SSM::Parameter` | 1 | IDE password reference |
| `AWS::S3::Bucket` | 1 | SSM command output |
| `AWS::Lambda::Function` | 2 | Token generation and output bucket cleanup |
| `Custom::IdeToken` | 1 | Produces the pre-authenticated URL and the origin secret |
| `Custom::BucketCleanup` | 1 | Empties the SSM output bucket on delete |
| `AWS::CloudFront::Function` | 1 | Injects the token |
| `AWS::CloudFront::Distribution` | 1 | HTTPS entry point |

Setup runs through SSM State Manager rather than user data, so a failed bootstrap can be retried
without replacing the instance. The same document seeds `~/environment` from the assets bucket:
`ack`, `kro` and `crossplane` (the stack fails if any of them comes back empty) and, for module 4,
`legacy-iac` and `ack-adoption-transformation` (never fatal).

| Parameter | Default | Notes |
|---|---|---|
| `WorkshopAssetsBucket` | `""` | The same bucket you passed to `psp-workshop-eks`. Empty skips all seeding |
| `AssetsBucketPrefix` | `""` | Empty for a self-paced deploy |

**Outputs:** `IdeUrl` (open this), `IdeDomain`, `VSCodeEC2Id` (for Session Manager troubleshooting),
`SetupInstructions`.

The instance is launched in a **public** subnet and reached through CloudFront. Its security group
accepts only the CloudFront origin-facing prefix list, nginx on port 8080 rejects any request without
the distribution-specific origin header, and code-server listens on loopback only.

---

## Region considerations

`us-east-1` is the tested region. Before deploying elsewhere, review:

- The AL2023 AMI is resolved from a public SSM parameter path, which works in any region
- CloudFront and ACM certificate handling assumes `us-east-1`
- Amazon Bedrock model availability for the `BedrockModelId` you pass
- AWS Transform custom, used by `automation/iac-to-ack-atx-custom`, is not available in
  `sa-east-1`. See [automation/README.md](../automation/README.md)
