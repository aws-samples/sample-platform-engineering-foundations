locals {
  crossplane_identity_enabled = var.enable_crossplane_identity

  crossplane_name_prefix = "sample-plat-"
  crossplane_namespace   = "crossplane-system"
  crossplane_service_accounts = {
    s3       = "provider-aws-s3"
    dynamodb = "provider-aws-dynamodb"
  }
}

data "aws_iam_policy_document" "crossplane_trust" {
  count = local.crossplane_identity_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:eks:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:cluster/${var.cluster_name}"]
    }
  }
}

data "aws_iam_policy_document" "crossplane" {
  count = local.crossplane_identity_enabled ? 1 : 0

  statement {
    sid     = "BucketsInPrefix"
    effect  = "Allow"
    actions = ["s3:*"]
    resources = [
      "arn:${data.aws_partition.current.partition}:s3:::${local.crossplane_name_prefix}*",
      "arn:${data.aws_partition.current.partition}:s3:::${local.crossplane_name_prefix}*/*",
    ]
  }

  statement {
    sid     = "TablesInPrefix"
    effect  = "Allow"
    actions = ["dynamodb:*"]
    resources = [
      "arn:${data.aws_partition.current.partition}:dynamodb:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:table/${local.crossplane_name_prefix}*",
      "arn:${data.aws_partition.current.partition}:dynamodb:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:table/${local.crossplane_name_prefix}*/*",
    ]
  }

  statement {
    sid       = "AccountLevelReads"
    effect    = "Allow"
    actions   = ["dynamodb:ListTables", "dynamodb:DescribeLimits", "dynamodb:DescribeEndpoints", "s3:ListAllMyBuckets"]
    resources = ["*"]
  }
}

resource "aws_iam_role" "crossplane" {
  count = local.crossplane_identity_enabled ? 1 : 0

  name               = "${var.cluster_name}-crossplane-provider-aws"
  assume_role_policy = data.aws_iam_policy_document.crossplane_trust[0].json

  tags = merge(var.tags, {
    project   = "sample-platform"
    component = "provisioning-recipes"
  })
}

resource "aws_iam_role_policy" "crossplane" {
  count = local.crossplane_identity_enabled ? 1 : 0

  name   = "sample-plat-scope"
  role   = aws_iam_role.crossplane[0].id
  policy = data.aws_iam_policy_document.crossplane[0].json
}

resource "aws_eks_pod_identity_association" "crossplane" {
  for_each = local.crossplane_identity_enabled ? local.crossplane_service_accounts : {}

  cluster_name    = module.cluster.cluster_name
  namespace       = local.crossplane_namespace
  service_account = each.value
  role_arn        = aws_iam_role.crossplane[0].arn

  tags = var.tags

  lifecycle {
    precondition {
      condition     = var.enable_pod_identity_agent
      error_message = "Invalid input for this sample."
    }
  }

  depends_on = [aws_iam_role_policy.crossplane]
}
