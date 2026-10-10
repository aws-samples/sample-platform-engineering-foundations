#!/usr/bin/env bash
# =============================================================================
# upload-iac-migration-assets.sh
# =============================================================================
# Publishes the module 4 (legacy IaC migration) artefacts to the assets bucket,
# from where the IDE seeds them into ~/environment during provisioning:
#
#   automation/legacy-estate/
#     -> s3://<bucket>/<prefix>iac-migration/legacy-estate/
#     -> ~/environment/legacy-iac                    (the estate to transform)
#
#   automation/iac-to-ack-atx-custom/
#     -> s3://<bucket>/<prefix>iac-migration/ack-resource-adoption-from-iac/
#     -> ~/environment/ack-adoption-transformation    (the ATX definition)
#
# The bucket keys are fixed by psp-workshop-code-editor.yaml (step
# seedIacMigrationArtefacts), which copies from exactly those two prefixes. The
# IDE drops README.md and BENCHMARKS.md from the transformation on the way in,
# because `atx custom def publish` rejects a definition directory that holds
# anything other than SKILL.md, references/ and scripts/.
#
# Module 4 is optional and its seeding step never fails the IDE stack, so a
# missing upload does NOT surface at deploy time. It surfaces at section 4.2 as
# an empty ~/environment/legacy-iac. Run this before deploying the IDE stack.
#
# USAGE
#   ./scripts/upload-iac-migration-assets.sh <bucket> [region] [aws-profile] [prefix]
#
# Run it again after changing anything under automation/legacy-estate/ or
# automation/iac-to-ack-atx-custom/, then redeploy the IDE stack - the IDE copies
# from the bucket, not from your clone.
# =============================================================================
set -euo pipefail

BUCKET="${1:-}"
REGION="${2:-us-east-1}"
PROFILE="${3:-}"
PREFIX="${4:-}"

if [[ -z "$BUCKET" ]]; then
  echo "ERROR: bucket name required." >&2
  echo "usage: $0 <bucket> [region] [aws-profile] [prefix]" >&2
  exit 1
fi

# set -u aborts on "${arr[@]}" when the array is empty, so guard the expansion.
PROFILE_ARG=()
[[ -n "$PROFILE" ]] && PROFILE_ARG=(--profile "$PROFILE")

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# <local directory under the repo root>:<key under <prefix>iac-migration/>
PAIRS=(
  "automation/legacy-estate:legacy-estate"
  "automation/iac-to-ack-atx-custom:ack-resource-adoption-from-iac"
)

for pair in "${PAIRS[@]}"; do
  rel="${pair%%:*}"
  key="${pair##*:}"
  SRC="${REPO_ROOT}/${rel}"
  DEST="s3://${BUCKET}/${PREFIX}iac-migration/${key}"

  if [[ ! -d "$SRC" ]]; then
    echo "ERROR: not found: $SRC" >&2
    exit 1
  fi

  echo "Publishing ${key}"
  echo "  from: ${rel}"
  echo "  to:   $DEST"

  aws s3 sync "$SRC" "$DEST" \
    --region "$REGION" \
    ${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"} \
    --delete \
    --exact-timestamps

  # Same invariant as upload-lab-assets.sh: per tree, the bucket holds exactly
  # as many objects as the local tree has files. A partial upload or a stale
  # leftover fails here instead of at section 4.2.
  local_n=$(find "$SRC" -type f | wc -l | tr -d ' ')
  bucket_n=$(aws s3 ls "${DEST}/" --recursive --region "$REGION" \
        ${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"} | wc -l | tr -d ' ')
  echo "  local: ${local_n} files | in bucket: ${bucket_n} objects"
  if [ "$local_n" != "$bucket_n" ]; then
    echo "ERROR: ${key} mismatch - ${local_n} local files vs ${bucket_n} in the bucket" >&2
    exit 1
  fi
  [ "$bucket_n" -gt 0 ] || { echo "ERROR: ${key} is empty in the bucket" >&2; exit 1; }
  echo ""
done

echo "Done. Deploy (or redeploy) the code editor stack and the IDE will seed"
echo "~/environment/legacy-iac and ~/environment/ack-adoption-transformation."
