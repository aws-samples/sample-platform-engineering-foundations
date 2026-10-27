#!/usr/bin/env bash
# IDP portal extension: everything that can be checked without an AWS account.
#   frontend  npm ci, type-check + production build, vitest suite
#   backend   pytest (the Lambdas and the shared packages, boto3 faked by the tests)
#   infra     terraform fmt -check + validate (no backend, no credentials)
# Exit code is non-zero on the first failing gate. Run from any directory.
set -euo pipefail
EXT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$EXT"

echo "== frontend: npm ci"
npm ci --no-audit --no-fund >/dev/null
echo "== frontend: build (tsc + vite)"
npm run build >/dev/null
echo "== frontend: tests"
npx vitest run --reporter=dot 2>&1 | tail -4

echo "== backend: pytest"
python3 -m pip install -q -r tests/requirements.txt 2>/dev/null || true
python3 -m pytest tests -q 2>&1 | tail -2

echo "== infrastructure: terraform validate"
cd infrastructure/terraform
terraform init -backend=false -input=false >/dev/null
terraform fmt -check -recursive
terraform validate -no-color | tail -1
echo "== OK"
