module "network" {
  source = "./modules/network"

  name                = var.name
  outpost_arn         = var.outpost_arn
  availability_zone   = var.availability_zone
  vpc_cidr            = var.vpc_cidr
  public_subnet_cidr  = var.public_subnet_cidr
  outpost_subnet_cidr = var.outpost_subnet_cidr



  tags = var.tags
}

module "cluster" {
  source = "./modules/cluster"

  cluster_name       = var.cluster_name
  kubernetes_version = var.kubernetes_version

  subnet_ids  = [module.network.outpost_subnet_id]
  outpost_arn = var.outpost_arn

  control_plane_instance_type = var.control_plane_instance_type
  etcd_instance_type          = var.etcd_instance_type
  spread_level                = var.spread_level

  cluster_role_arn    = var.cluster_role_arn
  create_cluster_role = var.create_cluster_role

  enabled_cluster_log_types = var.enable_audit_log ? ["audit"] : []

  tags = var.tags
}

module "nodes" {
  source = "./modules/nodes"

  cluster_name                       = module.cluster.cluster_name
  cluster_endpoint                   = module.cluster.cluster_endpoint
  cluster_certificate_authority_data = module.cluster.cluster_certificate_authority_data
  cluster_service_cidr               = module.cluster.cluster_service_cidr
  cluster_security_group_id          = module.cluster.cluster_security_group_id
  kubernetes_version                 = var.kubernetes_version

  ami_id = var.node_ami_id

  vpc_id            = module.network.vpc_id
  outpost_subnet_id = module.network.outpost_subnet_id

  create_security_group = var.node_create_security_group
  security_group_ids    = var.node_create_security_group ? [] : [module.cluster.cluster_security_group_id]

  instance_type = var.node_instance_type
  desired_size  = var.node_desired_size
  min_size      = var.node_min_size
  max_size      = var.node_max_size

  protect_from_scale_in = var.node_protect_from_scale_in

  node_role_arn                  = var.node_role_arn
  node_iam_instance_profile_name = var.node_iam_instance_profile_name
  create_node_role               = var.create_node_role

  attach_ebs_csi_policy = var.node_attach_ebs_csi_policy

  local_registry = var.local_registry == null ? null : {
    host                 = var.local_registry.host
    ip                   = var.local_registry.ip
    ca_pem               = var.local_registry.ca_cert_file == null ? null : file(var.local_registry.ca_cert_file)
    mirrored_host        = var.local_registry.mirrored_host
    mirror_path          = var.local_registry.mirror_path
    extra_mirrored_hosts = var.local_registry.extra_mirrored_hosts
  }

  tags = var.tags
}

module "addons" {
  source = "./modules/addons"

  cluster_name = module.cluster.cluster_name

  addon_versions = var.addon_versions

  extra_addons = {
    for name, addon in var.extra_addons : name => {
      version = addon.version
      configuration_values = (
        name == "fluent-bit" && var.fluent_bit_configuration_values_file != null
        ? chomp(file(var.fluent_bit_configuration_values_file))
        : addon.configuration_values
      )
    }
  }

  core_addon_configuration_values = merge(
    var.core_addon_configuration_values,
    var.coredns_configuration_values_file == null ? {} : { coredns = chomp(file(var.coredns_configuration_values_file)) }
  )

  enable_ebs_csi_driver = var.enable_ebs_csi_driver

  enable_pod_identity_agent = var.enable_pod_identity_agent

  tags = var.tags

  depends_on = [module.nodes]
}
