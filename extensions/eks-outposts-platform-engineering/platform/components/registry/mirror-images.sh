#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
IMAGES="$ROOT/platform/components/registry/images.txt"
TEMPLATE="$ROOT/platform/components/registry/mirror-job.yaml"
: "${HARBOR_USER:=admin}"
: "${HARBOR_PASSWORD:?set HARBOR_PASSWORD}"
: "${HARBOR_CA_FILE:?set HARBOR_CA_FILE to the public CA certificate}"
for tool in curl jq kubectl python3; do command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }; done
RUNTIME="$ROOT/platform/.runtime"; mkdir -p "$RUNTIME"
CIP=$(kubectl -n registry-local get service harbor -o jsonpath='{.spec.clusterIP}')
PF=0; AUTH=""
cleanup(){ [[ "$PF" == 0 ]] || kill "$PF" 2>/dev/null || true; [[ -z "$AUTH" ]] || rm -f "$AUTH"; }
trap cleanup EXIT
kubectl -n registry-local port-forward service/harbor 34443:443 >"$RUNTIME/harbor-port-forward.log" 2>&1 & PF=$!
ready=false
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if curl --silent --fail --cacert "$HARBOR_CA_FILE" --resolve harbor.local:34443:127.0.0.1 https://harbor.local:34443/api/v2.0/ping >/dev/null; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { echo "Harbor port-forward did not become ready" >&2; exit 2; }
[[ "$HARBOR_PASSWORD" != *[[:space:]]* ]] || { echo "Harbor password must not contain whitespace for netrc authentication" >&2; exit 2; }
AUTH=$(mktemp "$RUNTIME/harbor-netrc.XXXXXX"); chmod 600 "$AUTH"
printf 'machine harbor.local
login %s
password %s
' "$HARBOR_USER" "$HARBOR_PASSWORD" > "$AUTH"
while IFS='|' read -r source destination; do
  [[ -n "$source" && -n "$destination" ]] || continue
  project=${destination%%/*}; payload=$(jq -nc --arg project "$project" '{project_name:$project,public:true}')
  curl --fail --silent --show-error --cacert "$HARBOR_CA_FILE" --resolve harbor.local:34443:127.0.0.1 --netrc-file "$AUTH" -H 'Content-Type: application/json' -X POST https://harbor.local:34443/api/v2.0/projects -d "$payload" >/dev/null || true
done < "$IMAGES"
kubectl -n registry-local create configmap platform-image-inventory --from-file=images.txt="$IMAGES" --dry-run=client -o yaml | kubectl apply -f -
python3 - "$TEMPLATE" "$CIP" <<'PY' >/dev/null
import sys
from pathlib import Path
text=Path(sys.argv[1]).read_text().replace('${REGISTRY_SERVICE_IP}', sys.argv[2])
if '${REGISTRY_SERVICE_IP}' in text: raise SystemExit('registry service IP was not rendered')
print(text, end='')
PY
kubectl -n registry-local delete job platform-image-mirror --ignore-not-found --wait=true
python3 - "$TEMPLATE" "$CIP" <<'PY' | kubectl apply -f -
import sys
from pathlib import Path
print(Path(sys.argv[1]).read_text().replace('${REGISTRY_SERVICE_IP}', sys.argv[2]), end='')
PY
kubectl -n registry-local wait --for=condition=Complete job/platform-image-mirror --timeout=30m
kubectl -n registry-local logs job/platform-image-mirror
