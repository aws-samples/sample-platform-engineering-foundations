variable "region" { default = "us-east-1" }
variable "name_prefix" {
  default     = "idp-portal"
  description = "Prefixo de todo recurso (Cognito, API, Lambdas, tabelas, bucket)."
}
variable "cluster_name" {
  type        = string
  description = "Cluster EKS da foundation que a cluster-api lê (eks:DescribeCluster)."
}
variable "cluster_endpoint" {
  type        = string
  description = "Endpoint do API server (https://...). A cluster-api exige na carga."
}
variable "cluster_ca_b64" {
  type        = string
  description = "CA do cluster em base64 (aws eks describe-cluster ... certificateAuthority.data)."
}
variable "cluster_api_vpc" {
  type        = object({ subnet_ids = list(string), security_group_ids = list(string) })
  default     = null
  description = "Só para cluster com endpoint privado: a cluster-api entra na VPC. null = sem VPC (endpoint público com allowlist)."
}
variable "platform_api_zip" { description = "backend/platform_api/build.sh" }
variable "cluster_api_zip" { description = "backend/cluster_api/build.sh" }
variable "admin_aliases" {
  type        = list(string)
  description = "Aliases (username do Cognito) com papel de admin no portal. Nunca aceita '*'."
}
variable "initial_users" {
  type        = map(string)
  default     = {}
  description = "username => e-mail. Usuários criados com senha temporária (troca no primeiro login)."
}
variable "extra_callback_urls" {
  type        = list(string)
  default     = []
  description = "Callbacks adicionais do Hosted UI, ex.: http://localhost:5173/ para o vite dev."
}
variable "extra_allowed_origins" {
  type        = list(string)
  default     = []
  description = "Origens adicionais aceitas no CORS das APIs (mesmo uso do localhost)."
}
variable "allow_password_auth" {
  type        = bool
  default     = false
  description = "Liga USER_PASSWORD_AUTH no app client, só para teste automatizado (initiate-auth). Default: SRP."
}
