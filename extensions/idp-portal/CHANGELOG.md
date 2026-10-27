# Changelog

All notable changes to the Internal Developer Platform portal extension are documented here.

## 2026-10-27

- First export of the portal as an extension of `sample-platform-engineering-foundations`, under `extensions/idp-portal/`. Nothing outside that folder changes.
- Public shape: Cognito user pool with Hosted UI and a PKCE client, HTTP API with a JWT authorizer, the `platform-api` and `cluster-api` Lambdas in `AUTH_MODE=jwt`, DynamoDB tables, a KMS HMAC key, and a private S3 bucket behind CloudFront with Origin Access Control (`infrastructure/terraform/`, `scripts/deploy.sh` in two phases).
- SPA on the public `@cloudscape-design/*` packages (Visual Refresh theme): catalog, provisioning wizard, inventory with master-detail, compositions with schema and GraphRevisions, dependency graph across instances, scorecards, teams and owners, promotion between logical environments, notifications drawer, audit trail, in-portal documentation and help.
- Measured from a clean account without a cluster: anonymous and invalid-token calls answer 401, a Cognito access token answers 200 with the caller alias, cluster reads answer a named 502, the bucket refuses direct access (403) and the browser signs in through the Hosted UI with PKCE.
- `scripts/validate.sh` runs the TypeScript build, the Vitest suite, the Python tests of the Lambdas and `terraform validate` without credentials.
