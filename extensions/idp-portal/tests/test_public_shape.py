"""platform/public (backstage-killer passo 3): invariantes do formato público lidas do Terraform."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Dois layouts, um teste: no repo fonte o módulo é platform/public + scripts/public-deploy.sh; na
# extension exportada (scripts/export-extension.py) é infrastructure/terraform + scripts/deploy.sh.
MODULE = next(p for p in (ROOT / "platform/public", ROOT / "infrastructure/terraform") if p.is_dir())
DEPLOY = next(p for p in (ROOT / "scripts/public-deploy.sh", ROOT / "scripts/deploy.sh") if p.is_file())
MAIN = (MODULE / "main.tf").read_text(encoding="utf-8")
VARS = (MODULE / "variables.tf").read_text(encoding="utf-8")
OUTS = (MODULE / "outputs.tf").read_text(encoding="utf-8")
SCRIPT = DEPLOY.read_text(encoding="utf-8")


def _block(kind: str, name: str) -> str:
    match = re.search(rf'resource "{kind}" "{name}" \{{(.*?)\n\}}', MAIN, re.S)
    assert match, f"{kind}.{name} missing"
    return match.group(1)


def test_every_api_route_is_jwt_authorized_and_none_is_any():
    route = _block("aws_apigatewayv2_route", "api")
    assert 'authorization_type = "JWT"' in route and "aws_apigatewayv2_authorizer.jwt.id" in route
    assert not re.search(r'route_key\s*=\s*"ANY ', MAIN), "no ANY route: OPTIONS must reach the API Gateway CORS handler"
    assert re.search(r'\["GET", "POST"\]', MAIN), "routes are explicit GET/POST so API Gateway answers the CORS preflight"
    authorizer = _block("aws_apigatewayv2_authorizer", "jwt")
    assert "issuer   = local.issuer" in authorizer and "audience = [aws_cognito_user_pool_client.spa.id]" in authorizer


def test_lambdas_run_in_jwt_mode_with_the_issuer_and_client_pinned_and_payload_1_0():
    env = re.search(r"identity_env = \{(.*?)\n  \}", MAIN, re.S).group(1)
    assert 'AUTH_MODE           = "jwt"' in env and "AUTH_JWT_ISSUER     = local.issuer" in env
    assert "AUTH_JWT_CLIENT_IDS = aws_cognito_user_pool_client.spa.id" in env
    assert 'PLATFORM_ADMINS     = join(",", var.admin_aliases)' in env
    for name in ("cluster_api", "platform_api"):
        assert 'payload_format_version = "1.0"' in _block("aws_apigatewayv2_integration", name)
        assert 'runtime          = "python3.14"' in _block("aws_lambda_function", name)
    assert 'AGENT_BUILDER_ENABLED      = "false"' in _block("aws_lambda_function", "platform_api")


def test_cognito_is_a_public_pkce_client_with_admin_only_user_creation_and_srp_by_default():
    client = _block("aws_cognito_user_pool_client", "spa")
    assert "generate_secret                      = false" in client
    assert 'allowed_oauth_flows                  = ["code"]' in client
    assert 'var.allow_password_auth ? ["ALLOW_USER_PASSWORD_AUTH"] : []' in client
    assert "allow_admin_create_user_only = true" in _block("aws_cognito_user_pool", "users")
    assert re.search(r'variable "allow_password_auth" \{[^}]*default\s*=\s*false', VARS, re.S)


def test_spa_bucket_is_private_behind_cloudfront_oac_with_spa_fallback():
    assert "block_public_policy     = true" in _block("aws_s3_bucket_public_access_block", "spa")
    dist = _block("aws_cloudfront_distribution", "spa")
    assert "origin_access_control_id = aws_cloudfront_origin_access_control.spa.id" in dist
    assert 'viewer_protocol_policy = "redirect-to-https"' in dist
    assert dist.count('response_page_path = "/index.html"') == 2
    assert "cloudfront.amazonaws.com" in MAIN and "AWS:SourceArn" in MAIN


def test_outputs_feed_the_spa_build_and_the_script_never_reads_credentials():
    for key in ("VITE_AUTH_MODE", "VITE_CLUSTER_API_URL", "VITE_PLATFORM_API_URL", "VITE_COGNITO_DOMAIN", "VITE_COGNITO_CLIENT_ID"):
        assert key in OUTS
    assert "spa_build_env" in SCRIPT and ("build:oss" in SCRIPT or "npm run build" in SCRIPT) and "create-invalidation" in SCRIPT
    assert "AWS_ACCESS_KEY" not in SCRIPT and "credentials" not in SCRIPT.lower().replace("nada aqui lê\n# credencial", "")


def test_frontend_bearer_bootstrap_only_runs_in_bearer_mode_and_never_stores_in_localstorage():
    main = (ROOT / "src/main.tsx").read_text(encoding="utf-8")
    cognito = (ROOT / "src/platform/auth/cognito.ts").read_text(encoding="utf-8")
    assert "if (AUTH_MODE === 'bearer')" in main and "bootstrapCognito" in main
    assert "localStorage" not in cognito and "sessionStorage" in cognito
    assert "code_challenge_method: 'S256'" in cognito and "client_secret" not in cognito
