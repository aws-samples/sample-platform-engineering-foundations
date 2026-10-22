output "node_security_group_id" {
  value = one(aws_security_group.node[*].id)
}

output "node_security_group_ids" {
  value = local.node_security_group_ids
}

output "launch_template_id" {
  value = aws_launch_template.node.id
}

output "launch_template_latest_version" {
  value = aws_launch_template.node.latest_version
}

output "autoscaling_group_name" {
  value = aws_autoscaling_group.node.name
}

output "node_ami_id" {
  value = local.ami_id
}

output "node_role_arn" {
  value = local.node_role_arn
}
