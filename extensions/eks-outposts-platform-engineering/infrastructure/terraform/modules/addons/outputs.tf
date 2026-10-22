output "addon_versions" {
  value = merge(
    {
      "kube-proxy" = aws_eks_addon.kube_proxy.addon_version
      "coredns"    = aws_eks_addon.coredns.addon_version
    },
    var.enable_ebs_csi_driver ? {
      "aws-ebs-csi-driver" = one(aws_eks_addon.ebs_csi_driver[*].addon_version)
    } : {},
    var.enable_pod_identity_agent ? {
      "eks-pod-identity-agent" = one(aws_eks_addon.pod_identity_agent[*].addon_version)
    } : {},
    { for name, addon in aws_eks_addon.extra : name => addon.addon_version }
  )
}

output "ebs_csi_driver_enabled" {
  value = var.enable_ebs_csi_driver
}



output "coredns_configuration_values" {
  value = lookup(var.core_addon_configuration_values, "coredns", null)
}

output "extra_addon_configuration_values" {
  value = { for name, addon in var.extra_addons : name => addon.configuration_values }
}
