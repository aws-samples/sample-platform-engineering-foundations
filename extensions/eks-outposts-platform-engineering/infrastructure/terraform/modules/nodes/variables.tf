variable "cluster_name" {
  type = string
}

variable "cluster_endpoint" {
  type = string
}

variable "cluster_certificate_authority_data" {
  type = string
}

variable "cluster_service_cidr" {
  type = string
}

variable "kubernetes_version" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "outpost_subnet_id" {
  type = string
}

variable "cluster_security_group_id" {
  type = string
}

variable "create_security_group" {
  type    = bool
  default = true
}

variable "security_group_ids" {
  type    = list(string)
  default = []

  validation {
    condition     = var.create_security_group || length(var.security_group_ids) > 0
    error_message = "Invalid input for this sample."
  }
}

variable "instance_type" {
  type = string
}

variable "ami_id" {
  type    = string
  default = null
}

variable "desired_size" {
  type    = number
  default = 2
}

variable "min_size" {
  type    = number
  default = 2
}

variable "max_size" {
  type    = number
  default = 4
}

variable "protect_from_scale_in" {
  type    = bool
  default = true
}

variable "root_volume_size" {
  type    = number
  default = 100
}

variable "root_volume_type" {
  type    = string
  default = "gp2"
}

variable "node_role_arn" {
  type    = string
  default = null
}

variable "node_iam_instance_profile_name" {
  type    = string
  default = null
}

variable "create_node_role" {
  type    = bool
  default = false
}

variable "attach_ebs_csi_policy" {
  type    = bool
  default = true
}

variable "ssh_key_name" {
  type    = string
  default = null
}

variable "node_labels" {
  type    = map(string)
  default = {}
}

variable "local_registry" {

  type = object({
    host                 = string
    ip                   = optional(string)
    ca_pem               = optional(string)
    mirrored_host        = optional(string)
    mirror_path          = optional(string, "/v2/ecr")
    extra_mirrored_hosts = optional(list(string), [])
  })
  default = null

  validation {
    condition     = var.local_registry == null ? true : length(trimspace(var.local_registry.host)) > 0
    error_message = "Invalid input for this sample."
  }

  validation {
    condition     = try(var.local_registry.mirrored_host, null) == null ? true : can(regex("^/v2(/[a-z0-9._-]+)*$", var.local_registry.mirror_path))
    error_message = "Invalid input for this sample."
  }

  validation {
    condition     = try(var.local_registry.ca_pem, null) == null ? true : can(regex("-----BEGIN CERTIFICATE-----", var.local_registry.ca_pem))
    error_message = "Invalid input for this sample."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
