output "api_endpoint" {
  description = "Invoke URL of the HTTP API"
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "handler_arn" {
  description = "ARN of the Lambda function behind the API"
  value       = aws_lambda_function.handler.arn
}
