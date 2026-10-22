# Validation contract

Run `bash scripts/validate.sh` before deployment and `bash scripts/validate.sh --runtime` after bootstrap. For a release build, set `PRIVATE_DENYLIST_FILE` to a non-repository file containing `word:<value>` or `substring:<value>` rules. The validator fails on malformed rules and never copies the file into the package.

## Connected preparation

- Both IaC fronts validate and emit the same contract keys.
- The selected node type passes the instance store driver preflight.
- Worker nodes are `Ready`.
- Every Helm chart is fetched at its pinned version. Helm checks repository-index digests and the script records local SHA-256 values.
- Harbor contains every image in `platform/components/registry/images.txt`.
- Argo CD applications are `Synced` and `Healthy`.
- The instance store smoke pod writes and reads its sentinel.

## Paired controls

- NetworkPolicy: `frontend -> backend` succeeds, `frontend -> db` fails, removing only the db policy makes it succeed, and restoring the policy blocks it again.
- Pod Identity: a pod using the associated service account returns that role, while the same image with the default service account returns a different identity or no credentials.
- DNS: a cached external answer remains available during the interruption; a never-resolved name does not become a false success.
- Logs: a generated policy deny appears in VictoriaLogs with the source and destination of the denied flow.

## Disconnected checks

Repeat the runtime checks with the regional link unavailable. Do not call an add-on `ACTIVE` or an application `Healthy` proof of behavior. Exercise the actual read, write, DNS, policy, metric, and log paths.

## Boundary

This package is publish-ready source, not evidence of a completed Outpost hardware test. Record the target Outpost, node type, add-on versions, timestamps, and paired-control results outside Git after the test.
