# Crossplane recipes

Crossplane core 2.4.3 and AWS providers of the `provider-family-aws` v2.9.0 family, all pulled from the local Harbor (`harbor.local`) by digest ([`packages/packages.yaml`](packages/packages.yaml), mirrored by [`../registry/images.txt`](../registry/images.txt)). They back two sets of Regional recipes in [`recipes/`](recipes/):

- `PlatformBucket` and `PlatformTable` (providers s3 and dynamodb), in `xrds.yaml` and `compositions.yaml`;
- the serverless multi-tier recipe, `XServerlessMultiTier` (providers lambda, apigateway, cloudfront and cloudwatchlogs, plus s3 and dynamodb), in `serverless-xrds.yaml` and `serverless-compositions.yaml`. There is no `provider-aws-iam`: no provider credential can create an identity.

`recipes/` must stay flat: the `crossplane-recipes` Application is a directory source without `recurse`, so a file in a subdirectory is silently never applied. `python3 platform/components/crossplane/tests/test-serverless.py` fails on any subdirectory there.

## Identity

Each AWS provider gets a fixed ServiceAccount name through its `DeploymentRuntimeConfig`, and both IaC fronts create one Pod Identity association per ServiceAccount: [`crossplane-identity.yaml`](../../../infrastructure/cloudformation/crossplane-identity.yaml) for CloudFormation and [`crossplane-identity.tf`](../../../infrastructure/terraform/crossplane-identity.tf) with `enable_crossplane_identity = true` for Terraform.

| ServiceAccount | Role | Scope |
|---|---|---|
| `provider-aws-s3`, `provider-aws-dynamodb` | `<cluster>-crossplane-provider-aws` | `s3:*` and `dynamodb:*` on `sample-plat-*` buckets and tables |
| `provider-aws-lambda` | `<cluster>-crossplane-lambda` | the 12 function actions the pinned controller calls on `sample-plat-*` functions (no Function URL, no concurrency); `AddPermission`/`RemovePermission` only with `lambda:Principal=apigateway.amazonaws.com`; read the package from `sample-plat-*` buckets; `iam:PassRole` only of `sample-plat-runtime-<cluster>`, only to `lambda.amazonaws.com` |
| `provider-aws-apigateway` | `<cluster>-crossplane-apigateway` | `POST /restapis` only with `aws:RequestTag/platform=sample-plat`; `DELETE`/`PATCH`/`POST`/`PUT /restapis/*` only with `aws:ResourceTag/platform=sample-plat`; unconditioned reads; tag writes on `/tags/*`, which also need `PATCH` on the tagged API; no `/account`, API keys, usage plans, domains or VPC links |
| `provider-aws-cloudfront` | `<cluster>-crossplane-cloudfront` | `CreateDistribution` only with `aws:RequestTag/platform=sample-plat`; update, delete and tag only with `aws:ResourceTag/platform=sample-plat`; unconditioned reads; no `CreateInvalidation` and no origin access control write |
| `provider-aws-cloudwatchlogs` | `<cluster>-crossplane-cloudwatchlogs` | the 7 log group actions the controller calls on `/aws/lambda/sample-plat-*`; `DescribeLogGroups` on `*` (account-level read without a resource type) |

The same IaC creates the two fixed pieces the serverless recipe consumes:

| Resource | Name | CloudFormation output | Terraform output |
|---|---|---|---|
| Function runtime role (trust exactly `lambda.amazonaws.com`; item actions on `sample-plat-*` tables and indexes; log writes to `/aws/lambda/sample-plat-*`) | `sample-plat-runtime-<cluster>` | `ServerlessRuntimeRoleArn` | `serverless_runtime_role_arn` |
| CloudFront origin access control (S3, sigv4, always) | `sample-plat-spa-<cluster>` | `ServerlessOacId` | `serverless_oac_id` |

