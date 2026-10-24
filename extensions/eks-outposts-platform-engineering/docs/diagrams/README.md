# Architecture diagrams

The editable draw.io source and exported PNG are kept in the extension so the architecture can be corrected without rebuilding it from memory.

## Inventory

| Source | Export | Purpose |
|---|---|---|
| `eks-outposts-platform-engineering.drawio` | `../images/eks-outposts-platform-engineering.png` | Shows the two equivalent IaC fronts, the EKS local cluster and platform on AWS Outposts, the Regional lifecycle dependencies, and the Service Link disconnection boundary |

The figure uses the Blog Figure profile from the `aws-architecture-diagram` Power and mirrors the boundary orientation of the official [Amazon EKS local-cluster architecture](https://docs.aws.amazon.com/eks/latest/userguide/eks-outposts-local-cluster-overview.html).

## Re-export

```bash
/Applications/draw.io.app/Contents/MacOS/draw.io -x -f png -e -b 10 -s 2 \
  -o docs/images/eks-outposts-platform-engineering.png \
  docs/diagrams/eks-outposts-platform-engineering.drawio
```

The `-e` flag embeds the draw.io XML in the PNG. Keep the `.drawio` and PNG together.

## Acceptance gates

```bash
POWER="$HOME/.kiro/powers/installed/aws-architecture-diagram"
python3 "$POWER/scripts/validate-drawio.py" docs/diagrams/eks-outposts-platform-engineering.drawio
python3 "$POWER/scripts/check-overlap.py" docs/diagrams/eks-outposts-platform-engineering.drawio
python3 "$POWER/scripts/check-crossing.py" docs/diagrams/eks-outposts-platform-engineering.drawio
python3 "$POWER/scripts/check-text-fit.py" docs/diagrams/eks-outposts-platform-engineering.drawio
python3 "$POWER/scripts/check-figure-geometry.py" lint docs/diagrams/eks-outposts-platform-engineering.drawio
```

All five commands must return zero findings. Inspect the exported PNG at the README rendering width before publishing.
