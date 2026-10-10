output "ledger_archive_bucket" {
  description = "Bucket holding the immutable ledger archive"
  value       = aws_s3_bucket.ledger_archive.bucket
}

output "settlement_db_endpoint" {
  description = "Postgres endpoint for the settlement engine"
  value       = aws_db_instance.settlement.endpoint
}

output "refunds_api_endpoint" {
  description = "HTTP endpoint of the refunds API"
  value       = module.refunds_api.api_endpoint
}
