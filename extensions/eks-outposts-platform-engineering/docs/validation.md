# Validation contract

Run `bash scripts/validate.sh` before deployment and `bash scripts/validate.sh --runtime` after bootstrap. For a release build, set `PRIVATE_DENYLIST_FILE` to a non-repository file containing `word:<value>` or `substring:<value>` rules. The validator fails on malformed rules and never copies the file into the package.

The static run includes `python3 scripts/check-iac-parity.py`. It executes the CloudFormation and Terraform contract emitters against one synthetic environment and requires the same 12 keys and values. It also verifies the two entry points, the shared bootstrap handoff, VPC CNI and EBS CSI add-on ownership, `AmazonEBSCSIDriverPolicy` on the node role of both fronts and its Terraform wiring, the bootstrap order of the EBS CSI driver and StorageClass, the controller credential endpoint and its NetworkPolicy rule, the `platform-ebs-gp2` StorageClass and its use in every platform values file, and the Crossplane Pod Identity trust, permissions, namespace, service accounts, and resource-name prefix. Eighteen mutation controls must all be detected. When the pinned charts are fetched, the static run also renders every Helm release and requires every claim to use `platform-ebs-gp2`.

## Connected preparation

- Both IaC fronts validate and emit the same contract keys.
- The `aws-ebs-csi-driver` add-on is `ACTIVE` at the pinned version, and `platform-ebs-gp2` reports `ebs.csi.aws.com` with `type: gp2`.
- Worker nodes are `Ready`.
- Every Helm chart is fetched at its pinned version. Helm checks repository-index digests and the script records local SHA-256 values.
- Harbor contains every image in `platform/components/registry/images.txt`.
- Argo CD applications are `Synced` and `Healthy`.
- The EBS smoke pod writes and reads its sentinel, its PersistentVolume carries `spec.csi.driver: ebs.csi.aws.com`, and every claim in `registry-local`, `git-local`, `monitoring`, and `victorialogs` is `Bound` to `platform-ebs-gp2`.

## Paired controls

- NetworkPolicy: `frontend -> backend` succeeds, `frontend -> db` fails, removing only the db policy makes it succeed, and restoring the policy blocks it again.
- EBS CSI credential: after a restart under the enforced policies, an ephemeral container in the `ebs-csi-controller` pod reaches the instance metadata endpoint on port 80 and does not reach the Pod Identity agent endpoint. `bash scripts/validate.sh --runtime` runs this check and restarts the controller again to drop the ephemeral container.
- Pod Identity: a pod using the associated service account returns that role, while the same image with the default service account returns a different identity or no credentials.
- DNS: a cached external answer remains available during the interruption; a never-resolved name does not become a false success.
- Logs: a generated policy deny appears in VictoriaLogs with the source and destination of the denied flow.
- Storage: data written to an EBS-backed claim is still there after its pod is deleted and rescheduled, while a new claim from the same class starts empty.

## Disconnected checks

Repeat the runtime checks with the regional link unavailable. Do not call an add-on `ACTIVE` or an application `Healthy` proof of behavior. Exercise the actual read, write, DNS, policy, metric, and log paths. Do not create, resize, or move EBS-backed pods during the disconnect; that is a documented limit of local clusters, not a test result.

## Alternative storage acceptance

Do not describe an alternative storage path as validated until every criterion passes on the target rack during a real disconnected test.

| Criterion | Command or measured action | Required proof |
|---|---|---|
| Correct provisioner | `kubectl get storageclass "$ALT_SC" -o jsonpath='{.provisioner}{"\n"}'` | The expected vendor or software-defined CSI provisioner, never `ebs.csi.aws.com` |
| Dynamic provisioning while disconnected | `kubectl apply -f <alternative-storage-smoke-test.yaml>` followed by `kubectl wait --for=jsonpath='{.status.phase}'=Bound pvc/<claim> -n <namespace> --timeout=120s` | A new claim binds while the Service Link is disconnected |
| Data continuity | `kubectl exec -n <namespace> <pod> -- sha256sum <mounted-sentinel>` before and after pod replacement | The checksum is identical |
| Rescheduling | `kubectl delete pod -n <namespace> <pod>` followed by `kubectl wait --for=condition=Ready pod -l <selector> -n <namespace> --timeout=300s` | The replacement runs on an eligible node and reads the sentinel |
| Node-loss boundary | Isolate one storage-bearing worker according to the approved test plan, then run `kubectl get pod,pvc,pv -n <namespace> -o wide` | The documented quorum, replica, failover, and recovery behavior occurs within the accepted time |
| Replica rebuild | Use the storage system's native status command after the node returns | All replicas become healthy without losing the sentinel |
| Backup and restore | Use the storage system's documented local backup and restore commands | A restored claim has the original checksum without a Regional dependency |
| Negative control | Repeat dynamic provisioning with `ALT_SC=platform-ebs-gp2` while disconnected | The EBS-backed create or reschedule operation fails, proving the test is exercising the Regional dependency |

Record timestamps, nodes, StorageClass, provisioner, volume IDs, checksums, failover time, rebuild time, backup target, and the Outpost `ConnectedStatus`. A Bound PVC alone is not acceptance.

## Boundary

This package is publish-ready source, not evidence of a completed Outpost hardware test of this assembled package. The README records what the source implementation measured on hardware. Record the target Outpost, node type, add-on versions, timestamps, and paired-control results outside Git after the test.
