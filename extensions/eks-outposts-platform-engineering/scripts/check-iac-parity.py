#!/usr/bin/env python3
"""Check CloudFormation and Terraform parity without AWS credentials or state."""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

CONTRACT_KEYS = {
    "cluster_name",
    "aws_region",
    "account_id",
    "outpost_arn",
    "kubernetes_version",
    "registry_service_ip",
    "node_subnet_cidr",
    "bastion_subnet_cidr",
    "kubernetes_service_ip_cidr",
    "cluster_dns_service_ip",
    "ebs_csi_controller_credential_cidr",
    "gitea_repo",
}
TF_TOKENS = {
    "${data.aws_partition.current.partition}": "${AWS::Partition}",
    "${data.aws_region.current.region}": "${AWS::Region}",
    "${data.aws_caller_identity.current.account_id}": "${AWS::AccountId}",
    "${local.crossplane_name_prefix}": "${NamePrefix}",
    "${var.cluster_name}": "${ClusterName}",
}


class CfnLoader(yaml.SafeLoader):
    pass


def tagged(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    return {suffix: value}


CfnLoader.add_multi_constructor("!", tagged)


def load_cfn(path):
    return yaml.load(path.read_text(encoding="utf-8"), Loader=CfnLoader)


def balanced(text, start):
    depth, quoted, index = 0, False, start
    while index < len(text):
        char = text[index]
        if quoted:
            if char == "\\":
                index += 1
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1:index]
        index += 1
    raise ValueError("unclosed HCL block")


def blocks(text, header):
    return [balanced(text, match.end() - 1) for match in re.finditer(header + r"\s*\{", text)]


def top_level(body):
    output, cursor = [], 0
    for match in re.finditer(r"\b[a-z_]+\s*\{", body):
        if match.start() < cursor:
            continue
        output.append(body[cursor:match.start()])
        cursor = match.end() - 1 + len(balanced(body, match.end() - 1)) + 2
    output.append(body[cursor:])
    return "".join(output)


def hcl_string(body, key):
    match = re.search(r'^\s*' + key + r'\s*=\s*"((?:[^"\\]|\\.)*)"\s*$', top_level(body), re.M)
    return match.group(1) if match else None


def hcl_list(body, key):
    flat = top_level(body)
    match = re.search(r'^\s*' + key + r'\s*=\s*\[', flat, re.M)
    if not match:
        return None
    inner = flat[match.end():flat.index("]", match.end())]
    return ["${" + expression + "}" if expression else literal
            for literal, expression in re.findall(r'"((?:[^"\\]|\\.)*)"|([A-Za-z_][\w.\[\]]*)', inner)]


def normalize_tf(value, findings, location):
    for source, target in TF_TOKENS.items():
        value = value.replace(source, target)
    leftovers = re.findall(r"\$\{(?!AWS::|NamePrefix\}|ClusterName\})[^}]*\}", value)
    for token in leftovers:
        findings.append(f"Terraform interpolation has no CloudFormation mapping at {location}: {token}")
    return value


def normalize_cfn(value):
    if isinstance(value, dict) and "Sub" in value:
        return value["Sub"]
    if isinstance(value, dict) and "Ref" in value:
        return "${" + value["Ref"] + "}"
    return value


def as_list(value):
    return [normalize_cfn(item) for item in (value if isinstance(value, list) else [value])]


def cfn_statements(document):
    result = {}
    for statement in document["Statement"]:
        conditions = {}
        for test, entries in (statement.get("Condition") or {}).items():
            for variable, values in entries.items():
                conditions[(test, variable)] = sorted(as_list(values))
        result[statement.get("Sid", "")] = {
            "effect": statement["Effect"],
            "actions": sorted(as_list(statement["Action"])),
            "resources": sorted(as_list(statement["Resource"])) if "Resource" in statement else None,
            "principals": sorted(as_list(statement["Principal"]["Service"])) if "Principal" in statement else None,
            "conditions": conditions,
        }
    return result


