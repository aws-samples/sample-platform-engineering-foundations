variable "cluster_name" {
  type = string
}


variable "enable_ebs_csi_driver" {
  type    = bool
  default = true
}

variable "enable_pod_identity_agent" {
  type    = bool
  default = false
}

variable "addon_versions" {
  type    = map(string)
  default = {}

  validation {
    condition     = length(setsubtract(keys(var.addon_versions), ["kube-proxy", "coredns", "aws-ebs-csi-driver", "eks-pod-identity-agent"])) == 0
    error_message = "Invalid input for this sample."
  }
}

variable "core_addon_configuration_values" {
  type    = map(string)
  default = {}

  validation {
    condition     = length(setsubtract(keys(var.core_addon_configuration_values), ["kube-proxy", "coredns", "aws-ebs-csi-driver"])) == 0
    error_message = "Invalid input for this sample."
  }

  validation {
    condition     = alltrue([for v in values(var.core_addon_configuration_values) : can(jsondecode(v))])
    error_message = "Invalid input for this sample."
  }
}

variable "create_timeout" {
  type    = string
  default = "20m"
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "extra_addons" {
  type = map(object({
    version              = optional(string)
    configuration_values = optional(string)
  }))
  default = {}

  validation {
    condition     = length(setintersection(keys(var.extra_addons), ["vpc-cni", "kube-proxy", "coredns", "aws-ebs-csi-driver", "eks-pod-identity-agent"])) == 0
    error_message = "Invalid input for this sample."
  }
}
