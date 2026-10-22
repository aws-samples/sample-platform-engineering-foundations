#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/platform/.runtime"
LOCK="$ROOT/scripts/charts.lock"
mkdir -p "$OUT/packages" "$OUT/charts" "$OUT/THIRD_PARTY_NOTICES"
for tool in helm shasum awk; do command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }; done
[[ -f "$LOCK" ]] || { echo "chart lock not found: $LOCK" >&2; exit 2; }
awk 'NF != 2 || $1 !~ /^[0-9a-f]{64}$/ || $2 !~ /^[a-z0-9-]+\/[a-z0-9-]+:[0-9][0-9A-Za-z.-]*$/ { exit 1 } { seen[$2]++ } END { if (NR != 6) exit 1; for (ref in seen) if (seen[ref] != 1) exit 1 }' "$LOCK" || { echo "invalid chart lock: expected six unique SHA-256 entries" >&2; exit 2; }
helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1 || true
helm repo add harbor https://helm.goharbor.io >/dev/null 2>&1 || true
helm repo add gitea https://dl.gitea.com/charts/ >/dev/null 2>&1 || true
helm repo add vm https://victoriametrics.github.io/helm-charts/ >/dev/null 2>&1 || true
helm repo add crossplane https://charts.crossplane.io/stable >/dev/null 2>&1 || true
helm repo update >/dev/null
pull(){
  repo=$1; chart=$2; version=$3; ref="$repo/$chart:$version"
  package="$OUT/packages/$chart-$version.tgz"
  expected=$(awk -v ref="$ref" '$2 == ref { print $1 }' "$LOCK")
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || { echo "missing locked digest for $ref" >&2; exit 2; }
  rm -f "$package"
  helm pull "$repo/$chart" --version "$version" --destination "$OUT/packages"
  digest=$(shasum -a 256 "$package" | awk '{print $1}')
  [[ "$digest" == "$expected" ]] || { echo "chart digest mismatch for $ref: expected $expected, got $digest" >&2; exit 1; }
  mkdir -p "$OUT/charts/$chart/$version"
  tar -xzf "$package" -C "$OUT/charts/$chart/$version"
  printf '%s  %s\n' "$digest" "$ref" >> "$OUT/charts.lock.generated"
  while IFS= read -r notice; do cp "$notice" "$OUT/THIRD_PARTY_NOTICES/${chart}-${version}-$(basename "$notice")"; done < <(find "$OUT/charts/$chart/$version" -type f \( -iname 'LICENSE*' -o -iname 'NOTICE*' \))
}
: > "$OUT/charts.lock.generated"
pull argo argo-cd 10.9.2
pull harbor harbor 1.19.2
pull gitea gitea 12.7.0
pull vm victoria-metrics-k8s-stack 0.93.0
pull vm victoria-logs-single 0.13.10
pull crossplane crossplane 2.4.3
sort -o "$OUT/charts.lock.generated" "$OUT/charts.lock.generated"
cmp -s "$LOCK" "$OUT/charts.lock.generated" || { echo "generated chart digest manifest differs from the committed lock" >&2; exit 1; }
echo "PASS chart digests verified against $LOCK"
