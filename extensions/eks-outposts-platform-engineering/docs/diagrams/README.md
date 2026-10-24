# Architecture diagrams

The editable draw.io sources and exported PNGs are kept in the extension so the architecture can be corrected without rebuilding it from memory.

## Inventory

| Source | Export | Purpose |
|---|---|---|
| `eks-outposts-platform-engineering.drawio` | `../images/eks-outposts-platform-engineering.png` | Shows the two equivalent IaC fronts, the EKS local cluster and platform on AWS Outposts, the Regional lifecycle dependencies, and the Service Link disconnection boundary, scoped to short disconnections |
| `eks-outposts-storage-options.drawio` | `../images/eks-outposts-storage-options.png` | Compares the implemented EBS-backed Outpost for short disconnections with the instance-store Outpost for prolonged disconnections, which this extension does not implement |

Both figures use the Blog Figure profile from the `aws-architecture-diagram` Power and mirror the boundary orientation of the official [Amazon EKS local-cluster architecture](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-local-cluster-overview.html).

## Re-export

```bash
/Applications/draw.io.app/Contents/MacOS/draw.io -x -f png -e -b 10 -s 2 \
  -o docs/images/eks-outposts-platform-engineering.png \
  docs/diagrams/eks-outposts-platform-engineering.drawio
/Applications/draw.io.app/Contents/MacOS/draw.io -x -f png -e -b 10 -s 2 \
  -o docs/images/eks-outposts-storage-options.png \
  docs/diagrams/eks-outposts-storage-options.drawio
```

The `-e` flag embeds the draw.io XML in the PNG. Keep each `.drawio` and its PNG together.

## Acceptance gates

```bash
POWER="$HOME/.kiro/powers/installed/aws-architecture-diagram"
for f in docs/diagrams/*.drawio; do
  python3 "$POWER/scripts/validate-drawio.py" "$f"
  python3 "$POWER/scripts/check-overlap.py" "$f"
  python3 "$POWER/scripts/check-crossing.py" "$f"
  python3 "$POWER/scripts/check-text-fit.py" "$f"
  python3 "$POWER/scripts/check-figure-geometry.py" lint "$f"
done
```

All five commands must return zero findings for each figure. Inspect each exported PNG at the README rendering width before publishing.
