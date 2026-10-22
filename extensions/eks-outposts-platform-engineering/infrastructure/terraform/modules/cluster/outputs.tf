output "cluster_name" {
  value = aws_eks_cluster.this.name
}

output "cluster_arn" {
  value = aws_eks_cluster.this.arn
}

output "cluster_endpoint" {
  value = aws_eks_cluster.this.endpoint
}

output "cluster_certificate_authority_data" {
  value = aws_eks_cluster.this.certificate_authority[0].data
}

output "cluster_security_group_id" {
  value = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
}

output "cluster_platform_version" {
  value = aws_eks_cluster.this.platform_version
}

output "cluster_status" {
  value = aws_eks_cluster.this.status
}

output "cluster_service_cidr" {
  value = aws_eks_cluster.this.kubernetes_network_config[0].service_ipv4_cidr
}

output "cluster_role_arn" {
  value = aws_eks_cluster.this.role_arn
}

output "cluster_version" {
  value = aws_eks_cluster.this.version
}

output "enabled_cluster_log_types" {
  value = aws_eks_cluster.this.enabled_cluster_log_types
}
