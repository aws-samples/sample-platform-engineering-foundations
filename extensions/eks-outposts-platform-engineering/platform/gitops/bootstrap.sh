#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 platform-contract.json" >&2; exit 2; }
for tool in aws curl git helm jq kubectl python3; do command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }; done
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CONTRACT=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
: "${HARBOR_ADMIN_PASSWORD:?set HARBOR_ADMIN_PASSWORD}"
: "${GITEA_ADMIN_PASSWORD:?set GITEA_ADMIN_PASSWORD}"
: "${GRAFANA_ADMIN_PASSWORD:?set GRAFANA_ADMIN_PASSWORD}"
: "${HARBOR_TLS_CERT_FILE:?set HARBOR_TLS_CERT_FILE}"
: "${HARBOR_TLS_KEY_FILE:?set HARBOR_TLS_KEY_FILE}"
: "${HARBOR_CA_FILE:?set HARBOR_CA_FILE}"
: "${EBS_CSI_ADDON_VERSION:?set a pinned aws-ebs-csi-driver add-on version}"
: "${POD_IDENTITY_AGENT_VERSION:?set a pinned Pod Identity agent add-on version}"
: "${VPC_CNI_ADDON_VERSION:?set a pinned vpc-cni add-on version}"
: "${COREDNS_ADDON_VERSION:?set a pinned coredns add-on version}"
: "${FLUENT_BIT_ADDON_VERSION:?set a pinned fluent-bit add-on version}"
REGION=$(jq -er .aws_region "$CONTRACT")
CLUSTER=$(jq -er .cluster_name "$CONTRACT")
REGISTRY_IP=$(jq -er .registry_service_ip "$CONTRACT")
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[[ "$ACCOUNT" == "$(jq -er .account_id "$CONTRACT")" ]] || { echo "AWS account differs from contract" >&2; exit 2; }
[[ -d "$ROOT/platform/.runtime/charts" ]] || bash "$ROOT/scripts/fetch-charts.sh"
mksecret(){ ns=$1; name=$2; shift 2; kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -; kubectl -n "$ns" create secret generic "$name" "$@" --dry-run=client -o yaml | kubectl apply -f -; }
ensure_addon(){ name=$1; version=$2; config=${3:-}; if aws eks describe-addon --region "$REGION" --cluster-name "$CLUSTER" --addon-name "$name" >/dev/null 2>&1; then args=(update-addon); else args=(create-addon); fi; args+=(--region "$REGION" --cluster-name "$CLUSTER" --addon-name "$name" --addon-version "$version" --resolve-conflicts OVERWRITE); [[ -z "$config" ]] || args+=(--configuration-values "file://$config"); aws eks "${args[@]}" >/dev/null; aws eks wait addon-active --region "$REGION" --cluster-name "$CLUSTER" --addon-name "$name"; }
mksecret registry-local harbor-admin --from-literal=HARBOR_ADMIN_PASSWORD="$HARBOR_ADMIN_PASSWORD"
kubectl -n registry-local create secret tls harbor-tls --cert="$HARBOR_TLS_CERT_FILE" --key="$HARBOR_TLS_KEY_FILE" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n registry-local create configmap harbor-ca --from-file=ca.crt="$HARBOR_CA_FILE" --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace crossplane-system --dry-run=client -o yaml | kubectl apply -f -
kubectl -n crossplane-system create configmap harbor-ca --from-file=ca.crt="$HARBOR_CA_FILE" --dry-run=client -o yaml | kubectl apply -f -
mksecret git-local gitea-admin --from-literal=username=platform-admin --from-literal=password="$GITEA_ADMIN_PASSWORD"
mksecret monitoring grafana-admin --from-literal=admin-user=admin --from-literal=admin-password="$GRAFANA_ADMIN_PASSWORD"
CHARTS="$ROOT/platform/.runtime/charts"
ensure_addon aws-ebs-csi-driver "$EBS_CSI_ADDON_VERSION"
ensure_addon eks-pod-identity-agent "$POD_IDENTITY_AGENT_VERSION"
kubectl apply -f "$ROOT/platform/components/storage/storageclass.yaml"
helm upgrade --install harbor "$CHARTS/harbor/1.19.2/harbor" -n registry-local --create-namespace -f "$ROOT/platform/gitops/values/harbor-bootstrap.yaml" --set expose.clusterIP.staticClusterIP="$REGISTRY_IP" --wait
helm upgrade --install gitea "$CHARTS/gitea/12.7.0/gitea" -n git-local --create-namespace -f "$ROOT/platform/gitops/values/gitea.yaml" --set image.registry=docker.gitea.com --set image.repository=gitea --set image.tag=1.27.0 --wait
helm upgrade --install argocd "$CHARTS/argo-cd/10.9.2/argo-cd" -n argocd --create-namespace -f "$ROOT/platform/gitops/values/argocd-bootstrap.yaml" --wait
HARBOR_PASSWORD="$HARBOR_ADMIN_PASSWORD" HARBOR_CA_FILE="$HARBOR_CA_FILE" bash "$ROOT/platform/components/registry/mirror-images.sh"
kubectl apply -f "$ROOT/platform/components/registry/harbor-prepull.yaml"
kubectl -n registry-local rollout status daemonset/harbor-image-prepull --timeout=15m
helm upgrade --install harbor "$CHARTS/harbor/1.19.2/harbor" -n registry-local -f "$ROOT/platform/gitops/values/harbor.yaml" --set expose.clusterIP.staticClusterIP="$REGISTRY_IP" --wait
kubectl -n registry-local delete daemonset harbor-image-prepull --wait=true
helm upgrade --install gitea "$CHARTS/gitea/12.7.0/gitea" -n git-local -f "$ROOT/platform/gitops/values/gitea.yaml" --wait
helm upgrade --install argocd "$CHARTS/argo-cd/10.9.2/argo-cd" -n argocd -f "$ROOT/platform/gitops/values/argocd.yaml" --wait
ensure_addon coredns "$COREDNS_ADDON_VERSION" "$ROOT/platform/components/coredns/configuration-values.json"
ensure_addon fluent-bit "$FLUENT_BIT_ADDON_VERSION" "$ROOT/platform/components/observability/fluent-bit-configuration-values.json"
RUNTIME="$ROOT/platform/.runtime/gitops-repo"
mkdir -p "$RUNTIME"
cp -R "$ROOT/platform/gitops" "$RUNTIME/"
cp -R "$ROOT/platform/components" "$RUNTIME/"
cp -R "$ROOT/platform/apps" "$RUNTIME/"
cp -R "$CHARTS" "$RUNTIME/"
python3 "$ROOT/platform/gitops/render-runtime.py" "$CONTRACT" "$RUNTIME"
git -C "$RUNTIME" init -q -b main
git -C "$RUNTIME" add gitops components apps charts
git -C "$RUNTIME" -c user.name=platform-bootstrap -c user.email=platform@platform.local commit -qm bootstrap || true
kubectl -n git-local port-forward svc/gitea-http 33000:3000 >"$ROOT/platform/.runtime/gitea-port-forward.log" 2>&1 & PF=$!
ASK=""; CURL_AUTH=""; RESPONSE="$ROOT/platform/.runtime/gitea-create-response.json"
cleanup(){ kill "$PF" 2>/dev/null || true; [[ -z "$ASK" ]] || rm -f "$ASK"; [[ -z "$CURL_AUTH" ]] || rm -f "$CURL_AUTH"; }
trap cleanup EXIT
ready=false
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if curl --fail --silent http://127.0.0.1:33000/api/v1/version >/dev/null; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { echo "Gitea port-forward did not become ready" >&2; exit 2; }
[[ "$GITEA_ADMIN_PASSWORD" != *[[:space:]]* ]] || { echo "Gitea password must not contain whitespace for netrc authentication" >&2; exit 2; }
CURL_AUTH=$(mktemp "$ROOT/platform/.runtime/gitea-netrc.XXXXXX"); chmod 600 "$CURL_AUTH"
printf 'machine 127.0.0.1
login platform-admin
password %s
' "$GITEA_ADMIN_PASSWORD" > "$CURL_AUTH"
code=$(curl --silent --show-error --netrc-file "$CURL_AUTH" -o "$RESPONSE" -w '%{http_code}' -H 'Content-Type: application/json' -X POST http://127.0.0.1:33000/api/v1/user/repos -d '{"name":"platform-demo","private":false}')
[[ "$code" == 201 || "$code" == 409 ]] || { echo "Gitea repository creation failed with HTTP $code" >&2; cat "$RESPONSE" >&2; exit 2; }
ASK="$ROOT/platform/.runtime/askpass.sh"
cat > "$ASK" <<'ASKPASS'
#!/bin/sh
case "$1" in
  *Username*) printf '%s
