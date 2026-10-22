output "vpc_id" {
  value = module.network.vpc_id
}

output "outpost_subnet_id" {
  value = module.network.outpost_subnet_id
}

output "public_subnet_id" {
  value = module.network.public_subnet_id
}

output "cluster_name" {
  value = module.cluster.cluster_name
}

output "cluster_endpoint" {
  value = module.cluster.cluster_endpoint
}

output "cluster_platform_version" {
  value = module.cluster.cluster_platform_version
}

output "cluster_status" {
  value = module.cluster.cluster_status
}

output "cluster_security_group_id" {
  value = module.cluster.cluster_security_group_id
}

output "addon_versions" {
  value = module.addons.addon_versions
}

output "ecr_mirror_role_arn" {
  value = one(aws_iam_role.ecr_mirror[*].arn)
}

output "ecr_mirror_pod_identity_association_id" {
  value = one(aws_eks_pod_identity_association.ecr_mirror[*].association_id)
}



output "harbor_helm_values" {
  value = try(var.local_registry.ip, null) == null ? null : yamlencode({
    expose = {
      clusterIP = {
        staticClusterIP = var.local_registry.ip
      }
    }
  })
}


data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

output "region" {
  value = data.aws_region.current.region
}

output "account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "outpost_arn" {
  value = var.outpost_arn
}

output "rack_generation" {
  value = var.rack_generation
}

output "local_cluster_version" {
  value = module.cluster.cluster_version
}

output "ecr_registry" {
  value = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.region}.${data.aws_partition.current.dns_suffix}"
}

output "bastion_cidr" {
  value = module.network.bastion_cidr
}

output "node_subnet_cidr" {
  value = module.network.outpost_subnet_cidr
}









output "control_plane_audit_log" {
  value = contains(module.cluster.enabled_cluster_log_types, "audit") ? "enabled" : "disabled"
}

output "crossplane_provider_role_arn" {
  value = coalesce(one(aws_iam_role.crossplane[*].arn), "disabled")
}

output "crossplane_pod_identity_association_arns" {
  value = { for k, a in aws_eks_pod_identity_association.crossplane : k => a.association_arn }
}

output "registry_service_ip" {
  value = var.local_registry == null ? null : var.local_registry.ip
}

output "kubernetes_service_ip_cidr" {
  value = "${cidrhost(module.cluster.cluster_service_cidr, 1)}/32"
}

output "cluster_dns_service_ip" {
  value = cidrhost(module.cluster.cluster_service_cidr, 10)
}
