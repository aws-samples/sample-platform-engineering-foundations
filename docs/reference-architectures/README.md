# Reference Architectures

Four patterns that the workshop builds piece by piece, drawn on their own so you can reuse them
outside the labs. Each one shows the flow of a single request, numbered in the order it happens,
with a legend that repeats the numbers.

| # | Pattern | Who operates the platform controllers | Exercised in |
|---|---|---|---|
| 1 | [GitOps across clusters with the Argo CD EKS Capability](#1-gitops-across-clusters-with-the-argo-cd-eks-capability) | AWS | Module 2.1 |
| 2 | [Platform APIs with kro and ACK](#2-platform-apis-with-kro-and-ack-as-eks-capabilities) | AWS | Modules 2.2 and 2.3 |
| 3 | [Crossplane compositions](#3-crossplane-compositions-on-amazon-eks-self-managed) | You | Modules 2.4 and 3.4 |
| 4 | [Internal developer portal with the CNOE stack](#4-internal-developer-portal-with-the-cnoe-stack-on-eks-auto-mode) | You | Module 3 |

Patterns 1 and 2 use managed EKS Capabilities, where the controllers run in AWS and not on your
worker nodes. Patterns 3 and 4 install the same kind of controllers as pods that you operate. The
workshop runs both models side by side on purpose, so you can compare them on real clusters.

Every figure has its editable `.drawio` source next to the PNG, and each PNG embeds its diagram XML,
so you can also open the image directly in draw.io. To re-export after an edit:

```bash
/Applications/draw.io.app/Contents/MacOS/draw.io -x -f png -e -b 10 -s 2 \
  -o docs/reference-architectures/01-gitops-multicluster-argocd.png \
  docs/reference-architectures/01-gitops-multicluster-argocd.drawio
```

The constraints these figures follow (800 px effective width, no meaning carried by colour alone,
numbered steps inside the labels) are described in [../diagrams/README.md](../diagrams/README.md).

## 1. GitOps across clusters with the Argo CD EKS Capability

![Hub and spoke GitOps. A platform team commits to a Git repository. On the hub EKS cluster, Argo CD runs as an EKS Capability in AWS, with a capability IAM role, and reads cluster Secrets and an ApplicationSet in the argocd namespace. Thick arrows fan out from Argo CD to three spoke clusters, dev in the same account, staging in another account and prod in another Region with a private endpoint, each entering through an EKS access entry for the capability role and landing on Deployments and Services.](01-gitops-multicluster-argocd.png)

*Figure 1: One Argo CD capability on a hub cluster deploys to spoke clusters registered by EKS
cluster ARN.*

1. The platform team commits Applications, ApplicationSets and manifests to Git, the source of truth.
2. Argo CD runs as an EKS Capability on the hub cluster. AWS operates, scales and upgrades it, and users sign in through IAM Identity Center.
3. Each spoke is registered as a cluster Secret on the hub whose `server` field is the spoke's EKS cluster ARN, not a Kubernetes API URL.
4. Each spoke grants the capability IAM role an EKS access entry. Cross-account access works the same way, with no IRSA and no role chaining.
5. Argo CD applies the desired state to every spoke, including clusters with private endpoints, without VPC peering or a transit gateway.

**In the workshop:** Module 2.1 registers the platform cluster itself by ARN, as `in-cluster`.
Adding a spoke is the same Secret with another ARN, plus an access entry on that spoke.

**Sources:**
[Register target clusters (Amazon EKS User Guide)](https://docs.aws.amazon.com/eks/latest/userguide/argocd-register-clusters.html) ·
[Comparing EKS Capability for Argo CD to self-managed Argo CD](https://docs.aws.amazon.com/eks/latest/userguide/argocd-comparison.html) ·
[Deep dive: Streamlining GitOps with Amazon EKS capability for Argo CD (AWS Containers Blog)](https://aws.amazon.com/blogs/containers/deep-dive-streamlining-gitops-with-amazon-eks-capability-for-argo-cd/)

## 2. Platform APIs with kro and ACK as EKS Capabilities

![Platform API with kro and ACK. Inside an EKS cluster, a dashed box marks the EKS Capabilities that run in AWS: kro and ACK. A platform team applies a ResourceGraphDefinition, which kro turns into a WebApp API. A developer applies a short WebApp instance. kro creates four ACK custom resources, a Bucket, a DBInstance, a Function and an API with route and stage, and ACK reconciles each one into Amazon S3, Amazon RDS, AWS Lambda and Amazon API Gateway in the account.](02-platform-apis-kro-ack.png)

*Figure 2: A developer applies one custom resource; kro composes ACK resources and ACK reconciles
them into AWS.*

1. The platform team publishes a ResourceGraphDefinition (RGD): the API schema plus the graph of resources behind it.
2. kro registers a CRD from the RGD, so `WebApp` becomes a native Kubernetes API in the cluster.
3. A developer applies a `WebApp` instance with a few fields. Defaults and guardrails live in the RGD, not in the developer's YAML.
4. kro orders the graph and creates the ACK custom resources, passing outputs such as ARNs from one resource to the next.
5. ACK calls the AWS APIs, creates the resources and corrects drift. Both kro and ACK run in AWS as EKS Capabilities, not on your worker nodes.

**In the workshop:** Module 2.2 applies the eleven ACK manifests of `labs/ack` one by one. Module
2.3 collapses the same application into one kro RGD and a small instance, which is this figure.

**Sources:**
[EKS Capabilities (Amazon EKS User Guide)](https://docs.aws.amazon.com/eks/latest/userguide/capabilities.html) ·
[Resource Composition with kro (Amazon EKS User Guide)](https://docs.aws.amazon.com/eks/latest/userguide/kro.html) ·
[What is kro? (kro.run)](https://kro.run/docs/overview) ·
[AWS Controllers for Kubernetes overview](https://aws-controllers-k8s.github.io/docs/intro/)

## 3. Crossplane compositions on Amazon EKS (self-managed)

![Crossplane composition. Inside an EKS cluster, a grey self-managed box holds the Crossplane core, a pipeline of three composition functions (patch and transform, go templating, auto ready), the AWS provider pods and their IAM role from EKS Pod Identity. Below it, the platform team's XRD and Composition and a developer's AppStack claim sit in the Kubernetes API. Crossplane composes the claim into four managed resources, Bucket, Instance, Function and API, which the provider pods reconcile into Amazon S3, Amazon RDS, AWS Lambda and Amazon API Gateway.](03-crossplane-compositions.png)

*Figure 3: An XRD defines the API, a Composition pipeline of Functions builds it, and AWS providers
reconcile the managed resources. You run all of it.*

1. The platform team publishes an XRD (the API schema) and a Composition (how to build it), often as a versioned package.
2. A developer creates a claim, or a namespaced composite resource in Crossplane v2, with the few fields the XRD exposes.
3. Crossplane runs the Composition pipeline. Each Function adds to the desired state, for example patch and transform, then auto ready.
4. Crossplane applies the result as managed resources, one per AWS resource, and tracks them as one unit.
5. The provider pods call the AWS APIs with credentials from EKS Pod Identity and correct drift.

**Operating model:** Crossplane, every Function and every provider is a pod on your worker nodes.
You choose versions, upgrade them, size them and scope their IAM permissions. That is the trade-off
against pattern 2, where AWS operates the controllers.

**In the workshop:** Module 2.4 installs Crossplane on the platform cluster and builds compositions
from `labs/crossplane`. Module 3.4 uses Crossplane again inside the CNOE stack.

**Sources:**
[Compositions (Crossplane documentation)](https://docs.crossplane.io/latest/composition/compositions/) ·
[Composite Resource Definitions (Crossplane documentation)](https://docs.crossplane.io/latest/composition/composite-resource-definitions/) ·
[GitOps model for provisioning and bootstrapping Amazon EKS clusters using Crossplane and Argo CD (AWS Containers Blog)](https://aws.amazon.com/blogs/containers/gitops-model-for-provisioning-and-bootstrapping-amazon-eks-clusters-using-crossplane-and-argo-cd/)

## 4. Internal developer portal with the CNOE stack on EKS Auto Mode

![Internal developer portal on CNOE. A developer reaches Backstage inside an EKS Auto Mode cluster; Keycloak provides single sign-on. Backstage software templates push a repository to the in-cluster Gitea, and a self-managed Argo CD syncs it into the cluster. What Argo CD applies becomes Deployments and Services, Crossplane claims, kro instances and ACK resources, and those controllers reconcile Amazon S3, Amazon RDS and AWS Secrets Manager in the account. A note says EKS Auto Mode runs the nodes, load balancing and block storage under the pods.](04-idp-cnoe-backstage.png)

*Figure 4: The CNOE stack: Backstage, Keycloak, Gitea, Argo CD and Crossplane, all self-managed, on
an EKS Auto Mode cluster.*

1. The developer signs in to Backstage through Keycloak, which also provides single sign-on for Argo CD.
2. The developer picks a software template. Backstage scaffolds a repository in Gitea with the application and infrastructure manifests.
3. Argo CD, installed and operated by you, syncs that repository into the cluster.
4. Application manifests become Deployments and Services. Infrastructure manifests become Crossplane claims, kro instances or ACK resources.
5. Those controllers create the AWS resources and keep them in sync. EKS Auto Mode runs the nodes, load balancing and block storage underneath.

**In the workshop:** all of Module 3 runs on `psp-cluster-2-cnoe-diy`: the stack overview in 3.1,
GitOps in 3.2, the portal in 3.3, infrastructure as code in 3.4 and service templates in 3.5.

**Sources:**
[CNOE AWS Reference Implementation (cnoe.io)](https://cnoe.io/docs/reference-implementation/aws) ·
[Designing an internal developer platform architecture (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/internal-developer-platform/design-architecture.html) ·
[Automate cluster infrastructure with EKS Auto Mode (Amazon EKS User Guide)](https://docs.aws.amazon.com/eks/latest/userguide/automode.html)

## Attribution

The four figures were authored for this repository with the official AWS architecture icons and
the Kubernetes icon set from the draw.io libraries. Project logos (Argo CD, kro, Crossplane,
Backstage, Keycloak, Gitea, CNOE) are embedded in the `.drawio` files and belong to their projects.