Accepted in this sample: one runtime role serves every instance of the recipe, so a compromised function reaches the demo tables of the other instances. Production needs one role per application, issued by a control plane that validates the trust, never by a generic provider in the cluster.

Accepted in this sample: the REST API has no authorizer, so anyone who knows the `execute-api` URL can call `GET /items` and `POST /items`, and the site calls it from the browser with `access-control-allow-origin: *`. The stage throttling (10 requests per second, burst 20), the size limits of the handler and the runtime role scoped to the `sample-plat-*` tables bound the impact to demo data and cost. Delete the claim after the demo. Production needs an authorizer (IAM, Amazon Cognito or a Lambda authorizer) and an allowed origin instead of `*`.

The action lists are closed and come from the pinned controllers (provider-upjet-aws v2.9.0 wraps terraform-provider-aws v6.65.0). `python3 scripts/check-iac-parity.py` fails if the two fronts diverge, and also when both agree on something that breaks least privilege: `provider-aws-iam` anywhere or any IAM write, an action outside the closed list, a resource outside the provider scope, `Resource: "*"` outside the two statements without a resource type, a CloudFront or API Gateway write without its tag condition, `iam:PassRole` of anything but the runtime role, or a runtime role trust beyond `lambda.amazonaws.com`. It also keeps a closed inventory of every identity resource of both fronts: a role, inline policy, policy attachment, Pod Identity association, access entry or origin access control outside the list fails, and so does any managed policy or permissions boundary on the Crossplane roles. Both fronts refuse a cluster name longer than 38 characters, so `<cluster>-crossplane-cloudwatchlogs` fits the IAM limit of 64.

## Install order

The shared bootstrap sets three cluster Secret labels in order: `enable_crossplane` (core and CA), `enable_crossplane_packages` (providers and function) and `enable_crossplane_recipes` (provider config, XRDs and Compositions). Two prerequisites of the serverless recipe that no offline test catches:

- **Associations before provider pods.** The Pod Identity agent injects credentials when a pod starts. A provider pod that started before its association existed keeps running without `AWS_CONTAINER_CREDENTIALS_FULL_URI`, and its managed resources stay `Synced=False`. After creating or changing the associations on a live cluster, restart only the affected provider pods (`kubectl -n crossplane-system delete pod <provider-aws-...>`) and check the variable in the new pod spec before opening a claim.
- **API Gateway service-linked role.** The first `CreateStage` in an account without `AWSServiceRoleForAPIGateway` fails with `AccessDeniedException`, because the provider role deliberately has no IAM write. Create the role once per account as an operator step: `aws iam create-service-linked-role --aws-service-name ops.apigateway.amazonaws.com`. A second call answers `InvalidInput` because the role already exists.

## Serverless multi-tier

Group `serverless.platform.sample.lab`, Crossplane v2 namespaced XRs, only `function-patch-and-transform`. A team asks for one object; every AWS name derives from `name` with the platform prefix. `roleArn`, `oacId` and `region` are the platform contract: the operator copies them from the identity IaC outputs and from `aws_region` in `platform-contract.json`.

```yaml
apiVersion: serverless.platform.sample.lab/v1alpha1
kind: XServerlessMultiTier
metadata: {name: shop, namespace: team-demo}
spec:
  name: shop            # 3-24 chars, [a-z0-9-]
  team: team-demo
  size: small           # small 256 MB | medium 512 MB | large 1024 MB
  roleArn: <ServerlessRuntimeRoleArn or serverless_runtime_role_arn>
  oacId: <ServerlessOacId or serverless_oac_id>
  region: <aws_region of platform-contract.json>
```

A different `roleArn` passes the XRD pattern only if it is a `sample-plat-runtime-*` role, and IAM refuses it anyway: the Lambda provider may pass only the runtime role of its own cluster. Every Regional managed resource takes its Region from `spec.region`; the recipe has no Region literal.