def tf_statements(document, findings, location):
    result = {}
    for statement in blocks(document, r"\bstatement"):
        conditions = {}
        for condition in blocks(statement, r"\bcondition"):
            values = hcl_list(condition, "values") or []
            conditions[(hcl_string(condition, "test"), hcl_string(condition, "variable"))] = sorted(
                normalize_tf(value, findings, location) for value in values
            )
        principal_blocks = blocks(statement, r"\bprincipals")
        if principal_blocks and hcl_string(principal_blocks[0], "type") != "Service":
            findings.append("Terraform Crossplane trust principal type is not Service")
        resources = hcl_list(statement, "resources")
        result[hcl_string(statement, "sid") or ""] = {
            "effect": hcl_string(statement, "effect"),
            "actions": sorted(hcl_list(statement, "actions") or []),
            "resources": sorted(normalize_tf(value, findings, location) for value in resources) if resources is not None else None,
            "principals": sorted(hcl_list(principal_blocks[0], "identifiers") or []) if principal_blocks else None,
            "conditions": conditions,
        }
    return result


def write_fake_commands(directory):
    account_expression = "'1' * 12"
    outpost_expression = "'a' * 17"
    terraform = directory / "terraform"
    terraform.write_text(
        "#!/usr/bin/env python3\n"
        "import json\n"
        f"account = {account_expression}\n"
        f"outpost = {outpost_expression}\n"
        "values = {\n"
        " 'cluster_name':'platform-outposts', 'region':'us-west-2', 'account_id':account,\n"
        " 'outpost_arn':f'arn:aws:outposts:us-west-2:{account}:outpost/op-{outpost}',\n"
        " 'local_cluster_version':'1.35', 'registry_service_ip':'172.20.0.20',\n"
        " 'node_subnet_cidr':'10.40.1.0/24', 'bastion_cidr':'10.40.0.0/24',\n"
        " 'kubernetes_service_ip_cidr':'172.20.0.1/32', 'cluster_dns_service_ip':'172.20.0.10'}\n"
        "print(json.dumps({key:{'value':value} for key,value in values.items()}))\n",
        encoding="utf-8",
    )
    aws = directory / "aws"
    aws.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        f"account = {account_expression}\n"
        f"outpost = {outpost_expression}\n"
        "if sys.argv[1:3] == ['cloudformation','describe-stacks']:\n"
        " stack = sys.argv[sys.argv.index('--stack-name') + 1]\n"
        " values = ({'Region':'us-west-2','AccountId':account,\n"
        "  'OutpostArn':f'arn:aws:outposts:us-west-2:{account}:outpost/op-{outpost}',\n"
        "  'NodeSubnetCidr':'10.40.1.0/24','BastionCidr':'10.40.0.0/24'} if stack == 'network' else\n"
        "  {'ClusterName':'platform-outposts','LocalClusterVersion':'1.35'})\n"
        " print(json.dumps({'Stacks':[{'Outputs':[{'OutputKey':key,'OutputValue':value} for key,value in values.items()]}]}))\n"
        "elif sys.argv[1:3] == ['eks','describe-cluster']:\n"
        " print(json.dumps({'cluster':{'kubernetesNetworkConfig':{'serviceIpv4Cidr':'172.20.0.0/16'}}}))\n"
        "else:\n"
        " raise SystemExit('unexpected fake AWS command')\n",
        encoding="utf-8",
    )
    terraform.chmod(0o755)
    aws.chmod(0o755)


def emitted_contracts(root, findings):
    emitter = root / "scripts" / "emit-contract.py"
    with tempfile.TemporaryDirectory() as temporary:
        bin_path = Path(temporary)
        write_fake_commands(bin_path)
        environment = dict(os.environ)
        environment["PATH"] = str(bin_path) + os.pathsep + environment.get("PATH", "")
        terraform = subprocess.run(
            [sys.executable, str(emitter), "terraform", "--directory", str(root / "infrastructure" / "terraform")],
            check=True,
            capture_output=True,
            text=True,
            env=environment,
        )
        cloudformation = subprocess.run(
            [sys.executable, str(emitter), "cloudformation", "--region", "us-west-2",
             "--network-stack", "network", "--cluster-stack", "cluster",
             "--registry-service-ip", "172.20.0.20"],
            check=True,
            capture_output=True,
            text=True,
            env=environment,
        )
    contracts = [json.loads(terraform.stdout), json.loads(cloudformation.stdout)]
    for name, contract in zip(("Terraform", "CloudFormation"), contracts):
        if contract.get("ebs_csi_controller_credential_cidr") != IMDS_CIDR:
            findings.append(f"{name} contract does not point the EBS CSI controller at the instance profile endpoint {IMDS_CIDR}")
    for name, contract in zip(("Terraform", "CloudFormation"), contracts):
        if set(contract) != CONTRACT_KEYS:
            findings.append(f"{name} contract keys differ: {sorted(set(contract) ^ CONTRACT_KEYS)}")
    if contracts[0] != contracts[1]:
        for key in sorted(CONTRACT_KEYS):
            if contracts[0].get(key) != contracts[1].get(key):
                findings.append(f"Contract value differs for {key}: Terraform={contracts[0].get(key)!r} CloudFormation={contracts[1].get(key)!r}")


