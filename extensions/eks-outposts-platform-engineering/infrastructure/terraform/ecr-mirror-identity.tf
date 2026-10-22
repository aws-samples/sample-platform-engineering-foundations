locals {
  ecr_mirror_enabled   = var.ecr_mirror_identity != null
  ecr_mirror_role_name = local.ecr_mirror_enabled ? coalesce(var.ecr_mirror_identity.role_name, "${var.cluster_name}-ecr-mirror") : null
}

resource "aws_iam_role" "ecr_mirror" {
  count = local.ecr_mirror_enabled ? 1 : 0

  name = local.ecr_mirror_role_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowEksAuthToAssumeRoleForPodIdentity"
        Effect    = "Allow"
        Principal = { Service = "pods.eks.amazonaws.com" }
        Action    = ["sts:AssumeRole", "sts:TagSession"]
      },
    ]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "ecr_mirror" {
  count = local.ecr_mirror_enabled ? 1 : 0

  role       = aws_iam_role.ecr_mirror[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_eks_pod_identity_association" "ecr_mirror" {
  count = local.ecr_mirror_enabled ? 1 : 0

  cluster_name    = module.cluster.cluster_name
  namespace       = var.ecr_mirror_identity.namespace
  service_account = var.ecr_mirror_identity.service_account
  role_arn        = aws_iam_role.ecr_mirror[0].arn

  tags = var.tags

  lifecycle {
    precondition {
      condition     = var.enable_pod_identity_agent
      error_message = "Invalid input for this sample."
    }
  }

  depends_on = [aws_iam_role_policy_attachment.ecr_mirror]
}
