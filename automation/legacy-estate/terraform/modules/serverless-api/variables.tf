variable "api_name" {
  description = "Name of the API and prefix for its resources"
  type        = string
}

variable "project" {
  description = "Project the API belongs to"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
}

variable "memory_size" {
  description = "Memory allocated to the handler, in MB"
  type        = number
  default     = 256
}

variable "artifact_bucket" {
  description = "Bucket holding the deployment package"
  type        = string
}
