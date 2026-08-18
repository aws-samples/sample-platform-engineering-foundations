#!/usr/bin/env bash
# =============================================================================
# upload-backstage-genai-assets.sh
# =============================================================================
# Publishes to the WorkshopAssetsBucket everything the stack and the labs read
# from S3:
#
#   assets/backstage-genai/  -> s3://<bucket>/<prefix>backstage-genai/
#                               (downloaded by the `psp-backstage-build`
#                                CodeBuild project, which uses NO_SOURCE)
#   assets/.../lambda/*      -> s3://<bucket>/<prefix>lambda/<name>.zip
#                               (referenced by the CloudFormation custom
#                                resources)
#   labs/{ack,kro,crossplane}-> s3://<bucket>/<prefix>{ack,kro,crossplane}/
#                               (read by modules 1 and 2)
#
# USAGE
#   ./scripts/upload-backstage-genai-assets.sh <bucket> [region] [aws-profile] [prefix]
#
# Run this script EVERY TIME you change any file under assets/backstage-genai/,
# before triggering a new build:
#   aws codebuild start-build --project-name psp-backstage-build --region <region>
# =============================================================================
set -euo pipefail

BUCKET="${1:-}"
REGION="${2:-us-east-1}"
PROFILE="${3:-}"
# Prefix inside the bucket. Empty reproduces the layout of a manual deploy; in
# Workshop Studio it maps to {{.AssetsBucketPrefix}} (ends with '/').
PREFIX="${4:-}"

if [[ -z "$BUCKET" ]]; then
  echo "ERROR: bucket name required." >&2
  echo "usage: $0 <bucket> [region] [aws-profile] [prefix]" >&2
  exit 1
fi

PROFILE_ARG=()
[[ -n "$PROFILE" ]] && PROFILE_ARG=(--profile "$PROFILE")

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${REPO_ROOT}/assets/backstage-genai"
DEST="s3://${BUCKET}/${PREFIX}backstage-genai"

# Every required file is checked BEFORE the upload: shipping an incomplete set
# would make CodeBuild fail 15 minutes later, during the docker build.
REQUIRED=(
  Dockerfile
  add-genai-resolutions.js
  apply-genai-patches.js
  app-config.genai.yaml
  app-config.workshop.yaml
)

echo "[upload] source:      ${SRC}"
echo "[upload] destination: ${DEST}/"

for f in "${REQUIRED[@]}"; do
  if [[ ! -f "${SRC}/${f}" ]]; then
    echo "ERROR: required file missing: assets/backstage-genai/${f}" >&2
    exit 1
  fi
done
echo "[upload] OK - ${#REQUIRED[@]} required files present"

for f in "${REQUIRED[@]}"; do
  aws s3 cp "${SRC}/${f}" "${DEST}/${f}" \
    --region "$REGION" ${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"}
done

# The deploy manifest takes no part in the docker build, but the participant
# downloads it during the lab, so it travels along.
aws s3 cp "${SRC}/k8s/backstage.yaml" "${DEST}/k8s/backstage.yaml" \
  --region "$REGION" ${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"}

# -----------------------------------------------------------------------------
# Lambdas for the CloudFormation custom resources
# -----------------------------------------------------------------------------
# Both handlers exceed the 4096-character limit of the inline `Code.ZipFile`,
# so the template references the zips in the assets bucket, at
# <prefix>lambda/<name>.zip. The source code is tracked in
# assets/backstage-genai/lambda/ and packaged here, so that what runs in the
# workshop is exactly what is in the repository.
LAMBDA_DEST="s3://${BUCKET}/${PREFIX}lambda"
TMP_ZIP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_ZIP_DIR"' EXIT

for fn in prewarm supported-list-validator; do
  if [[ ! -f "${SRC}/lambda/${fn}/handler.py" ]]; then
    echo "ERROR: handler missing: assets/backstage-genai/lambda/${fn}/handler.py" >&2
    exit 1
  fi
  # Fail early on a syntax error: a broken handler would only show up much
  # later, as a custom resource failure in the middle of provisioning.
  python3 -m py_compile "${SRC}/lambda/${fn}/handler.py" || {
    echo "ERROR: ${fn}/handler.py does not compile" >&2; exit 1; }

  # Only the handler goes into the zip: tests and caches are left out.
  ( cd "${SRC}/lambda/${fn}" && zip -q -X "${TMP_ZIP_DIR}/${fn}.zip" handler.py )
  aws s3 cp "${TMP_ZIP_DIR}/${fn}.zip" "${LAMBDA_DEST}/${fn}.zip" \
    --region "$REGION" ${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"}
done
echo "[upload] 2 Lambda zips published to ${LAMBDA_DEST}/"

# -----------------------------------------------------------------------------
# Lab manifests
# -----------------------------------------------------------------------------
# Modules 1 and 2 read their manifests from <prefix>ack/, <prefix>kro/ and
# <prefix>crossplane/ in this same bucket - in an AWS-hosted event that content
# arrives with the workshop assets, so a standalone deploy has to publish it
# here or a step several modules in fails on a missing file.
LABS_SRC="${REPO_ROOT}/labs"
for d in ack kro crossplane; do
  if [[ ! -d "${LABS_SRC}/${d}" ]]; then
    echo "ERROR: lab directory missing: labs/${d}" >&2
    exit 1
  fi
  aws s3 sync "${LABS_SRC}/${d}" "s3://${BUCKET}/${PREFIX}${d}" \
    --region "$REGION" --delete --only-show-errors \
    ${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"}
done
echo "[upload] lab manifests published to s3://${BUCKET}/${PREFIX}{ack,kro,crossplane}/"

echo "[upload] done. To build the image:"
echo "  aws codebuild start-build --project-name psp-backstage-build --region ${REGION}"
