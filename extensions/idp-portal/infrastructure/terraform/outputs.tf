output "spa_url" { value = local.spa_url }
output "spa_bucket" { value = aws_s3_bucket.spa.bucket }
output "cloudfront_distribution_id" { value = aws_cloudfront_distribution.spa.id }
output "api_url" { value = aws_apigatewayv2_api.api.api_endpoint }
output "cognito_domain" { value = "https://${aws_cognito_user_pool_domain.hosted_ui.domain}.auth.${var.region}.amazoncognito.com" }
output "cognito_client_id" { value = aws_cognito_user_pool_client.spa.id }
output "cognito_user_pool_id" { value = aws_cognito_user_pool.users.id }
output "cognito_issuer" { value = local.issuer }
# O que a SPA precisa no build do flavor oss (scripts/public-deploy.sh lê estes outputs).
output "spa_build_env" {
  value = {
    CLOUDSCAPE_FLAVOR        = "oss"
    VITE_AUTH_MODE           = "bearer"
    VITE_CLUSTER_API_URL     = aws_apigatewayv2_api.api.api_endpoint
    VITE_CLUSTER_API_REGION  = var.region
    VITE_PLATFORM_API_URL    = aws_apigatewayv2_api.api.api_endpoint
    VITE_PLATFORM_API_REGION = var.region
    VITE_COGNITO_DOMAIN      = "https://${aws_cognito_user_pool_domain.hosted_ui.domain}.auth.${var.region}.amazoncognito.com"
    VITE_COGNITO_CLIENT_ID   = aws_cognito_user_pool_client.spa.id
  }
}
