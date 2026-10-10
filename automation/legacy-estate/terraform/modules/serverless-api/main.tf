# =============================================================================
# serverless-api module
# =============================================================================
# A reusable unit: a Lambda function behind an HTTP API, with its own execution
# role. Instantiated once per API in the estate.
#
# This shape is why the transformation emits a kro ResourceGraphDefinition here
# instead of loose manifests. The module inputs become the RGD schema.spec, the
# outputs become schema.status, and the references between resources become CEL
# expressions.
# =============================================================================

resource "aws_iam_role" "handler" {
  name = "${var.api_name}-handler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "handler_basic" {
  role       = aws_iam_role.handler.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "handler" {
  function_name = "${var.api_name}-handler"
  role          = aws_iam_role.handler.arn
  runtime       = "python3.13"
  handler       = "app.handler"
  memory_size   = var.memory_size
  timeout       = 30

  s3_bucket = var.artifact_bucket
  s3_key    = "lambda/${var.api_name}-handler.zip"

  environment {
    variables = {
      ENVIRONMENT = var.environment
      PROJECT     = var.project
    }
  }
}

resource "aws_apigatewayv2_api" "this" {
  name          = var.api_name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "handler" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.handler.arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "POST /refunds"
  target    = "integrations/${aws_apigatewayv2_integration.handler.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
}
