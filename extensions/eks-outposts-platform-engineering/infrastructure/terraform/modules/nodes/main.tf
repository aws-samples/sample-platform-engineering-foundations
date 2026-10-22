data "aws_ssm_parameter" "node_ami" {
  count = var.ami_id == null ? 1 : 0

  name = "/aws/service/eks/optimized-ami/${var.kubernetes_version}/amazon-linux-2023/x86_64/standard/recommended/image_id"
}

locals {
  ami_id = coalesce(var.ami_id, one(data.aws_ssm_parameter.node_ami[*].value))

  node_role_arn             = var.create_node_role ? aws_iam_role.node[0].arn : var.node_role_arn
  iam_instance_profile_name = var.create_node_role ? aws_iam_instance_profile.node[0].name : var.node_iam_instance_profile_name

  node_role_name = var.create_node_role ? aws_iam_role.node[0].name : (
    var.node_role_arn == null ? null : reverse(split("/", var.node_role_arn))[0]
  )

  node_security_group_ids = var.create_security_group ? [aws_security_group.node[0].id] : var.security_group_ids

  kubelet_flags = [
    for key, value in var.node_labels : "--node-labels=${key}=${value}"
  ]

  registry_certs_dir = var.local_registry == null ? null : "/etc/containerd/certs.d/${var.local_registry.host}"

  registry_hosts_toml = var.local_registry == null ? null : join("\n", concat(
    [
      "server = \"https://${var.local_registry.host}\"",
      "",
      "[host.\"https://${var.local_registry.host}\"]",
      "  capabilities = [\"pull\", \"resolve\"]",
    ],
    var.local_registry.ca_pem == null ? [] : [
      "  ca = \"${local.registry_certs_dir}/ca.crt\"",
    ],
  ))

  mirror_certs_dir = try(var.local_registry.mirrored_host, null) == null ? null : "/etc/containerd/certs.d/${var.local_registry.mirrored_host}"

  mirror_hosts_toml = local.mirror_certs_dir == null ? null : join("\n", concat(
    [
      "server = \"https://${var.local_registry.mirrored_host}\"",
      "",
      "[host.\"https://${var.local_registry.host}${var.local_registry.mirror_path}\"]",
      "  capabilities = [\"pull\", \"resolve\"]",
      "  override_path = true",
    ],
    var.local_registry.ca_pem == null ? [] : [
      "  ca = \"${local.registry_certs_dir}/ca.crt\"",
    ],
  ))

  extra_mirrors = var.local_registry == null ? {} : {
    for h in try(var.local_registry.extra_mirrored_hosts, []) : "/etc/containerd/certs.d/${h}" => join("\n", concat(
      [
        "server = \"https://${h}\"",
        "",
        "[host.\"https://${var.local_registry.host}${var.local_registry.mirror_path}\"]",
        "  capabilities = [\"pull\", \"resolve\"]",
        "  override_path = true",
      ],
      var.local_registry.ca_pem == null ? [] : [
        "  ca = \"${local.registry_certs_dir}/ca.crt\"",
      ],
    ))
  }

  user_data = templatefile("${path.module}/templates/user-data.tftpl", {
    cluster_name                       = var.cluster_name
    cluster_endpoint                   = var.cluster_endpoint
    cluster_certificate_authority_data = var.cluster_certificate_authority_data
    cluster_service_cidr               = var.cluster_service_cidr
    kubelet_flags                      = local.kubelet_flags
    local_registry                     = var.local_registry
    registry_certs_dir                 = local.registry_certs_dir
    registry_hosts_toml                = local.registry_hosts_toml
    mirror_certs_dir                   = local.mirror_certs_dir
    mirror_hosts_toml                  = local.mirror_hosts_toml
    extra_mirrors                      = local.extra_mirrors
  })
}