| Composed XR | AWS resources | Names |
|---|---|---|
| 2 x `XDynamoDBTable` | on-demand table, point-in-time recovery, server-side encryption | `sample-plat-<name>-users`, `-posts` |
| (in the parent) | invoke permission for this API and stage | - |
| `XLambdaFunction` | private versioned code bucket, zip object, log group (14 days), function (python3.14, arm64) | `sample-plat-<name>-code`, `-api` |
| `XApiRest` | REGIONAL REST API with three routes and no authorizer, deployment, stage `v1` with X-Ray, throttling 10 rps / burst 20 | `sample-plat-<name>` |
| `XSpa` | private web bucket (origin access control only, TLS only), `index.html` that calls the API, CloudFront distribution with the shared origin access control | `sample-plat-<name>-web` |

`status.api.healthUrl` is the `/health` endpoint and `status.frontend.url` the CloudFront URL. `/health` reads one key from each table, so a 200 proves the whole chain (API Gateway, permission, function, runtime role, both tables).

Design choices of the recipe:

- the claim carries no OpenAPI body, zip location or deletion policy: an OpenAPI body can declare integrations with an arbitrary `credentials` role, and the zip is the code that runs with the table permissions; both are fixed by the Composition. The code is [`serverless-handler/main.py`](serverless-handler/main.py), embedded by [`serverless-handler/build.py`](serverless-handler/build.py) as a deterministic STORED zip: after editing the handler, run `python3 platform/components/crossplane/serverless-handler/build.py --write` and commit both files;
- no IAM resource is composed: the function uses the runtime role and the site the origin access control of the identity IaC;
- the invoke permission is scoped to this API and stage;
- no API Gateway access or execution logs (both need the account-wide API Gateway CloudWatch role) and no CloudFront standard logs (ACLs stay disabled on both buckets with `BucketOwnerEnforced`); stage metrics and X-Ray stay.

**Order: apply the claim only after the egress recovery.** Every resource is Regional or global. The [egress cut](../chaos-egress/README.md#the-8-minute-scene) does not stop this recipe: `crossplane-system` is not a cut target, because Crossplane core runs `hostNetwork`, so the providers keep reaching the Region during the cut and a claim opened then creates real resources. During a Service Link disconnection the XR stays `Synced=False` and reconciles when the link returns. The demo opens the claim after `AllRecovered`, so the cut shows only local paths:

Save the claim above, with the three platform values filled, as `serverless-claim.yaml` outside Git, then:

```bash
kubectl create namespace team-demo --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f serverless-claim.yaml
kubectl -n team-demo wait xserverlessmultitier/shop --for=condition=Ready --timeout=20m
curl -fsS "$(kubectl -n team-demo get xserverlessmultitier shop -o jsonpath='{.status.api.healthUrl}')"
```

Delete the claim before removing the infrastructure, and wait until the XR is gone: [`scripts/cleanup.sh`](../../../scripts/cleanup.sh) does not remove Regional resources created by Crossplane.

## Tests

```bash
python3 platform/components/crossplane/tests/test-serverless.py
python3 platform/components/crossplane/serverless-handler/build.py --check
python3 scripts/check-iac-parity.py
```

The serverless test is offline. It validates every base field and patch path against the CRD schemas of the pinned providers ([`tests/provider-schemas.json`](tests/provider-schemas.json); the `PlatformBucket` and `PlatformTable` Compositions are the positive control of that validator), renders the whole chain with a minimal patch-and-transform emulator in a fixture Region, asserts the security contract on the rendered objects (no IAM, runtime role and origin access control from the XR, every Regional resource in the XR Region, stage throttling on `*/*` at no more than 10 requests per second and burst 20), checks that every provider comes from Harbor by digest with a mirror line and a ServiceAccount that both IaC fronts target, and runs 24 mutation controls. After bumping a provider digest, regenerate the schemas with `python3 platform/components/crossplane/tests/gen-provider-schemas.py` (network; anonymous pull of the same digest): the test fails while the fixture and `packages.yaml` disagree.
