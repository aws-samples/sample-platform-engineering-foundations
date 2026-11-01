locals {
  crossplane_identity_enabled = var.enable_crossplane_identity

  crossplane_name_prefix = "sample-plat-"
  crossplane_namespace   = "crossplane-system"
  crossplane_service_accounts = {
    s3       = "provider-aws-s3"
    dynamodb = "provider-aws-dynamodb"
  }

  crossplane_serverless_service_accounts = {
    lambda         = "provider-aws-lambda"
    apigateway     = "provider-aws-apigateway"
    cloudfront     = "provider-aws-cloudfront"
    cloudwatchlogs = "provider-aws-cloudwatchlogs"
  }
  crossplane_serverless_policies = {
    lambda         = data.aws_iam_policy_document.crossplane_serverless_lambda.json
    apigateway     = data.aws_iam_policy_document.crossplane_serverless_apigateway.json
    cloudfront     = data.aws_iam_policy_document.crossplane_serverless_cloudfront.json
    cloudwatchlogs = data.aws_iam_policy_document.crossplane_serverless_cloudwatchlogs.json
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

  lifecycle {
    precondition {
      condition     = length(var.cluster_name) <= 38
      error_message = "Invalid input for this sample."
    }
  }
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

data "aws_iam_policy_document" "serverless_runtime_trust" {
  statement {
    sid     = "LambdaService"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "serverless_runtime" {
  statement {
    sid     = "RecipeTables"
    effect  = "Allow"
    actions = ["dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:UpdateItem"]
    resources = [
      "arn:${data.aws_partition.current.partition}:dynamodb:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:table/${local.crossplane_name_prefix}*",
      "arn:${data.aws_partition.current.partition}:dynamodb:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:table/${local.crossplane_name_prefix}*/index/*",
    ]
  }

  statement {
    sid     = "RecipeLogs"
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.crossplane_name_prefix}*:*",
    ]
  }
}

data "aws_iam_policy_document" "crossplane_serverless_lambda" {
  statement {
    sid     = "FunctionsInPrefix"
    effect  = "Allow"
    actions = ["lambda:CreateFunction", "lambda:DeleteFunction", "lambda:GetFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:GetFunctionConfiguration", "lambda:GetPolicy", "lambda:ListTags", "lambda:ListVersionsByFunction", "lambda:TagResource", "lambda:UntagResource", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration"]
    resources = [
      "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${local.crossplane_name_prefix}*",
      "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${local.crossplane_name_prefix}*:*",
    ]
  }

  statement {
    sid     = "InvokePermissionForApiGateway"
    effect  = "Allow"
    actions = ["lambda:AddPermission", "lambda:RemovePermission"]
    resources = [
      "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${local.crossplane_name_prefix}*",
      "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${local.crossplane_name_prefix}*:*",
    ]

    condition {
      test     = "StringEquals"
      variable = "lambda:Principal"
      values   = ["apigateway.amazonaws.com"]
    }
  }

  statement {
    sid       = "ReadCodeInPrefix"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${local.crossplane_name_prefix}*/*"]
  }

  statement {
    sid       = "PassRuntimeRoleToLambda"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${local.crossplane_name_prefix}runtime-${var.cluster_name}"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "crossplane_serverless_apigateway" {
  statement {
    sid       = "CreateTaggedRestApis"
    effect    = "Allow"
    actions   = ["apigateway:POST"]
    resources = ["arn:${data.aws_partition.current.partition}:apigateway:${data.aws_region.current.region}::/restapis"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/platform"
      values   = ["sample-plat"]
    }
  }

  statement {
    sid     = "ReadRestApis"
    effect  = "Allow"
    actions = ["apigateway:GET"]
    resources = [
      "arn:${data.aws_partition.current.partition}:apigateway:${data.aws_region.current.region}::/restapis",
      "arn:${data.aws_partition.current.partition}:apigateway:${data.aws_region.current.region}::/restapis/*",
      "arn:${data.aws_partition.current.partition}:apigateway:${data.aws_region.current.region}::/tags/*",
    ]
  }

  statement {
    sid       = "ManageTaggedRestApis"
    effect    = "Allow"
    actions   = ["apigateway:DELETE", "apigateway:PATCH", "apigateway:POST", "apigateway:PUT"]
    resources = ["arn:${data.aws_partition.current.partition}:apigateway:${data.aws_region.current.region}::/restapis/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/platform"
      values   = ["sample-plat"]
    }
  }

  statement {
    sid     = "TagRecipeRestApis"
    effect  = "Allow"
    actions = ["apigateway:DELETE", "apigateway:PUT"]
    resources = [
      "arn:${data.aws_partition.current.partition}:apigateway:${data.aws_region.current.region}::/tags/*",
    ]
  }
}

data "aws_iam_policy_document" "crossplane_serverless_cloudfront" {
  statement {
    sid       = "CreateTaggedDistribution"
    effect    = "Allow"
    actions   = ["cloudfront:CreateDistribution"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/platform"
      values   = ["sample-plat"]
    }
  }

  statement {
    sid       = "ObserveDistributions"
    effect    = "Allow"
    actions   = ["cloudfront:GetDistribution", "cloudfront:ListTagsForResource"]
    resources = ["arn:${data.aws_partition.current.partition}:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/*"]
  }

  statement {
    sid       = "ManageTaggedDistributions"
    effect    = "Allow"
    actions   = ["cloudfront:DeleteDistribution", "cloudfront:TagResource", "cloudfront:UntagResource", "cloudfront:UpdateDistribution"]
    resources = ["arn:${data.aws_partition.current.partition}:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/platform"
      values   = ["sample-plat"]
    }
  }
}

data "aws_iam_policy_document" "crossplane_serverless_cloudwatchlogs" {
  statement {
    sid     = "FunctionLogGroupsInPrefix"
    effect  = "Allow"
    actions = ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:ListTagsForResource", "logs:PutRetentionPolicy", "logs:TagLogGroup", "logs:TagResource", "logs:UntagResource"]
    resources = [
      "arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.crossplane_name_prefix}*",
      "arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.crossplane_name_prefix}*:*",
    ]
  }

  statement {
    sid       = "AccountLevelReads"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role" "serverless_runtime" {
  count = local.crossplane_identity_enabled ? 1 : 0

  name               = "${local.crossplane_name_prefix}runtime-${var.cluster_name}"
  description        = "Execution role shared by the functions of the serverless multi-tier recipe."
  assume_role_policy = data.aws_iam_policy_document.serverless_runtime_trust.json

  tags = merge(var.tags, {
    project   = "sample-platform"
    component = "provisioning-recipes"
  })
}

resource "aws_iam_role_policy" "serverless_runtime" {
  count = local.crossplane_identity_enabled ? 1 : 0

  name   = "sample-plat-runtime"
  role   = aws_iam_role.serverless_runtime[0].id
  policy = data.aws_iam_policy_document.serverless_runtime.json
}

resource "aws_cloudfront_origin_access_control" "serverless" {
  count = local.crossplane_identity_enabled ? 1 : 0

  name                              = "${local.crossplane_name_prefix}spa-${var.cluster_name}"
  description                       = "Origin access control shared by the static sites of the serverless multi-tier recipe."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_iam_role" "crossplane_serverless" {
  for_each = local.crossplane_identity_enabled ? local.crossplane_serverless_service_accounts : {}

  name               = "${var.cluster_name}-crossplane-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.crossplane_trust[0].json

  tags = merge(var.tags, {
    project   = "sample-platform"
    component = "provisioning-recipes"
  })
}

resource "aws_iam_role_policy" "crossplane_serverless" {
  for_each = local.crossplane_identity_enabled ? local.crossplane_serverless_service_accounts : {}

  name   = "sample-plat-${each.key}"
  role   = aws_iam_role.crossplane_serverless[each.key].id
  policy = local.crossplane_serverless_policies[each.key]
}

resource "aws_eks_pod_identity_association" "crossplane_serverless" {
  for_each = local.crossplane_identity_enabled ? local.crossplane_serverless_service_accounts : {}

  cluster_name    = module.cluster.cluster_name
  namespace       = local.crossplane_namespace
  service_account = each.value
  role_arn        = aws_iam_role.crossplane_serverless[each.key].arn

  tags = var.tags

  lifecycle {
    precondition {
      condition     = var.enable_pod_identity_agent
      error_message = "Invalid input for this sample."
    }
  }

  depends_on = [aws_iam_role_policy.crossplane_serverless]
}
