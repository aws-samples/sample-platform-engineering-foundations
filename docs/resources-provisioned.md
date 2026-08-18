# Resources provisioned

Complete inventory of what each CloudFormation template creates, so you can review the footprint
before deploying into an account you care about.

Counts are taken from the templates in `infrastructure/cloudformation/`.

---

## `psp-workshop-eks.yaml`

**98 resources across 27 types.** Roughly 20 minutes to deploy.

### Compute and Kubernetes

| Type | Count | Detail |
|---|---|---|
| `AWS::EKS::Cluster` | 3 | `psp-cluster-1-platform`, `psp-cluster-2-cnoe-diy`, `psp-cluster-3-apps`. Kubernetes 1.35, Auto Mode enabled on all three |
| `AWS::EKS::Addon` | 3 | One per cluster |
| `AWS::EKS::AccessEntry` | 6 | Cross-cluster access for the IDE and platform roles |
| `AWS::EKS::PodIdentityAssociation` | 2 | Crossplane provider and portal workloads |

No `AWS::EKS::Nodegroup` and no launch templates. Compute comes from the Auto Mode `general-purpose`
and `system` node pools.

### Networking

| Type | Count | Detail |
|---|---|---|
| `AWS::EC2::VPC` | 3 | 10.0.0.0/16, 10.1.0.0/16, 10.2.0.0/16 |
| `AWS::EC2::Subnet` | 12 | Two public and two private per VPC, across two AZs |
| `AWS::EC2::RouteTable` | 6 | |
| `AWS::EC2::Route` | 12 | Includes six peering routes, two per connection |
| `AWS::EC2::SubnetRouteTableAssociation` | 12 | |
| `AWS::EC2::VPCPeeringConnection` | 3 | Full mesh |
| `AWS::EC2::InternetGateway` | 3 | |
| `AWS::EC2::VPCGatewayAttachment` | 3 | |
| `AWS::EC2::NatGateway` | 3 | One per VPC |
| `AWS::EC2::EIP` | 3 | Attached to the NAT Gateways |
| `AWS::EC2::SecurityGroup` | 2 | |
| `AWS::EC2::SecurityGroupIngress` | 1 | |

### Backstage supporting infrastructure

| Type | Count | Detail |
|---|---|---|
| `AWS::ECR::Repository` | 1 | Portal container image |
| `AWS::CodeBuild::Project` | 1 | Builds the image |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | 2 | |
| `AWS::ElasticLoadBalancingV2::TargetGroup` | 2 | One is bound from inside the cluster via `TargetGroupBinding` |
| `AWS::ElasticLoadBalancingV2::Listener` | 2 | |
| `AWS::CloudFront::Distribution` | 1 | HTTPS entry point for the portal |

### Supporting

| Type | Count | Detail |
|---|---|---|
| `AWS::IAM::Role` | 10 | Cluster roles, node role, Lambda execution, CodeBuild, Crossplane provider |
| `AWS::Lambda::Function` | 5 | Custom resource handlers |
| `AWS::CloudFormation::CustomResource` | 5 | Steps CloudFormation cannot express natively |
| `AWS::SSM::Parameter` | 7 | Publishes VPC, subnet, and cluster identifiers for the IDE stacks |
| `AWS::Logs::LogGroup` | 4 | |

### Parameters

| Name | Default | Notes |
|---|---|---|
| `WorkshopName` | `psp` | Prefix for resource names and SSM parameter paths. Must match across all stacks |
| `Environment` | `dev` | `dev` or `prod`. **Use `prod`**, see below |
| `WorkshopAssetsBucket` | *(none)* | **Required.** Bucket holding supporting assets |
| `AssetsBucketPrefix` | `""` | Key prefix within that bucket |
| `GitHubRepoUrl` | `https://github.com/cnoe-io/reference-implementation-aws` | CNOE reference implementation source |
| `BedrockModelId` | Claude Haiku inference profile | Model for the Backstage GenAI plugin |

> **`Environment=dev` creates two extra Lambda functions** that apply resource-lifecycle tags. They
> exist for internal AWS test accounts and have no purpose in a customer account. Deploy with
> `Environment=prod` to skip them.

### Outputs (21)

| Output | Use |
|---|---|
| `Cluster1Name`, `Cluster1Endpoint` | Platform cluster |
| `Cluster2Name`, `Cluster2Endpoint` | CNOE cluster |
| `Cluster3Name`, `Cluster3Endpoint` | Apps cluster |
| `VPC1Id`, `VPC2Id`, `VPC3Id` | |
| `PublicSubnet1AId`, `PublicSubnet1BId` | Consumed by the IDE stacks |
| `IngressDNS` | ALB DNS name. Used as `INGRESS_DNS` during the CNOE installation |
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

**15 resources across 13 types.** The recommended IDE.

| Type | Count | Detail |
|---|---|---|
| `AWS::EC2::Instance` | 1 | `t3.medium`, Amazon Linux 2023 x86_64, 60 GB gp3 encrypted, deleted on termination |
| `AWS::EC2::SecurityGroup` | 1 | |
| `AWS::IAM::Role` | 2 | Instance role and Lambda role |
| `AWS::IAM::InstanceProfile` | 1 | |
| `AWS::EKS::AccessEntry` | 3 | Access to all three clusters |
| `AWS::SSM::Document` | 1 | Provisions code-server 4.131.0 |
| `AWS::SSM::Association` | 1 | Applies the document through State Manager |
| `AWS::SSM::Parameter` | 1 | IDE password reference |
| `AWS::S3::Bucket` | 1 | SSM command output |
| `AWS::Lambda::Function` | 1 | Token generation |
| `Custom::IdeToken` | 1 | Produces the pre-authenticated URL |
| `AWS::CloudFront::Function` | 1 | Injects the token |
| `AWS::CloudFront::Distribution` | 1 | HTTPS entry point |

Setup runs through SSM State Manager rather than user data, so a failed bootstrap can be retried
without replacing the instance.

**Outputs:** `IdeUrl` (open this), `IdeDomain`, `VSCodeEC2Id` (for Session Manager troubleshooting),
`SetupInstructions`.

The instance is launched in a **public** subnet and reached through CloudFront.

---

## Region considerations

`us-east-1` is the tested region. Before deploying elsewhere, review:

- The AL2023 AMI is resolved from a public SSM parameter path, which works in any region
- CloudFront and ACM certificate handling assumes `us-east-1`
- Amazon Bedrock model availability for the `BedrockModelId` you pass
- AWS Transform custom, used by `automation/eks-upgrade-transform`, is not available in
  `sa-east-1`. See [automation/README.md](../automation/README.md)
