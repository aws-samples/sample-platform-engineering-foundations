# IDP portal, formato público (backstage-killer passo 3): o que a extension em
# aws-samples/sample-platform-engineering-foundations sobe numa conta limpa, sem the internal gateway, the corporate SSO,
# the internal allowlist ou SigV4 no browser.
#
#   browser --(Hosted UI, PKCE)--> Cognito user pool
#   browser --(Bearer access token)--> API Gateway HTTP API (authorizer JWT) --> Lambda platform-api / cluster-api
#   browser --(HTTPS)--> CloudFront (OAC) --> S3 privado com o build `oss` da SPA
#
# As Lambdas são os MESMOS zips do portal interno; muda só o env: AUTH_MODE=jwt (backend/platform_identity)
# e ALLOWED_ORIGINS = a distribuição. Este módulo NÃO sobe a SPA: a build precisa das URLs que só existem
# depois do apply (API, Cognito), então `scripts/public-deploy.sh` faz build + sync + invalidation.
# O BFF (Platform Assistant, Studio, Agent Builder) fica fora: depende do AI Gateway privado do lab.
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" { region = var.region }

data "aws_caller_identity" "current" {}

locals {
  name    = var.name_prefix
  account = data.aws_caller_identity.current.account_id
  issuer  = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.users.id}"
  spa_url = "https://${aws_cloudfront_distribution.spa.domain_name}"
  tags    = { Project = "idp-portal", ManagedBy = "terraform", "auto-delete" = "no" }
}

resource "random_id" "suffix" { byte_length = 3 }

# ----------------------------------------------------------------------------- identidade (Cognito)
resource "aws_cognito_user_pool" "users" {
  name = "${local.name}-users"
  # username = alias (sem e-mail como login): é o que vira `username` no access token e o alias do portal.
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF"
  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }
  admin_create_user_config { allow_admin_create_user_only = true } # sem auto-cadastro: o admin cria quem entra
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
  tags = local.tags
}

resource "aws_cognito_user_pool_domain" "hosted_ui" {
  domain       = "${local.name}-${random_id.suffix.hex}"
  user_pool_id = aws_cognito_user_pool.users.id
}

resource "aws_cognito_user_pool_client" "spa" {
  name                                 = "${local.name}-spa"
  user_pool_id                         = aws_cognito_user_pool.users.id
  generate_secret                      = false # cliente público: PKCE, nunca segredo no browser
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  # SRP + refresh por default. USER_PASSWORD_AUTH só com `allow_password_auth` (teste automatizado).
  explicit_auth_flows           = concat(["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"], var.allow_password_auth ? ["ALLOW_USER_PASSWORD_AUTH"] : [])
  callback_urls                 = concat(["${local.spa_url}/", "${local.spa_url}/agent-platform/"], var.extra_callback_urls)
  logout_urls                   = concat(["${local.spa_url}/"], var.extra_callback_urls)
  prevent_user_existence_errors = "ENABLED"
  access_token_validity         = 60
  id_token_validity             = 60
  refresh_token_validity        = 8
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }
}

resource "aws_cognito_user" "initial" {
  for_each     = var.initial_users
  user_pool_id = aws_cognito_user_pool.users.id
  username     = each.key
  attributes   = { email = each.value, email_verified = "true" }
  # Senha temporária: o Hosted UI obriga a troca no primeiro login.
  temporary_password = "Welcome-${random_id.suffix.hex}-Aa1"
}