def check_structure(root, findings):
    cfn = root / "infrastructure" / "cloudformation"
    terraform = root / "infrastructure" / "terraform"
    deploy = (cfn / "deploy.sh").read_text(encoding="utf-8")
    for entry in ("network.yaml", "cluster.yaml", "nodes.yaml", "crossplane-identity.yaml", "emit-contract.py"):
        if entry not in deploy:
            findings.append(f"CloudFormation entry point does not include {entry}")
    main = (terraform / "main.tf").read_text(encoding="utf-8")
    modules = set(re.findall(r'^module\s+"([a-z0-9_]+)"', main, re.M))
    expected_modules = {"network", "cluster", "nodes", "addons"}
    if modules != expected_modules:
        findings.append(f"Terraform modules differ: {sorted(modules ^ expected_modules)}")
    outputs = set()
    for path in terraform.glob("*.tf"):
        outputs.update(re.findall(r'^output\s+"([a-z0-9_]+)"', path.read_text(encoding="utf-8"), re.M))
    required_outputs = {
        "cluster_name", "region", "account_id", "outpost_arn", "local_cluster_version",
        "registry_service_ip", "node_subnet_cidr", "bastion_cidr",
        "kubernetes_service_ip_cidr", "cluster_dns_service_ip",
    }
    if not required_outputs.issubset(outputs):
        findings.append(f"Terraform contract outputs missing: {sorted(required_outputs - outputs)}")
    network_outputs = set((load_cfn(cfn / "network.yaml").get("Outputs") or {}))
    cluster_outputs = set((load_cfn(cfn / "cluster.yaml").get("Outputs") or {}))
    required_cfn = {"Region", "AccountId", "OutpostArn", "NodeSubnetCidr", "BastionCidr", "ClusterName", "LocalClusterVersion"}
    if not required_cfn.issubset(network_outputs | cluster_outputs):
        findings.append(f"CloudFormation contract outputs missing: {sorted(required_cfn - network_outputs - cluster_outputs)}")
    for path in (cfn / "README.md", terraform / "README.md"):
        text = path.read_text(encoding="utf-8")
        if "bash ../../platform/gitops/bootstrap.sh ../../platform-contract.json" not in text:
            findings.append(f"{path.relative_to(root)} does not hand off to the shared bootstrap")
    infrastructure_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (root / "infrastructure").rglob("*")
        if path.is_file() and path.suffix in {".tf", ".yaml", ".sh"}
    )
    if re.search(r'addon_name\s*=\s*"vpc-cni"|AddonName:\s*vpc-cni', infrastructure_text):
        findings.append("An infrastructure front declares the VPC CNI add-on")
    if re.search(r'addon_name\s*=\s*"aws-ebs-csi-driver"|AddonName:\s*aws-ebs-csi-driver', infrastructure_text):
        findings.append("An infrastructure front declares the Amazon EBS CSI driver add-on")
    bootstrap = (root / "platform" / "gitops" / "bootstrap.sh").read_text(encoding="utf-8")
    for addon in ("aws-ebs-csi-driver", "eks-pod-identity-agent", "coredns", "fluent-bit", "vpc-cni"):
        if not re.search(rf'ensure_addon\s+{re.escape(addon)}\b', bootstrap):
            findings.append(f"Shared bootstrap does not own final configuration for {addon}")


