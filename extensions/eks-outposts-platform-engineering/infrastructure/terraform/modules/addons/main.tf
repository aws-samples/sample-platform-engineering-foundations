locals {
  kube_proxy_version         = lookup(var.addon_versions, "kube-proxy", null)
  coredns_version            = lookup(var.addon_versions, "coredns", null)
  ebs_csi_version            = lookup(var.addon_versions, "aws-ebs-csi-driver", null)
  pod_identity_agent_version = lookup(var.addon_versions, "eks-pod-identity-agent", null)
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name  = var.cluster_name
  addon_name    = "kube-proxy"
  addon_version = local.kube_proxy_version

  configuration_values = lookup(var.core_addon_configuration_values, "kube-proxy", null)

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"

  timeouts {
    create = var.create_timeout
  }

  tags = var.tags
}

resource "aws_eks_addon" "coredns" {
  cluster_name  = var.cluster_name
  addon_name    = "coredns"
  addon_version = local.coredns_version

  configuration_values = lookup(var.core_addon_configuration_values, "coredns", null)

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"

  timeouts {
    create = var.create_timeout
  }

  tags = var.tags
}

resource "aws_eks_addon" "ebs_csi_driver" {
  count = var.enable_ebs_csi_driver ? 1 : 0

  cluster_name  = var.cluster_name
  addon_name    = "aws-ebs-csi-driver"
  addon_version = local.ebs_csi_version

  configuration_values = lookup(var.core_addon_configuration_values, "aws-ebs-csi-driver", null)

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"

  timeouts {
    create = var.create_timeout
  }

  tags = var.tags
}

resource "aws_eks_addon" "pod_identity_agent" {
  count = var.enable_pod_identity_agent ? 1 : 0

  cluster_name  = var.cluster_name
  addon_name    = "eks-pod-identity-agent"
  addon_version = local.pod_identity_agent_version

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"

  timeouts {
    create = var.create_timeout
  }

  tags = var.tags
}

resource "aws_eks_addon" "extra" {
  for_each = var.extra_addons

  cluster_name  = var.cluster_name
  addon_name    = each.key
  addon_version = each.value.version

  configuration_values = each.value.configuration_values

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"

  timeouts {
    create = var.create_timeout
  }

  tags = var.tags
}
