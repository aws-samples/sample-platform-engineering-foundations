# Variable defaults are one of the places the transformation resolves
# identifiers from, alongside literals and terraform.tfvars.

variable "region" {
  description = "AWS region the estate lives in"
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Name prefix for every resource in the estate"
  type        = string
  default     = "payments"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "prod"
}

variable "account_suffix" {
  description = "Suffix that makes bucket names globally unique"
  type        = string
}

variable "db_instance_class" {
  description = "RDS instance class for the settlement database"
  type        = string
  default     = "db.t3.medium"
}

variable "vpc_id" {
  description = "VPC the estate was deployed into. Set out of band, which is exactly why the security group id cannot be resolved from source."
  type        = string
}

variable "application_cidrs" {
  description = "CIDRs allowed to reach Postgres"
  type        = list(string)
  default     = ["10.0.0.0/16"]
}
