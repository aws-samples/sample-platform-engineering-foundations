#!/usr/bin/env bash
set -euo pipefail

unsupported='|c1|c3|c4|c5d|c5ad|c6gd|d2|d3|d3en|dl1|e3|edge1gd|f1|g2|g3|g4ad|g4dn|h1|hsm1|i2|i3|i3en|m1|m2|m3|m4|m5d|m5ad|m5dn|m6gd|p2|p3|p3dn|p4d|p4de|r3|r4|r5d|r5ad|r5dn|r6gd|t1|t2|x1|x1e|x2gd|z1d|'
failed=0

echo "Node / instance type compatibility:"
while read -r node type; do
  family=${type%%.*}
  family=$(printf '%s' "$family" | tr '[:upper:]' '[:lower:]')
  printf '  %-48s %-20s' "$node" "$type"
  if [[ "$unsupported" == *"|${family}|"* ]]; then
    echo "UNSUPPORTED by LIS CSI considerations"
    failed=1
  else
    echo "not on exclusion list (still validate NVMe devices)"
  fi
done < <(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.labels.node\.kubernetes\.io/instance-type}{"\n"}{end}')

cat <<'EOF'

Destructive pre-install checks, run per target node before approval:
  lsblk -o NAME,MODEL,SIZE,FSTYPE,MOUNTPOINTS
  sudo nvme list
  sudo pvs; sudo vgs; sudo lvs

Expected local model: Amazon EC2 NVMe Instance Storage
STOP if any ephemeral device is mounted or managed by filesystem, LVM, LUKS, another CSI, or raw-volume tooling.
EOF

if (( failed )); then
  echo "BLOCKED: at least one node family is explicitly unsupported by the official considerations."
  exit 2
fi

echo "Preflight family gate passed. This does NOT authorize installation or prove Outposts support."
