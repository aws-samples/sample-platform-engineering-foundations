# IDP portal, public shape

Terraform for running the portal **outside the internal gateway**: the shape the extension in
`aws-samples/sample-platform-engineering-foundations` deploys from a clean account.

```text
browser --(Hosted UI, PKCE)------> Amazon Cognito user pool
browser --(Bearer access token)--> API Gateway HTTP API (JWT authorizer) --> Lambda platform-api / cluster-api
browser --(HTTPS)----------------> CloudFront (OAC) --> private S3 bucket with the `oss` build of the SPA
```

The Lambdas are the **same zips** as the internal portal. Only the environment changes:
`AUTH_MODE=jwt` makes `backend/platform_identity` read the claims the authorizer already validated
(`username` from the Cognito access token), and `ALLOWED_ORIGINS` is the CloudFront distribution.

## Deploy, two phases

```bash
# phase 1: Lambdas + Cognito + API + tables + KMS + S3/CloudFront (31 resources)
scripts/public-deploy.sh my.tfvars apply
# phase 2: build the SPA (oss flavor) with the URLs that only exist after phase 1, sync, invalidate
scripts/public-deploy.sh my.tfvars spa
```

Minimal `my.tfvars`:

```hcl
region           = "us-east-1"
cluster_name     = "<foundation EKS cluster>"
cluster_endpoint = "https://<api server endpoint>"
cluster_ca_b64   = "<certificateAuthority.data>"
admin_aliases    = ["alice"]
initial_users    = { alice = "alice@example.com" }   # temporary password, forced change on first login
# private endpoint? attach the cluster-api to the VPC:
# cluster_api_vpc = { subnet_ids = ["subnet-..."], security_group_ids = ["sg-..."] }
```

Credentials come from the caller's environment (`AWS_PROFILE`, `AWS_CONFIG_FILE`); the scripts
never read them. State is local by default; add a backend block for a shared one.

## What is deliberately different from the internal portal

| Internal (the internal gateway) | Public shape |
|---|---|
| the corporate SSO session + the internal allowlist + SigV4 from the the internal gateway SDK | Cognito Hosted UI with PKCE; the SPA sends the access token |
| REST API Gateway with IAM authorization and a resource policy | HTTP API with a JWT authorizer; routes are explicit `GET`/`POST` so API Gateway answers the CORS preflight itself (an `ANY` route would send `OPTIONS` to the authorizer and fail with 401) |
| `requestContext.identity.userArn` | `requestContext.authorizer.claims` (payload format 1.0 keeps `httpMethod`/`path` for the Lambdas) |
| BFF to the private AI Gateway (Assistant, Studio, Agent Builder) | Not deployed; the feature flags are off and the portal says so |
| Self-registration impossible by construction (the internal gateway) | `allow_admin_create_user_only`: an admin creates users; no sign-up page |

## Measured on 2026-10-26 (account 225626021299, us-east-1, no cluster)

- Anonymous `GET /platform/me`: 401. Invalid token: 401. Cognito access token: 200 with `alias=platform-admin`, `isAdmin=true`. ID token also accepted (audience match).
- `GET /platform/scope`: 200 with the three registry projects. `GET /cluster/scorecards`: 502 with the source named (`kro.run/resourcegraphdefinitions unreadable`), never an empty list: there is no cluster in the test account.
- SPA: `/` and `/agent-platform/` 200 through CloudFront; the bucket URL directly: 403 (OAC only).
- Browser: redirect to the Hosted UI with `code_challenge_method=S256`, login, `/oauth2/token` 200, SPA renders `#home` with tokens in `sessionStorage`, every API call carries `Authorization: Bearer` (platform 200, cluster 502 as expected).
- Open before publishing the SPA from this module: the `oss` bundle still carries internal identifiers (account id, the internal gateway hosts, Slack channel ids in the bundled backlog and hub). That is step 4 of the `backstage-killer` item (content scrub). The test bucket was emptied after the proof for that reason.

## Test automation

`allow_password_auth = true` enables `USER_PASSWORD_AUTH` on the app client so a script can obtain a
token with `aws cognito-idp initiate-auth` after `admin-set-user-password --permanent`. Default is
SRP only. Never enable it for a real deployment.
