# Diagrams

Every diagram in this repository keeps its **draw.io source next to the exported image**, so a
figure can be corrected without redrawing it. This file is the contract: how to edit, how to
re-export, and what a diagram has to satisfy before it ships.

## Inventory

| Source | Exported to | Shows | Alt text |
|---|---|---|---|
| `three-cluster-topology.drawio` | `../images/three-cluster-topology.png` | The three EKS Auto Mode clusters, one VPC each, full-mesh peering, and what runs where | Three EKS clusters in separate VPCs connected by full-mesh VPC peering, each running Kubernetes 1.35 in Auto Mode |
| `iac-to-ack-migration.drawio` | `../images/iac-to-ack-migration.png` | The optional module: existing CloudFormation, Terraform, or Pulumi resources adopted into ACK and kro through either front | Four-stage flow from existing IaC through two migration fronts to adopted AWS resources reconciled by ACK |
| `cnoe-workshop-architecture.drawio` | `../images/cnoe-workshop-architecture.png` | The participant access path (CloudFront, ALB, code-server) and the CNOE stack inside the EKS Auto Mode cluster | Participants reach a browser IDE through CloudFront and an ALB; inside the cluster Backstage drives kro, Argo CD syncs the CNOE repo and manages the controllers that provision AWS services |

Reused from the workshop content, no source in this repo:

| Image | Shows |
|---|---|
| `../images/arch-reference.png` | The CNOE reference implementation: cert-manager, External DNS, Argo Workflows, Crossplane, Backstage, Argo CD, Keycloak, External Secrets |

## Editing and re-exporting

Open the `.drawio` in draw.io desktop, or open the exported PNG directly: the export embeds the
XML, so the image itself is editable even without the source file.

```bash
/Applications/draw.io.app/Contents/MacOS/draw.io -x -f png -e -b 10 -s 2 \
  -o docs/images/three-cluster-topology.png \
  docs/diagrams/three-cluster-topology.drawio
```

| Flag | Why |
|---|---|
| `-x` | Export mode |
| `-f png` | Output format |
| `-e` | **Embed the diagram XML in the PNG.** This is what keeps the exported image editable. Do not drop it |
| `-b 10` | 10px border, so nothing touches the edge |
| `-s 2` | 2x scale, crisp on high-density displays |

Install draw.io desktop with `brew install --cask drawio` if the binary is missing.

## Rules for a new diagram

Constraints borrowed from figures published in blog posts and docs. They exist because a diagram
authored on an unbounded canvas becomes illegible the moment it is scaled into a column of text,
and the width limit is what forces sensible spacing in the first place.

| Constraint | Value |
|---|---|
| Authoring canvas width | 1100 to 1200 px |
| Effective rendered width | 800 px, assume the reader sees it this small |
| Service icons | 68 to 78 px |
| Horizontal spacing between icon centres | 120 to 180 px |
| Minimum font size | 10 px at authoring scale |
| Body labels | 10 to 11 px, container labels 12 px, title 18 px bold |
| Background | Light. Do not depend on dark-mode inversion |

**Never encode meaning in colour alone.** Every distinction needs a second channel: a text label, a
number, a glyph, or a border style. A dashed edge means something different from a solid edge *and*
says so in the legend. A numbered stage carries the number in its own label, not in a coloured
badge floating next to it. This is an accessibility requirement, not a preference.

**Skip corner badge icons on boundaries.** At 800 px they turn into noise. The boundary's own colour
and label carry the identity.

**Give every figure a legend** when it has more than about six elements, and keep it to one line per
item. The legend is what makes the diagram survive being read without the surrounding prose.

**Use real service icons, never a substitute.** AWS services use the AWS4 icon set. Kubernetes
objects use the Kubernetes shapes. Third-party tools without an official icon (kro, Crossplane,
Argo CD, Karpenter) get a generic shape with a clear text label. Standing in an unrelated AWS icon
for a third-party tool misinforms the reader.

## Verification, and why it is not optional

Well-formed XML says nothing about whether the figure is correct. Clipped labels, text crossing a
boundary, and edge labels landing on top of shapes are all valid XML.

```
1. Write the .drawio
2. Export the PNG
3. Open the PNG and look at it
4. Fix what you see, re-export, look again
```

Step 3 is the one that gets skipped and the only one that catches real defects. What to check:

- No truncated text anywhere. Edge labels between two close shapes are the usual offender: under
  roughly 60 px of gap, drop the label and put the text in its own cell
- No text crossing a boundary edge, no overlapping shapes
- Every element that carries meaning has a text label, not just a colour
- Arrows connect what you intended. Set `exitX`/`exitY`/`entryX`/`entryY` explicitly when the
  default routing wanders
- Still readable imagining it at 800 px wide

## Attribution

`three-cluster-topology.drawio` and `iac-to-ack-migration.drawio` were authored for this
repository. The two reused images come from the workshop content and depict the CNOE reference
implementation, which is documented at [cnoe.io](https://cnoe.io/).
