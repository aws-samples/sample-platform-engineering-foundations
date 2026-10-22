variable "cluster_name" {
  type = string
}

variable "kubernetes_version" {
  type = string

  validation {
    condition     = can(regex("^1\\.[0-9]{2}$", var.kubernetes_version))
    error_message = "Invalid input for this sample."
  }
}

variable "subnet_ids" {
  type = list(string)

  validation {
    condition     = length(var.subnet_ids) > 0
    error_message = "Invalid input for this sample."
  }
}

variable "outpost_arn" {
  type = string
}

variable "control_plane_instance_type" {
  type = string
}

variable "etcd_instance_type" {
  type = string
}

variable "cluster_role_arn" {
  type    = string
  default = null
}

variable "create_cluster_role" {
  type    = bool
  default = false
}

variable "endpoint_private_access" {
  type    = bool
  default = true
}

variable "endpoint_public_access" {
  type    = bool
  default = false
}

variable "authentication_mode" {
  type    = string
  default = "API_AND_CONFIG_MAP"

  validation {
    condition     = contains(["API", "API_AND_CONFIG_MAP", "CONFIG_MAP"], var.authentication_mode)
    error_message = "Invalid input for this sample."
  }
}

variable "bootstrap_cluster_creator_admin_permissions" {
  type    = bool
  default = true
}

variable "spread_level" {
  type    = string
  default = null

  validation {
    condition     = var.spread_level == null || contains(["host", "rack"], coalesce(var.spread_level, "host"))
    error_message = "Invalid input for this sample."
  }
}

variable "cluster_create_timeout" {
  type    = string
  default = "45m"
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "enabled_cluster_log_types" {
  type    = list(string)
  default = []

  validation {
    condition     = alltrue([for t in var.enabled_cluster_log_types : contains(["api", "audit", "authenticator", "controllerManager", "scheduler"], t)])
    error_message = "Invalid input for this sample."
  }
}