data "aws_iam_policy_document" "node_assume_role" {
  count = var.create_node_role ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  count = var.create_node_role ? 1 : 0

  name               = "${var.cluster_name}-node-role"
  assume_role_policy = data.aws_iam_policy_document.node_assume_role[0].json

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = var.create_node_role ? toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
  ]) : toset([])

  role       = aws_iam_role.node[0].name
  policy_arn = each.value
}

resource "aws_iam_instance_profile" "node" {
  count = var.create_node_role ? 1 : 0

  name = "${var.cluster_name}-node-profile"
  role = aws_iam_role.node[0].name

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  count = var.attach_ebs_csi_policy ? 1 : 0

  role       = local.node_role_name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"

  lifecycle {
    precondition {
      condition     = local.node_role_name != null
      error_message = "Invalid input for this sample."
    }
  }
}


resource "aws_security_group" "node" {
  count = var.create_security_group ? 1 : 0

  name   = "${var.cluster_name}-node"
  vpc_id = var.vpc_id

  tags = merge(var.tags, {
    Name                                        = "${var.cluster_name}-node"
    "kubernetes.io/cluster/${var.cluster_name}" = "owned"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "node_to_node" {
  count = var.create_security_group ? 1 : 0

  security_group_id            = aws_security_group.node[0].id
  referenced_security_group_id = aws_security_group.node[0].id
  ip_protocol                  = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "cluster_to_node_kubelet" {
  count = var.create_security_group ? 1 : 0

  security_group_id            = aws_security_group.node[0].id
  referenced_security_group_id = var.cluster_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 10250
  to_port                      = 10250
}

resource "aws_vpc_security_group_ingress_rule" "cluster_to_node_https" {
  count = var.create_security_group ? 1 : 0

  security_group_id            = aws_security_group.node[0].id
  referenced_security_group_id = var.cluster_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "node_all" {
  count = var.create_security_group ? 1 : 0

  security_group_id = aws_security_group.node[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "node_to_cluster_api" {
  count = var.create_security_group ? 1 : 0

  security_group_id            = var.cluster_security_group_id
  referenced_security_group_id = aws_security_group.node[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}


resource "aws_launch_template" "node" {
  name_prefix   = "${var.cluster_name}-node-"
  image_id      = local.ami_id
  instance_type = var.instance_type
  key_name      = var.ssh_key_name

  user_data = base64encode(local.user_data)

  iam_instance_profile {
    name = local.iam_instance_profile_name
  }

  vpc_security_group_ids = local.node_security_group_ids

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = var.root_volume_size
      volume_type           = var.root_volume_type
      encrypted             = true
      delete_on_termination = true
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  monitoring {
    enabled = true
  }

  tag_specifications {
    resource_type = "instance"
    tags = merge(var.tags, {
      Name                                        = "${var.cluster_name}-node"
      "kubernetes.io/cluster/${var.cluster_name}" = "owned"
    })
  }

  tag_specifications {
    resource_type = "volume"
    tags          = var.tags
  }

  tags = var.tags

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = local.iam_instance_profile_name != null
      error_message = "Invalid input for this sample."
    }
  }
}

resource "aws_autoscaling_group" "node" {
  name_prefix         = "${var.cluster_name}-node-"
  vpc_zone_identifier = [var.outpost_subnet_id]

  desired_capacity = var.desired_size
  min_size         = var.min_size
  max_size         = var.max_size

  protect_from_scale_in = var.protect_from_scale_in

  launch_template {
    id      = aws_launch_template.node.id
    version = aws_launch_template.node.latest_version
  }

  depends_on = [aws_eks_access_entry.node]

  dynamic "tag" {
    for_each = merge(var.tags, {
      Name                                        = "${var.cluster_name}-node"
      "kubernetes.io/cluster/${var.cluster_name}" = "owned"
    })

    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_eks_access_entry" "node" {
  cluster_name  = var.cluster_name
  principal_arn = local.node_role_arn
  type          = "EC2_LINUX"

  tags = var.tags

  lifecycle {
    precondition {
      condition     = local.node_role_arn != null
      error_message = "Invalid input for this sample."
    }
  }
}