' platform-admin ;;
  *) printf '%s
' "$GIT_PW" ;;
esac
ASKPASS
chmod 700 "$ASK"
GIT_PW="$GITEA_ADMIN_PASSWORD" GIT_ASKPASS="$ASK" GIT_TERMINAL_PROMPT=0 git -C "$RUNTIME" push http://127.0.0.1:33000/platform-admin/platform-demo.git main
rm -f "$ASK"
python3 "$ROOT/platform/gitops/render-secret.py" "$CONTRACT" "$ROOT/platform/gitops/contract-secret.template.yaml" | kubectl apply -f -
kubectl apply -f "$ROOT/platform/gitops/app-of-apps.yaml"
kubectl -n argocd wait application/platform-root --for=jsonpath='{.status.health.status}'=Healthy --timeout=15m
kubectl -n argocd wait application/platform-network-policies --for=jsonpath='{.status.sync.status}'=Synced --timeout=15m
ensure_addon vpc-cni "$VPC_CNI_ADDON_VERSION" "$ROOT/platform/components/network-policies/vpc-cni-configuration-values.json"
kubectl -n argocd label secret "$CLUSTER" enable_crossplane=true --overwrite
kubectl -n argocd wait application/crossplane --for=jsonpath='{.status.health.status}'=Healthy --timeout=15m
kubectl -n argocd label secret "$CLUSTER" enable_crossplane_packages=true --overwrite
kubectl -n argocd wait application/crossplane-packages --for=jsonpath='{.status.health.status}'=Healthy --timeout=15m
kubectl -n argocd label secret "$CLUSTER" enable_crossplane_recipes=true --overwrite
kubectl -n argocd wait application/crossplane-recipes --for=jsonpath='{.status.sync.status}'=Synced --timeout=15m
bash "$ROOT/scripts/validate.sh" --runtime