EBS_CSI_POLICY = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
STORAGE_CLASS = "platform-ebs-gp2"
IMDS_CIDR = "169.254.169.254/32"
INSTANCE_STORE_TOKENS = ("lis.csi.aws.com", "ec2-instance-store-sc", "aws-ec2-local-instance-store-csi-driver", "components/instance-store", "INSTANCE_STORE")


def check_ebs_storage(root, findings):
    cfn = root / "infrastructure" / "cloudformation"
    terraform = root / "infrastructure" / "terraform"
    node_roles = [value["Properties"] for value in load_cfn(cfn / "nodes.yaml")["Resources"].values() if value["Type"] == "AWS::IAM::Role"]
    if len(node_roles) != 1 or EBS_CSI_POLICY not in (node_roles[0].get("ManagedPolicyArns") or []):
        findings.append("CloudFormation node role does not carry AmazonEBSCSIDriverPolicy")
    nodes = (terraform / "modules" / "nodes" / "main.tf").read_text(encoding="utf-8")
    attachments = blocks(nodes, r'resource "aws_iam_role_policy_attachment" "ebs_csi"')
    if not attachments or hcl_string(attachments[0], "policy_arn") != EBS_CSI_POLICY:
        findings.append("Terraform node role does not attach AmazonEBSCSIDriverPolicy")
    elif not re.search(r"^\s*count\s*=\s*var\.attach_ebs_csi_policy\s*\?\s*1\s*:\s*0\s*$", attachments[0], re.M):
        findings.append("Terraform EBS CSI node policy attachment is not driven by attach_ebs_csi_policy")
    node_modules = blocks((terraform / "main.tf").read_text(encoding="utf-8"), r'module "nodes"')
    if not node_modules or not re.search(r"^\s*attach_ebs_csi_policy\s*=\s*var\.node_attach_ebs_csi_policy\s*$", node_modules[0], re.M):
        findings.append("Terraform root does not pass node_attach_ebs_csi_policy to the nodes module")
    variables = (terraform / "variables.tf").read_text(encoding="utf-8")
    variable_blocks = blocks(variables, r'variable "node_attach_ebs_csi_policy"')
    if not variable_blocks or not re.search(r"^\s*default\s*=\s*true\s*$", variable_blocks[0], re.M):
        findings.append("Terraform EBS CSI node policy default is not true")
    if not re.search(r"^node_attach_ebs_csi_policy\s*=\s*true\s*$", (terraform / "terraform.tfvars.example").read_text(encoding="utf-8"), re.M):
        findings.append("Terraform example does not attach the EBS CSI node policy that the CloudFormation front attaches")
    classes = [document for document in yaml.safe_load_all((root / "platform" / "components" / "storage" / "storageclass.yaml").read_text(encoding="utf-8")) if document]
    if len(classes) != 1 or classes[0].get("metadata", {}).get("name") != STORAGE_CLASS or classes[0].get("provisioner") != "ebs.csi.aws.com" or (classes[0].get("parameters") or {}).get("type") != "gp2":
        findings.append("Platform StorageClass is not the EBS CSI gp2 class")
    elif (classes[0].get("metadata", {}).get("annotations") or {}).get("storageclass.kubernetes.io/is-default-class") != "false":
        findings.append("Platform StorageClass must not be the cluster default")
    bootstrap = (root / "platform" / "gitops" / "bootstrap.sh").read_text(encoding="utf-8")
    apply_class = 'kubectl apply -f "$ROOT/platform/components/storage/storageclass.yaml"'
    positions = [bootstrap.find(token) for token in ('ensure_addon aws-ebs-csi-driver "$EBS_CSI_ADDON_VERSION"', apply_class, "helm upgrade")]
    if -1 in positions[:2]:
        findings.append("Shared bootstrap does not install the EBS CSI driver and apply the platform StorageClass")
    elif not (positions[0] < positions[1] < positions[2]):
        findings.append("Shared bootstrap must install the EBS CSI driver, then the StorageClass, before any Helm release")
    policies = (root / "platform" / "components" / "network-policies" / "01-kube-system-addons.yaml").read_text(encoding="utf-8")
    controller = [document for document in yaml.safe_load_all(policies) if document and document["metadata"]["name"] == "ebs-csi-controller"]
    credential_rules = [rule for rule in (controller[0]["spec"].get("egress") or []) if {"ipBlock": {"cidr": "${EBS_CSI_CONTROLLER_CREDENTIAL_CIDR}"}} in (rule.get("to") or [])] if controller else []
    if not any({"protocol": "TCP", "port": 80} in (rule.get("ports") or []) for rule in credential_rules):
        findings.append("ebs-csi-controller NetworkPolicy does not allow TCP 80 to the contract credential endpoint")
    references = 0
    for path in sorted((root / "platform" / "gitops" / "values").glob("*.yaml")):
        for match in re.finditer(r"storageClass(?:Name)?:\s*([^,}\s]+)", path.read_text(encoding="utf-8")):
            references += 1
            if match.group(1) != STORAGE_CLASS:
                findings.append(f"{path.relative_to(root)} uses StorageClass {match.group(1)}")
    if references == 0:
        findings.append("No platform values reference the platform StorageClass")
    for path in root.rglob("*"):
        if path.is_file() and ".runtime" not in path.parts and path.name not in {"CHANGELOG.md", "check-iac-parity.py"}:
            text = path.read_text(encoding="utf-8", errors="ignore")
            for token in INSTANCE_STORE_TOKENS:
                if token in text:
                    findings.append(f"{path.relative_to(root)} still references instance store: {token}")