# ----------------------------------------------------------------------------- estado (DynamoDB, KMS)
resource "aws_dynamodb_table" "provision_requests" {
  name         = "${local.name}-provision-requests"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "requestId"
  attribute {
    name = "requestId"
    type = "S"
  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
  tags = local.tags
}

resource "aws_dynamodb_table" "platform_events" {
  name         = "${local.name}-platform-events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
  tags = local.tags
}

# HMAC do Platform Assistant (prova de confirmação de rollback). Só a platform-api gera.
resource "aws_kms_key" "assistant_approval" {
  description              = "${local.name}: HMAC proof for Platform Assistant removal approvals"
  key_usage                = "GENERATE_VERIFY_MAC"
  customer_master_key_spec = "HMAC_256"
  tags                     = local.tags
}

# ----------------------------------------------------------------------------- Lambdas
data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "platform_api" {
  name               = "${local.name}-platform-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
  tags               = local.tags
}

resource "aws_iam_role" "cluster_api" {
  name               = "${local.name}-cluster-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "platform_api_basic" {
  role       = aws_iam_role.platform_api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "cluster_api_basic" {
  role       = aws_iam_role.cluster_api.name
  policy_arn = var.cluster_api_vpc == null ? "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" : "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "platform_api" {
  name = "PlatformApiAccess"
  role = aws_iam_role.platform_api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "ProvisionQueue", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan"], Resource = aws_dynamodb_table.provision_requests.arn },
      { Sid = "PlatformEvents", Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:Query"], Resource = aws_dynamodb_table.platform_events.arn },
      { Sid = "ApprovalMac", Effect = "Allow", Action = ["kms:GenerateMac"], Resource = aws_kms_key.assistant_approval.arn, Condition = { StringEquals = { "kms:MacAlgorithm" = "HMAC_SHA_256" } } },
      { Sid = "ObserveThroughClusterApi", Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = aws_lambda_function.cluster_api.arn },
      { Sid = "TaggedResources", Effect = "Allow", Action = ["tag:GetResources"], Resource = "*" },
    ]
  })
}

resource "aws_iam_role_policy" "cluster_api" {
  name = "ClusterApiAccess"
  role = aws_iam_role.cluster_api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "DescribeCluster", Effect = "Allow", Action = ["eks:DescribeCluster"], Resource = "arn:aws:eks:${var.region}:${local.account}:cluster/${var.cluster_name}" },
      { Sid = "PlatformEventsWrite", Effect = "Allow", Action = ["dynamodb:PutItem"], Resource = aws_dynamodb_table.platform_events.arn },
      { Sid = "PlatformReadyStateRead", Effect = "Allow", Action = ["dynamodb:Query"], Resource = aws_dynamodb_table.platform_events.arn,
      Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["state#ready"] } } },
    ]
  })
}

locals {
  identity_env = {
    AUTH_MODE           = "jwt"
    AUTH_JWT_ISSUER     = local.issuer
    AUTH_JWT_CLIENT_IDS = aws_cognito_user_pool_client.spa.id
    AUTHORIZED_ALIASES  = "*"
    PLATFORM_ADMINS     = join(",", var.admin_aliases)
    ALLOWED_ORIGINS     = join(",", concat([local.spa_url], var.extra_allowed_origins))
    EVENTS_TABLE        = aws_dynamodb_table.platform_events.name
  }
}

resource "aws_lambda_function" "cluster_api" {
  function_name    = "${local.name}-cluster-api"
  role             = aws_iam_role.cluster_api.arn
  runtime          = "python3.14"
  handler          = "lambda_function.handler"
  architectures    = ["arm64"]
  timeout          = 29
  memory_size      = 512
  filename         = var.cluster_api_zip
  source_code_hash = filebase64sha256(var.cluster_api_zip)
  dynamic "vpc_config" {
    for_each = var.cluster_api_vpc == null ? [] : [var.cluster_api_vpc]
    content {
      subnet_ids         = vpc_config.value.subnet_ids
      security_group_ids = vpc_config.value.security_group_ids
    }
  }
  environment {
    variables = merge(local.identity_env, {
      CLUSTER_NAME     = var.cluster_name
      CLUSTER_REGION   = var.region
      CLUSTER_ENDPOINT = var.cluster_endpoint
      CLUSTER_CA_B64   = var.cluster_ca_b64
    })
  }
  tags = local.tags
}

