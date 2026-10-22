variable "aws_region" {
  type = string
}

variable "aws_profile" {
  type    = string
  default = null
}

variable "shared_config_files" {
  type    = list(string)
  default = null

  validation {
    condition = alltrue([
      for f in(var.shared_config_files == null ? [] : var.shared_config_files) : fileexists(pathexpand(f))
    ])
    error_message = "Invalid input for this sample."
  }
}

variable "expected_account_id" {
  type = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Invalid input for this sample."
  }
}

variable "name" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "kubernetes_version" {
  type = string
}

variable "outpost_arn" {
  type = string
}

variable "availability_zone" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "public_subnet_cidr" {
  type = string
}

variable "outpost_subnet_cidr" {
  type = string
}

variable "control_plane_instance_type" {
  type = string
}

variable "etcd_instance_type" {
  type = string
}

variable "spread_level" {
  type    = string
  default = null
}

variable "cluster_role_arn" {
  type    = string
  default = null
}

variable "create_cluster_role" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}


variable "node_instance_type" {
  type = string

}

variable "node_desired_size" {
  type    = number
  default = 2
}

variable "node_min_size" {
  type    = number
  default = 2
}

variable "node_max_size" {
  type    = number
  default = 4
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

variable "node_create_security_group" {
  type    = bool
  default = true
}

variable "node_attach_ebs_csi_policy" {
  type    = bool
  default = true
}

variable "node_protect_from_scale_in" {
  type    = bool
  default = true
}





variable "enable_ebs_csi_driver" {
  type    = bool
  default = true
}

variable "addon_versions" {
  type    = map(string)
  default = {}
}

variable "enable_pod_identity_agent" {
  type    = bool
  default = true
}

variable "ecr_mirror_identity" {
  type = object({
    role_name       = optional(string)
    namespace       = optional(string, "registry-local")
    service_account = optional(string, "ecr-mirror")
  })
  default = null
}

variable "extra_addons" {
  type = map(object({
    version              = optional(string)
    configuration_values = optional(string)
  }))
  default = {}
}

variable "core_addon_configuration_values" {
  type    = map(string)
  default = {}
}

variable "coredns_configuration_values_file" {
  type    = string
  default = null

  validation {
    condition     = var.coredns_configuration_values_file == null || can(jsondecode(file(var.coredns_configuration_values_file)).corefile)
    error_message = "Invalid input for this sample."
  }
  validation {
    condition     = var.coredns_configuration_values_file == null || !contains(keys(var.core_addon_configuration_values), "coredns")
    error_message = "Invalid input for this sample."
  }
}

variable "fluent_bit_configuration_values_file" {
  type    = string
  default = null

  validation {
    condition     = var.fluent_bit_configuration_values_file == null || can(jsondecode(file(var.fluent_bit_configuration_values_file)))
    error_message = "Invalid input for this sample."
  }
  validation {
    condition     = var.fluent_bit_configuration_values_file == null || contains(keys(var.extra_addons), "fluent-bit")
    error_message = "Invalid input for this sample."
  }
  validation {
    condition     = var.fluent_bit_configuration_values_file == null || try(var.extra_addons["fluent-bit"].configuration_values, null) == null
    error_message = "Invalid input for this sample."
  }
}


variable "node_ami_id" {
  type    = string
  default = null
}

variable "local_registry" {

  type = object({
    host                 = string
    ip                   = optional(string)
    ca_cert_file         = optional(string)
    mirrored_host        = optional(string)
    mirror_path          = optional(string, "/v2/ecr")
    extra_mirrored_hosts = optional(list(string), [])
  })
  default = null
}


variable "rack_generation" {
  type    = string
  default = "gen1"

  validation {
    condition     = contains(["gen1", "gen2"], var.rack_generation)
    error_message = "Invalid input for this sample."
  }
}

variable "bastion_cidr" {
  type    = string
  default = null
}


variable "enable_audit_log" {
  type    = bool
  default = false
}

variable "enable_crossplane_identity" {
  type    = bool
  default = false
}
