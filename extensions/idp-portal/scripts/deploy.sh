#!/usr/bin/env bash
# IDP portal extension: deploys the public shape into a clean AWS account, in two phases.
#   1. build the two Lambda zips + terraform apply (Cognito, HTTP API + JWT authorizer, Lambdas,
#      DynamoDB tables, KMS, private S3 + CloudFront)
#   2. build the SPA with the URLs that only exist after the apply, sync to S3, invalidate CloudFront
#
# Usage: scripts/deploy.sh <tfvars> [plan|apply|spa|all|destroy]      (default: all)
# Auth: whatever the environment provides (AWS_PROFILE / AWS_CONFIG_FILE). Nothing here reads a
# secret; terraform and the aws cli do. Requires terraform >= 1.5, node 20, aws cli 2, python3.
set -euo pipefail
EXT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TFVARS="$(cd "$(dirname "${1:?tfvars file}")" && pwd)/$(basename "$1")"; MODE="${2:-all}"
MODULE="$EXT/infrastructure/terraform"
[ -f "$TFVARS" ] || { echo "tfvars not found: $TFVARS" >&2; exit 2; }

phase_infra() {
  echo "== build lambdas"
  PLATFORM_ZIP=$("$EXT/backend/platform_api/build.sh"); CLUSTER_ZIP=$("$EXT/backend/cluster_api/build.sh")
  echo "platform-api: $PLATFORM_ZIP"; echo "cluster-api:  $CLUSTER_ZIP"
  cd "$MODULE"
  terraform init -input=false >/dev/null
  echo "== terraform $1"
  terraform "$1" -input=false -var-file="$TFVARS" -var "platform_api_zip=$PLATFORM_ZIP" -var "cluster_api_zip=$CLUSTER_ZIP" ${2:-}
}

phase_spa() {
  cd "$MODULE"
  echo "== spa build env (from terraform outputs)"
  terraform output -json spa_build_env | python3 -c 'import json,sys; env=json.load(sys.stdin); print("\n".join(f"export {k}={v}" for k,v in env.items()))' > "$MODULE/.spa-build.env"
  # shellcheck disable=SC1091
  source "$MODULE/.spa-build.env"; sed 's/^export //' "$MODULE/.spa-build.env"
  cd "$EXT"
  echo "== npm ci && npm run build"
  npm ci --no-audit --no-fund >/dev/null
  npm run build >/dev/null
  BUCKET=$(cd "$MODULE" && terraform output -raw spa_bucket); DIST=$(cd "$MODULE" && terraform output -raw cloudfront_distribution_id)
  echo "== sync build/ -> s3://$BUCKET"
  aws s3 sync build/ "s3://$BUCKET/" --delete --only-show-errors
  aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query 'Invalidation.Id' --output text
  echo "== url"; (cd "$MODULE" && terraform output -raw spa_url)
}

case "$MODE" in
  plan)    phase_infra plan ;;
  apply)   phase_infra apply "-auto-approve" ;;
  spa)     phase_spa ;;
  all)     phase_infra apply "-auto-approve"; phase_spa ;;
  destroy) cd "$MODULE"; terraform init -input=false >/dev/null
           terraform destroy -input=false -auto-approve -var-file="$TFVARS" -var "platform_api_zip=$TFVARS" -var "cluster_api_zip=$TFVARS" ;;
  *) echo "mode must be plan|apply|spa|all|destroy" >&2; exit 2 ;;
esac