resource "aws_lambda_function" "platform_api" {
  function_name    = "${local.name}-platform-api"
  role             = aws_iam_role.platform_api.arn
  runtime          = "python3.14"
  handler          = "lambda_function.handler"
  architectures    = ["arm64"]
  timeout          = 29
  memory_size      = 256
  filename         = var.platform_api_zip
  source_code_hash = filebase64sha256(var.platform_api_zip)
  environment {
    variables = merge(local.identity_env, {
      PROVISION_TABLE              = aws_dynamodb_table.provision_requests.name
      CLUSTER_API_FUNCTION         = aws_lambda_function.cluster_api.function_name
      ASSISTANT_REMOVAL_KEY_ID     = aws_kms_key.assistant_approval.arn
      COMPOSABLE_DASHBOARD_ENABLED = "true"
      # Sem BFF nem AI Gateway no formato público: as jornadas de IA ficam desligadas e o portal diz isso.
      AGENT_BUILDER_ENABLED      = "false"
      SERVICE_STUDIO_ENABLED     = "false"
      PLATFORM_ASSISTANT_ENABLED = "false"
    })
  }
  tags = local.tags
}

# ----------------------------------------------------------------------------- API Gateway HTTP API + JWT
resource "aws_apigatewayv2_api" "api" {
  name          = "${local.name}-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins     = concat([local.spa_url], var.extra_allowed_origins)
    allow_methods     = ["GET", "POST", "OPTIONS"]
    allow_headers     = ["authorization", "content-type"]
    allow_credentials = false
    max_age           = 600
  }
  tags = local.tags
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.api.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito"
  jwt_configuration {
    issuer   = local.issuer
    audience = [aws_cognito_user_pool_client.spa.id]
  }
}

# Payload 1.0: as Lambdas lêem `httpMethod`, `path` e `queryStringParameters` do formato REST.
resource "aws_apigatewayv2_integration" "cluster_api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.cluster_api.invoke_arn
  payload_format_version = "1.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_integration" "platform_api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.platform_api.invoke_arn
  payload_format_version = "1.0"
  timeout_milliseconds   = 29000
}

# GET e POST explícitos, nunca ANY: com ANY o OPTIONS do preflight cairia na rota com authorizer (401 sem
# token) e o browser bloquearia tudo por CORS. Sem rota para OPTIONS, o API Gateway responde o preflight
# sozinho com a `cors_configuration` (medido em 26/10/2026 na conta de teste).
locals { api_routes = { for pair in setproduct(["cluster", "platform"], ["GET", "POST"]) : "${pair[0]}-${lower(pair[1])}" => { prefix = pair[0], method = pair[1] } } }

resource "aws_apigatewayv2_route" "api" {
  for_each           = local.api_routes
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "${each.value.method} /${each.value.prefix}/{proxy+}"
  target             = "integrations/${each.value.prefix == "cluster" ? aws_apigatewayv2_integration.cluster_api.id : aws_apigatewayv2_integration.platform_api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 25
  }
  tags = local.tags
}

resource "aws_lambda_permission" "cluster_api" {
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cluster_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "platform_api" {
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.platform_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# ----------------------------------------------------------------------------- SPA (S3 privado + CloudFront OAC)
resource "aws_s3_bucket" "spa" {
  bucket        = "${local.name}-spa-${local.account}-${random_id.suffix.hex}"
  force_destroy = true
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "spa" {
  bucket                  = aws_s3_bucket.spa.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "spa" {
  bucket = aws_s3_bucket.spa.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_cloudfront_origin_access_control" "spa" {
  name                              = "${local.name}-spa-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "spa" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  comment             = "${local.name} SPA (oss flavor)"
  origin {
    domain_name              = aws_s3_bucket.spa.bucket_regional_domain_name
    origin_id                = "spa"
    origin_access_control_id = aws_cloudfront_origin_access_control.spa.id
  }
  default_cache_behavior {
    target_origin_id       = "spa"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  }
  # Rotas da SPA (/agent-platform/...) existem só no browser: 403/404 do S3 voltam o index.html.
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate { cloudfront_default_certificate = true }
  tags = local.tags
}

data "aws_iam_policy_document" "spa_bucket" {
  statement {
    sid       = "AllowCloudFrontOAC"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.spa.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.spa.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "spa" {
  bucket = aws_s3_bucket.spa.id
  policy = data.aws_iam_policy_document.spa_bucket.json
}
