#!/usr/bin/env bash
set -euo pipefail
usage(){ echo "usage: $0 cloudformation parameters.json | terraform directory | volumes inventory-file" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
MODE=$1; TARGET=$2
ROOT=$(cd "$(dirname "$0")/.." && pwd)
for tool in aws kubectl python3; do command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }; done
ERROR_FILE=$(mktemp); trap 'rm -f "$ERROR_FILE"' EXIT

# Delete the EBS volumes listed in an inventory written by this script. Each volume is deleted only
# when it still carries the tags the EBS CSI driver sets on volumes it provisions, and only once it is
# available. Anything not deleted stays in the inventory so the step can be retried with "volumes".
delete_inventory_volumes(){
  local inventory=$1 region pv volume described state cluster_tag name_tag remaining
  region=$(awk 'NR==1 && $1=="region" {print $2}' "$inventory")
  [[ -n "$region" ]] || { echo "inventory has no region header: $inventory" >&2; return 2; }
  remaining=$(mktemp)
  printf 'region %s\n' "$region" > "$remaining"
  while read -r pv volume <&3; do
    [[ "$pv" == region ]] && continue
    if [[ ! "$volume" =~ ^vol-[0-9a-f]+$ ]]; then
      echo "unexpected volume handle for $pv: $volume" >&2; printf '%s %s\n' "$pv" "$volume" >> "$remaining"; continue
    fi
    if ! described=$(aws ec2 describe-volumes --region "$region" --volume-ids "$volume" \
        --query "Volumes[0].[State, Tags[?Key=='ebs.csi.aws.com/cluster'].Value | [0], Tags[?Key=='CSIVolumeName'].Value | [0]]" \
        --output text 2>"$ERROR_FILE"); then
      if grep -q 'InvalidVolume.NotFound' "$ERROR_FILE"; then continue; fi
      cat "$ERROR_FILE" >&2; printf '%s %s\n' "$pv" "$volume" >> "$remaining"; continue
    fi
    read -r state cluster_tag name_tag <<< "$described"
    if [[ "$cluster_tag" != true || "$name_tag" != "$pv" ]]; then
      echo "volume $volume does not carry the EBS CSI tags for $pv; not deleted" >&2; printf '%s %s\n' "$pv" "$volume" >> "$remaining"; continue
    fi
    if [[ "$state" != available ]] && ! aws ec2 wait volume-available --region "$region" --volume-ids "$volume"; then
      echo "volume $volume did not become available; not deleted" >&2; printf '%s %s\n' "$pv" "$volume" >> "$remaining"; continue
    fi
    if ! aws ec2 delete-volume --region "$region" --volume-id "$volume"; then
      printf '%s %s\n' "$pv" "$volume" >> "$remaining"; continue
    fi
    echo "deleted $volume ($pv)"
  done 3< "$inventory"
  if [[ $(wc -l < "$remaining") -gt 1 ]]; then
    mv "$remaining" "$inventory"
    echo "volumes not deleted are listed in $inventory; retry with: bash $0 volumes $inventory" >&2
    return 2
  fi
  rm -f "$remaining" "$inventory"
}

if [[ "$MODE" == volumes ]]; then
  [[ -f "$TARGET" ]] || { echo "inventory not found" >&2; exit 2; }
  cat "$TARGET"
  read -rp "Delete the EBS volumes listed above? Type DELETE: " answer
  [[ "$answer" == DELETE ]] || { echo "cancelled"; exit 1; }
  delete_inventory_volumes "$TARGET"
  exit
fi
case "$MODE" in
  terraform)
    command -v terraform >/dev/null || { echo "missing: terraform" >&2; exit 2; }
    [[ -d "$TARGET" ]] || { echo "Terraform directory not found" >&2; exit 2; }
    EXPECTED_CLUSTER=$(terraform -chdir="$TARGET" output -raw cluster_name)
    EXPECTED_ENDPOINT=$(terraform -chdir="$TARGET" output -raw cluster_endpoint)
    REGION=$(terraform -chdir="$TARGET" output -raw region)
    ;;
  cloudformation)
    command -v jq >/dev/null || { echo "missing: jq" >&2; exit 2; }
    [[ -f "$TARGET" ]] || { echo "CloudFormation parameter file not found" >&2; exit 2; }
    REGION=$(jq -er .region "$TARGET")
    EXPECTED_CLUSTER=$(jq -er .parameters.ClusterName "$TARGET")
    EXPECTED_ENDPOINT=$(aws eks describe-cluster --region "$REGION" --name "$EXPECTED_CLUSTER" --query cluster.endpoint --output text)
    ;;
  *) usage;;
esac
kubectl cluster-info >/dev/null 2>&1 || { echo "cluster is not reachable; refusing cleanup" >&2; exit 2; }
CURRENT_ENDPOINT=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
[[ "$CURRENT_ENDPOINT" == "$EXPECTED_ENDPOINT" ]] || { echo "kubectl context does not target $EXPECTED_CLUSTER; refusing cleanup" >&2; exit 2; }
read -rp "Delete claims and infrastructure for $EXPECTED_CLUSTER? Type DELETE: " answer
[[ "$answer" == DELETE ]] || { echo "cancelled"; exit 1; }
if kubectl get crd platformbuckets.platform.sample.lab >/dev/null 2>"$ERROR_FILE"; then
  kubectl delete platformbuckets.platform.sample.lab,platformtables.platform.sample.lab --all --all-namespaces --wait=true --timeout=10m
  deadline=$((SECONDS+600)); remaining=1
  while (( SECONDS < deadline )); do
    remaining=$(kubectl get managed -A -o name | wc -l | tr -d ' ')
    [[ "$remaining" == 0 ]] && break
    sleep 5
  done
  [[ "$remaining" == 0 ]] || { echo "managed resources remain: $remaining" >&2; exit 2; }
elif ! grep -q 'NotFound' "$ERROR_FILE"; then
  cat "$ERROR_FILE" >&2; echo "unable to determine whether Crossplane claims exist" >&2; exit 2
fi
# Dynamically provisioned EBS volumes outlive the cluster. Inventory the ones the EBS CSI driver
# provisioned through the platform class with reclaim policy Delete, outside Git, before teardown.
mkdir -p "$ROOT/platform/.runtime"
INVENTORY="$ROOT/platform/.runtime/cleanup-$EXPECTED_CLUSTER-$(date -u +%Y%m%dT%H%M%SZ).volumes"
printf 'region %s\n' "$REGION" > "$INVENTORY"
kubectl get pv -o json | python3 -c '
import json, sys
for pv in json.load(sys.stdin)["items"]:
  spec, meta = pv["spec"], pv["metadata"]
  if (spec.get("storageClassName") == "platform-ebs-gp2" and spec.get("persistentVolumeReclaimPolicy") == "Delete"
      and (spec.get("csi") or {}).get("driver") == "ebs.csi.aws.com"
      and (meta.get("annotations") or {}).get("pv.kubernetes.io/provisioned-by") == "ebs.csi.aws.com"):
    print(meta["name"], spec["csi"]["volumeHandle"])
' >> "$INVENTORY"
echo "EBS volume inventory: $INVENTORY"
cat "$INVENTORY"
if [[ "$MODE" == terraform ]]; then
  terraform -chdir="$TARGET" destroy
else
  for key in identity_stack nodes_stack cluster_stack network_stack; do
    stack=$(jq -er ".$key" "$TARGET")
    aws cloudformation delete-stack --region "$REGION" --stack-name "$stack"
    aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$stack"
  done
fi
delete_inventory_volumes "$INVENTORY"