def check_crossplane_identity(root, findings):
    cfn_path = root / "infrastructure" / "cloudformation" / "crossplane-identity.yaml"
    tf_path = root / "infrastructure" / "terraform" / "crossplane-identity.tf"
    variables_path = root / "infrastructure" / "terraform" / "variables.tf"
    tfvars_path = root / "infrastructure" / "terraform" / "terraform.tfvars.example"
    template = load_cfn(cfn_path)
    parameters = {key: value.get("Default") for key, value in template["Parameters"].items()}
    roles = [value["Properties"] for value in template["Resources"].values() if value["Type"] == "AWS::IAM::Role"]
    associations = [value["Properties"] for value in template["Resources"].values() if value["Type"] == "AWS::EKS::PodIdentityAssociation"]
    if len(roles) != 1 or len(associations) != 2:
        findings.append(f"CloudFormation Crossplane identity resources differ: roles={len(roles)} associations={len(associations)}")
        return
    role = roles[0]
    tf = (tf_path).read_text(encoding="utf-8")
    locals_blocks = blocks(tf, r"(?m)^locals")
    role_blocks = blocks(tf, r'resource "aws_iam_role" "crossplane"')
    policy_blocks = blocks(tf, r'resource "aws_iam_role_policy" "crossplane"')
    trust_blocks = blocks(tf, r'data "aws_iam_policy_document" "crossplane_trust"')
    document_blocks = blocks(tf, r'data "aws_iam_policy_document" "crossplane"')
    association_blocks = blocks(tf, r'resource "aws_eks_pod_identity_association" "crossplane"')
    if not all((locals_blocks, role_blocks, policy_blocks, trust_blocks, document_blocks, association_blocks)):
        findings.append("Terraform Crossplane identity is missing a required block")
        return
    local = locals_blocks[0]
    prefix = hcl_string(local, "crossplane_name_prefix")
    namespace = hcl_string(local, "crossplane_namespace")
    service_account_blocks = blocks(local, r"crossplane_service_accounts\s*=")
    service_accounts = sorted(re.findall(r'=\s*"([^"]+)"', service_account_blocks[0])) if service_account_blocks else []
    if parameters.get("NamePrefix") != prefix or prefix != "sample-plat-":
        findings.append(f"Crossplane name prefix differs: CloudFormation={parameters.get('NamePrefix')!r} Terraform={prefix!r}")
    cfn_namespaces = sorted({parameters.get(normalize_cfn(item["Namespace"])[2:-1]) for item in associations})
    cfn_accounts = sorted(parameters.get(normalize_cfn(item["ServiceAccount"])[2:-1]) for item in associations)
    if cfn_namespaces != [namespace]:
        findings.append(f"Crossplane namespace differs: CloudFormation={cfn_namespaces} Terraform={[namespace]}")
    if cfn_accounts != service_accounts or len(service_accounts) != 2:
        findings.append(f"Crossplane service accounts differ: CloudFormation={cfn_accounts} Terraform={service_accounts}")
    cfn_role_name = normalize_cfn(role["RoleName"])
    tf_role_name = normalize_tf(hcl_string(role_blocks[0], "name") or "", findings, "role name")
    if cfn_role_name != tf_role_name:
        findings.append(f"Crossplane role name differs: CloudFormation={cfn_role_name!r} Terraform={tf_role_name!r}")
    inline_policies = role.get("Policies") or []
    if len(inline_policies) != 1 or inline_policies[0]["PolicyName"] != hcl_string(policy_blocks[0], "name"):
        findings.append("Crossplane inline policy name differs")
        return
    pairs = (
        ("trust", cfn_statements(role["AssumeRolePolicyDocument"]), tf_statements(trust_blocks[0], findings, "trust")),
        ("permissions", cfn_statements(inline_policies[0]["PolicyDocument"]), tf_statements(document_blocks[0], findings, "permissions")),
    )
    for label, cfn_document, tf_document in pairs:
        if cfn_document != tf_document:
            findings.append(f"Crossplane {label} differs between CloudFormation and Terraform")
    for statement in cfn_statements(inline_policies[0]["PolicyDocument"]).values():
        for resource in statement["resources"] or []:
            if resource != "*" and "${NamePrefix}" not in resource:
                findings.append(f"Crossplane resource is outside the shared name prefix: {resource}")
    association = association_blocks[0]
    for expression in (
        r"for_each\s*=\s*local\.crossplane_identity_enabled\s*\?\s*local\.crossplane_service_accounts\s*:\s*\{\}",
        r"namespace\s*=\s*local\.crossplane_namespace",
        r"service_account\s*=\s*each\.value",
        r"role_arn\s*=\s*aws_iam_role\.crossplane\[0\]\.arn",
    ):
        if not re.search(expression, association):
            findings.append(f"Terraform Crossplane association wiring differs: {expression}")
    variables = variables_path.read_text(encoding="utf-8")
    variable_blocks = blocks(variables, r'variable "enable_crossplane_identity"')
    if not variable_blocks or not re.search(r"^\s*default\s*=\s*false\s*$", variable_blocks[0], re.M):
        findings.append("Terraform Crossplane identity default is not false")
    if not re.search(r"^enable_crossplane_identity\s*=\s*true\s*$", tfvars_path.read_text(encoding="utf-8"), re.M):
        findings.append("Terraform example does not enable the Crossplane identity deployed by the CloudFormation entry point")


