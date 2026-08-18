# Architecture

Why the environment looks the way it does, and what runs where.

## The problem the topology solves

A single cluster running platform tooling and application workloads together is the fastest way to
start and the fastest way to create problems. Platform controllers hold broad IAM permissions and
cluster-scoped CRDs. Workloads are deployed continuously by teams who should not be able to affect
those controllers. Blast radius and permission boundaries end up entangled.

This environment separates the two, and adds a third cluster so you can compare two approaches to
building the same platform side by side.

| Cluster | VPC | Role |
|---|---|---|
| `psp-cluster-1-platform` | VPC 1, 10.0.0.0/16 | Platform control plane. EKS Capabilities (Argo CD, kro, ACK), Crossplane, Backstage portal |
| `psp-cluster-2-cnoe-diy` | VPC 2, 10.1.0.0/16 | The CNOE reference implementation, assembled from open source components |
| `psp-cluster-3-apps` | VPC 3, 10.2.0.0/16 | Workload cluster. Receives applications and infrastructure provisioned through the platform APIs |

Cluster 1 and cluster 2 are deliberately two answers to the same question. Cluster 1 uses managed
EKS Capabilities, where AWS operates the controllers. Cluster 2 uses the CNOE stack, where you
operate everything. Running both makes the trade-off concrete instead of theoretical: what you gain
in control, what you pay in operational surface.

Cluster 3 exists so that provisioning targets a genuinely remote cluster. A platform that can only
deploy to itself teaches the wrong lesson about cross-cluster identity and networking.

## Networking

One VPC per cluster, peered in a full mesh.

```
  VPC 1  10.0.0.0/16 ─────────── VPC 2  10.1.0.0/16
        │  ╲                        ╱  │
        │    ╲                    ╱    │
        │      ╲                ╱      │
        │        VPC 3  10.2.0.0/16    │
        └──────────────────────────────┘
```

Each VPC contains:

- Two public subnets (`x.x.1.0/24`, `x.x.2.0/24`) across two Availability Zones
- Two private subnets (`x.x.11.0/24`, `x.x.12.0/24`) across the same zones
- An Internet Gateway
- A single NAT Gateway with an Elastic IP
- Six route tables, with peering routes added for both peers

Non-overlapping CIDRs are what make the mesh possible. Peering does not support overlapping ranges,
and this is the most common reason a real multi-cluster design cannot be peered later. Choosing
distinct ranges up front costs nothing.

The single NAT Gateway per VPC is a cost choice, not a resilience recommendation. A production
design places one NAT Gateway per Availability Zone so that losing a zone does not remove egress for
the remaining one.

## EKS Auto Mode

All three clusters run Kubernetes 1.35 with Auto Mode enabled. There are no managed node groups and
no launch templates anywhere in the environment.

| Auto Mode capability | Configuration |
|---|---|
| Compute | `general-purpose` and `system` node pools |
| Load balancing | Enabled through `KubernetesNetworkConfig.ElasticLoadBalancing` |
| Block storage | Enabled through `StorageConfig.BlockStorage` |

What this changes in practice: nodes appear when a pod cannot be scheduled and disappear when they
are no longer needed, without you managing node groups, AMIs, or the lifecycle controllers that
normally handle this. Load balancer and CSI controllers are operated by AWS rather than installed as
add-ons.

The `system` node pool is reserved for cluster-critical workloads. Application pods land on
`general-purpose` unless you say otherwise. When you write a `NodePool` of your own, the
`nodeClassRef` and the taints you set determine which workloads it accepts.

Access is configured with `API_AND_CONFIG_MAP` and cluster creator admin permissions bootstrapped.
Six `EKS::AccessEntry` resources grant the IDE instance and the platform roles access across
clusters, which is why the browser IDE can talk to all three without you configuring kubeconfig by
hand.

## The Backstage supporting stack

The developer portal needs infrastructure that exists before any Kubernetes manifest is applied, so
the main stack provisions it:

| Resource | Purpose |
|---|---|
| ECR repository | Holds the Backstage container image |
| CodeBuild project | Builds the image |
| Application Load Balancer plus target group | Ingress for the portal |
| CloudFront distribution | HTTPS entry point, so the portal has a working URL before the lab starts |
| `EKS::PodIdentityAssociation` (2) | Identity for Crossplane and portal workloads |
| SSM parameters (7) | Publishes VPC, subnet, and cluster identifiers for the IDE stacks to consume |

The `BackstageTargetGroupArn` output is used with a `TargetGroupBinding`, which is how a pod running
in the cluster gets registered behind a load balancer that CloudFormation created. That inverts the
usual order, where an ingress creates the load balancer.

The portal's GenAI plugin calls Amazon Bedrock. The model is a stack parameter
(`BedrockModelId`), defaulting to a Claude Haiku inference profile. Model access must be enabled in
the account for that plugin section to work.

## Stack dependencies

```
psp-workshop-eks
      │
      │  publishes 7 SSM parameters:
      │  /workshop/<name>/vpc-1-id, /workshop/<name>/public-subnet-1a, ...
      ▼
psp-workshop-code-editor
```

The IDE stack declares those SSM parameters as its parameter defaults, so they resolve
automatically as long as the main stack deployed first and used the same `WorkshopName`. Change
`WorkshopName` on one stack and not the other and the IDE stack will fail to resolve its network
parameters.

## Progression through the labs

The three labs are the same application built at three levels of abstraction, which is the point.

```
ACK           11 manifests, one per AWS resource, ordering is yours to manage
   │
   ▼
kro           1 ResourceGroup authored once, 1 instance manifest consumed by developers
   │
   ▼
Crossplane    A versioned catalog of compositions, surfaced as Backstage templates
```

Moving down the list, the developer sees less and the platform team owns more. That trade is the
central decision in platform engineering: every abstraction you add removes a choice from your
users, and each removal must buy them something real.
