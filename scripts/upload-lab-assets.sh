#!/usr/bin/env bash
# =============================================================================
# upload-lab-assets.sh
# =============================================================================
# Publishes the hands-on lab trees to the S3 bucket the IDE seeds from, so the
# code editor opens with the lab files already in ~/environment and you do not
# have to clone anything inside it.
#
#   labs/ack/         ->  s3://<bucket>/<prefix>ack/         -> ~/environment/ack
#   labs/kro/         ->  s3://<bucket>/<prefix>kro/         -> ~/environment/kro
#   labs/crossplane/  ->  s3://<bucket>/<prefix>crossplane/  -> ~/environment/crossplane
#
# WHY THIS IS A SEPARATE STEP: psp-workshop-code-editor.yaml seeds those three
# directories from the bucket during provisioning and FAILS THE STACK if any of
# them comes back empty. Nothing uploads them for you - run this before you
# deploy the code editor stack.
#
# USAGE
#   ./scripts/upload-lab-assets.sh <bucket> [region] [aws-profile] [prefix] [tree...]
#
#   All three trees by default; pass names to target a subset:
#     ./scripts/upload-lab-assets.sh my-bucket us-east-1 "" "" crossplane
#
# Run it again after changing anything under labs/ - the IDE copies from the
# bucket, not from your clone, so an unpublished change is invisible.
# =============================================================================
set -euo pipefail

BUCKET="${1:-}"
REGION="${2:-us-east-1}"
PROFILE="${3:-}"
PREFIX="${4:-}"
if [ $# -gt 4 ]; then
  shift 4
  TREES=("$@")
else
  TREES=(ack kro crossplane)
fi

if [[ -z "$BUCKET" ]]; then
  echo "ERROR: bucket name required." >&2
  echo "usage: $0 <bucket> [region] [aws-profile] [prefix] [tree...]" >&2
  exit 1
fi

# set -u aborts on "${arr[@]}" when the array is empty, so guard the expansion.
PROFILE_ARG=()
[[ -n "$PROFILE" ]] && PROFILE_ARG=(--profile "$PROFILE")

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for tree in "${TREES[@]}"; do
  SRC="${REPO_ROOT}/labs/${tree}"
  DEST="s3://${BUCKET}/${PREFIX}${tree}"

  if [[ ! -d "$SRC" ]]; then
    echo "ERROR: not found: $SRC" >&2
    exit 1
  fi

  echo "Publishing ${tree}"
  echo "  from: labs/${tree}"
  echo "  to:   $DEST"

  aws s3 sync "$SRC" "$DEST" \
    --region "$REGION" \
    ${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"} \
    --delete \
    --exact-timestamps

  # Assert the bucket holds exactly as many objects as the local tree has files,
  # per tree. A count per tree rather than a total: with one tree published and
  # the others missing, a total-only check passes while most of the labs are
  # absent, and the failure only shows up when a participant reaches that lab.
  local_n=$(find "$SRC" -type f | wc -l | tr -d ' ')
  bucket_n=$(aws s3 ls "${DEST}/" --recursive --region "$REGION" \
        ${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"} | wc -l | tr -d ' ')
  echo "  local: ${local_n} files | in bucket: ${bucket_n} objects"
  if [ "$local_n" != "$bucket_n" ]; then
    echo "ERROR: ${tree} mismatch - ${local_n} local files vs ${bucket_n} in the bucket" >&2
    exit 1
  fi
  [ "$bucket_n" -gt 0 ] || { echo "ERROR: ${tree} is empty in the bucket" >&2; exit 1; }
  echo ""
done

echo "Done. Deploy (or redeploy) the code editor stack and the IDE will seed"
echo "~/environment from these prefixes."