def check(root):
    findings = []
    try:
        emitted_contracts(root, findings)
        check_structure(root, findings)
        check_ebs_storage(root, findings)
        check_crossplane_identity(root, findings)
    except (KeyError, ValueError, yaml.YAMLError, subprocess.CalledProcessError) as error:
        findings.append(f"Parity checker could not evaluate the repository: {error}")
    return findings


def mutation_controls(root):
    controls = [
        ("missing contract key", "scripts/emit-contract.py", 'data["gitea_repo"]=', 'data["gitea_repo_removed"]='),
        ("CloudFormation prefix drift", "infrastructure/cloudformation/crossplane-identity.yaml", "sample-plat-", "sample-other-"),
        ("Terraform service account drift", "infrastructure/terraform/crossplane-identity.tf", "provider-aws-dynamodb", "provider-aws-other"),
        ("Terraform permission drift", "infrastructure/terraform/crossplane-identity.tf", '"s3:ListAllMyBuckets"]', '"s3:ListAllMyBuckets", "iam:PassRole"]'),
        ("front-owned VPC CNI", "infrastructure/terraform/main.tf", 'module "network" {', 'resource "aws_eks_addon" "unexpected" { addon_name = "vpc-cni" }\n\nmodule "network" {'),
        ("missing CFN identity step", "infrastructure/cloudformation/deploy.sh", '"$ROOT/infrastructure/cloudformation/crossplane-identity.yaml"', '"$ROOT/infrastructure/cloudformation/identity-missing.yaml"'),
        ("front-owned EBS CSI", "infrastructure/terraform/modules/addons/main.tf", 'resource "aws_eks_addon" "kube_proxy" {', 'resource "aws_eks_addon" "unexpected" { addon_name = "aws-ebs-csi-driver" }\n\nresource "aws_eks_addon" "kube_proxy" {'),
        ("CloudFormation EBS CSI node policy removed", "infrastructure/cloudformation/nodes.yaml", "        - arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy\n", ""),
        ("Terraform example EBS CSI node policy disabled", "infrastructure/terraform/terraform.tfvars.example", "node_attach_ebs_csi_policy   = true", "node_attach_ebs_csi_policy   = false"),
        ("platform values StorageClass drift", "platform/gitops/values/gitea.yaml", "storageClass: platform-ebs-gp2", "storageClass: gp3"),
        ("StorageClass provisioner drift", "platform/components/storage/storageclass.yaml", "provisioner: ebs.csi.aws.com", "provisioner: lis.csi.aws.com"),
        ("StorageClass becomes the default", "platform/components/storage/storageclass.yaml", 'is-default-class: "false"', 'is-default-class: "true"'),
        ("controller credential points at Pod Identity", "scripts/emit-contract.py", '"169.254.169.254/32"', '"169.254.170.23/32"'),
        ("controller credential port drift", "platform/components/network-policies/01-kube-system-addons.yaml", "  - to: [{ipBlock: {cidr: \"${EBS_CSI_CONTROLLER_CREDENTIAL_CIDR}\"}}]\n    ports: [{protocol: TCP, port: 80}]", "  - to: [{ipBlock: {cidr: \"${EBS_CSI_CONTROLLER_CREDENTIAL_CIDR}\"}}]\n    ports: [{protocol: TCP, port: 8080}]"),
        ("Terraform root stops passing the node policy flag", "infrastructure/terraform/main.tf", "attach_ebs_csi_policy = var.node_attach_ebs_csi_policy", "attach_ebs_csi_policy = false"),
        ("Terraform node policy attachment disabled", "infrastructure/terraform/modules/nodes/main.tf", "count = var.attach_ebs_csi_policy ? 1 : 0", "count = 0"),
        ("StorageClass missing from bootstrap", "platform/gitops/bootstrap.sh", 'kubectl apply -f "$ROOT/platform/components/storage/storageclass.yaml"\n', ""),
        ("EBS CSI driver installed after a Helm release", "platform/gitops/bootstrap.sh", 'ensure_addon aws-ebs-csi-driver "$EBS_CSI_ADDON_VERSION"\nensure_addon eks-pod-identity-agent "$POD_IDENTITY_AGENT_VERSION"\nkubectl apply -f "$ROOT/platform/components/storage/storageclass.yaml"\n', 'ensure_addon eks-pod-identity-agent "$POD_IDENTITY_AGENT_VERSION"\nhelm upgrade --install early \"$CHARTS/early\"\nensure_addon aws-ebs-csi-driver "$EBS_CSI_ADDON_VERSION"\nkubectl apply -f "$ROOT/platform/components/storage/storageclass.yaml"\n'),
    ]
    passed = 0
    for name, relative, old, new in controls:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "extension"
            shutil.copytree(root, target, ignore=shutil.ignore_patterns(".runtime"))
            path = target / relative
            text = path.read_text(encoding="utf-8")
            if old not in text:
                raise AssertionError(f"mutation anchor missing for {name}")
            path.write_text(text.replace(old, new, 1), encoding="utf-8")
            if not check(target):
                raise AssertionError(f"mutation was not detected: {name}")
            passed += 1
    return passed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--skip-mutation-controls", action="store_true")
    arguments = parser.parse_args()
    root = Path(arguments.root).resolve()
    findings = check(root)
    for finding in findings:
        print(f"FAIL {finding}")
    if findings:
        print(f"RESULT iac-parity failures={len(findings)}")
        return 1
    controls = 0 if arguments.skip_mutation_controls else mutation_controls(root)
    print(f"PASS iac-parity contract-keys={len(CONTRACT_KEYS)} fronts=2 shared-bootstrap=1 mutation-controls={controls}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
