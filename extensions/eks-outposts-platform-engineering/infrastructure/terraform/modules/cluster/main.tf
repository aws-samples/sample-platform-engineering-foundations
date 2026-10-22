locals {
  role_arn = var.create_cluster_role ? aws_iam_role.cluster[0].arn : var.cluster_role_arn
}

data "aws_iam_policy_document" "cluster_assume_role" {
  count = var.create_cluster_role ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  count = var.create_cluster_role ? 1 : 0

  name               = "${var.cluster_name}-cluster-role"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume_role[0].json

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  for_each = var.create_cluster_role ? toset([
    "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    "arn:aws:iam::aws:policy/AmazonEKSLocalOutpostClusterPolicy",
  ]) : toset([])

  role       = aws_iam_role.cluster[0].name
  policy_arn = each.value
}

resource "aws_eks_cluster" "this" {
  name     = var.cluster_name
  version  = var.kubernetes_version
  role_arn = local.role_arn

  vpc_config {
    subnet_ids              = var.subnet_ids
    endpoint_private_access = var.endpoint_private_access
    endpoint_public_access  = var.endpoint_public_access
  }

  access_config {
    authentication_mode                         = var.authentication_mode
    bootstrap_cluster_creator_admin_permissions = var.bootstrap_cluster_creator_admin_permissions
  }

  outpost_config {
    outpost_arns                = [var.outpost_arn]
    control_plane_instance_type = var.control_plane_instance_type
    etcd_instance_type          = var.etcd_instance_type

    dynamic "control_plane_placement" {
      for_each = var.spread_level == null ? [] : [var.spread_level]
      content {
        spread_level = control_plane_placement.value
      }
    }

    dynamic "etcd_placement" {
      for_each = var.spread_level == null ? [] : [var.spread_level]
      content {
        spread_level = etcd_placement.value
      }
    }
  }

  enabled_cluster_log_types = var.enabled_cluster_log_types

  timeouts {
    create = var.cluster_create_timeout
  }

  tags = var.tags

  lifecycle {
    precondition {
      condition     = local.role_arn != null
      error_message = "Invalid input for this sample."
    }
  }
}
