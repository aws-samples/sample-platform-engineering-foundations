#!/usr/bin/env bash
# Install or remove the pinned Chaos Mesh release used by the egress cut demo.
#
#   bash install.sh install   --inputs <json> --context <ctx> [--kubeconfig <kc>]
#   bash install.sh uninstall --inputs <json> --context <ctx> [--kubeconfig <kc>] [--purge-crds]
#
# install: downloads the pinned chart, verifies its SHA-256, checks the rendered chart (check-chart), applies the
# namespace NetworkPolicies (the VPC CNI runs in strict mode) and only then runs helm install. Run it connected.
# uninstall: runs the demo rollback first and stops if it does not finish clean, because without the controller
# nobody removes iptables rules that may still be in the pods.
set -euo pipefail

CHART_VERSION=2.8.7
CHART_URL="https://charts.chaos-mesh.org/chaos-mesh-${CHART_VERSION}.tgz"
CHART_SHA256=c963e0f4ed2e30c1c7e236477f1c31fcf988b171991801bbe392546948436d38
RELEASE=chaos-mesh
NS=chaos-mesh
HERE=$(cd "$(dirname "$0")" && pwd)

die() { echo "ERROR: $*" >&2; exit 2; }

[[ $# -ge 1 ]] || die "usage: bash install.sh install|uninstall --inputs <json> --context <ctx> [--kubeconfig <kc>] [--purge-crds]"
CMD=$1; shift
INPUTS="" CTX="" KC="" PURGE=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --inputs) INPUTS=$2; shift 2 ;;
    --context) CTX=$2; shift 2 ;;
    --kubeconfig) KC=$2; shift 2 ;;
    --purge-crds) PURGE=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n $INPUTS && -f $INPUTS ]] || die "--inputs must point at a file"
[[ -n $CTX ]] || die "--context is required: the script never uses the current context by accident"

K=(kubectl --context "$CTX"); H=(helm --kube-context "$CTX"); PYK=(--context "$CTX")
if [[ -n $KC ]]; then K+=(--kubeconfig "$KC"); H+=(--kubeconfig "$KC"); PYK+=(--kubeconfig "$KC"); fi

W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

case $CMD in
  install)
    curl -fsSL --max-time 60 -o "$W/chart.tgz" "$CHART_URL"
    got=$(python3 -c 'import hashlib,sys; from pathlib import Path; print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())' "$W/chart.tgz")
    [[ $got == "$CHART_SHA256" ]] || die "chart sha256 $got != pin $CHART_SHA256"
    "${H[@]}" template "$RELEASE" "$W/chart.tgz" -n "$NS" -f "$HERE/chaos-mesh-values.yaml" > "$W/render.yaml"
    python3 "$HERE/egress_chaos.py" check-chart --render "$W/render.yaml"
    python3 "$HERE/egress_chaos.py" render --inputs "$INPUTS" --out "$W/r"
    "${K[@]}" apply -f "$W/r/chaos-mesh-netpol.yaml"
    "${H[@]}" upgrade --install "$RELEASE" "$W/chart.tgz" -n "$NS" -f "$HERE/chaos-mesh-values.yaml" --wait --timeout 5m
    for r in deployment/chaos-controller-manager daemonset/chaos-daemon deployment/chaos-dashboard; do
      "${K[@]}" -n "$NS" rollout status "$r" --timeout=180s
    done
    echo "RESULT install chaos-mesh=$CHART_VERSION sha256=ok check-chart=ok"
    ;;
  uninstall)
    python3 "$HERE/egress_chaos.py" rollback --inputs "$INPUTS" "${PYK[@]}" || die "rollback did not finish clean; run 'python3 egress_chaos.py rollback --force' before removing Chaos Mesh"
    "${H[@]}" uninstall "$RELEASE" -n "$NS" --wait --ignore-not-found
    "${K[@]}" delete namespace "$NS" --ignore-not-found --wait=true --timeout=180s
    if [[ $PURGE == 1 ]]; then
      while read -r crd; do
        [[ -n $crd ]] && "${K[@]}" delete "$crd"
      done < <("${K[@]}" get crd -o name | grep '\.chaos-mesh\.org$' || true)
    fi
    echo "RESULT uninstall chaos-mesh crds=$([[ $PURGE == 1 ]] && echo removed || echo kept)"
    ;;
  *) die "unknown command: $CMD" ;;
esac
