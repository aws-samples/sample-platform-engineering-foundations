#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 2 ]] || { echo "usage: $0 cloudformation parameters.json | terraform directory" >&2; exit 2; }
MODE=$1; TARGET=$2
command -v kubectl >/dev/null || { echo "missing: kubectl" >&2; exit 2; }
case "$MODE" in
  terraform)
    command -v terraform >/dev/null || { echo "missing: terraform" >&2; exit 2; }
    [[ -d "$TARGET" ]] || { echo "Terraform directory not found" >&2; exit 2; }
    EXPECTED_CLUSTER=$(terraform -chdir="$TARGET" output -raw cluster_name)
    EXPECTED_ENDPOINT=$(terraform -chdir="$TARGET" output -raw cluster_endpoint)
    ;;
  cloudformation)
    for tool in aws jq; do command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }; done
    [[ -f "$TARGET" ]] || { echo "CloudFormation parameter file not found" >&2; exit 2; }
    REGION=$(jq -er .region "$TARGET")
    EXPECTED_CLUSTER=$(jq -er .parameters.ClusterName "$TARGET")
    EXPECTED_ENDPOINT=$(aws eks describe-cluster --region "$REGION" --name "$EXPECTED_CLUSTER" --query cluster.endpoint --output text)
    ;;
  *) echo "unknown mode: $MODE" >&2; exit 2;;
esac
kubectl cluster-info >/dev/null 2>&1 || { echo "cluster is not reachable; refusing cleanup" >&2; exit 2; }
CURRENT_ENDPOINT=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
[[ "$CURRENT_ENDPOINT" == "$EXPECTED_ENDPOINT" ]] || { echo "kubectl context does not target $EXPECTED_CLUSTER; refusing cleanup" >&2; exit 2; }
read -rp "Delete claims and infrastructure for $EXPECTED_CLUSTER? Type DELETE: " answer
[[ "$answer" == DELETE ]] || { echo "cancelled"; exit 1; }
ERROR_FILE=$(mktemp); trap 'rm -f "$ERROR_FILE"' EXIT
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
if [[ "$MODE" == terraform ]]; then
  terraform -chdir="$TARGET" destroy
else
  for key in identity_stack nodes_stack cluster_stack network_stack; do
    stack=$(jq -er ".$key" "$TARGET")
    aws cloudformation delete-stack --region "$REGION" --stack-name "$stack"
    aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$stack"
  done
fi
