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
CROSSPLANE_ROLE_IDS = ("ProviderRole",)
CROSSPLANE_ASSOCIATION_IDS = ("S3Association", "DynamoDbAssociation")
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
    resources = template["Resources"]
    roles = [resources[key]["Properties"] for key in CROSSPLANE_ROLE_IDS if resources.get(key, {}).get("Type") == "AWS::IAM::Role"]
    associations = [resources[key]["Properties"] for key in CROSSPLANE_ASSOCIATION_IDS
                    if resources.get(key, {}).get("Type") == "AWS::EKS::PodIdentityAssociation"]
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


SERVERLESS_PROVIDERS = {
    "lambda": ("LambdaProviderRole", "LambdaAssociation", "LambdaServiceAccount", {"lambda", "s3", "iam"}),
    "apigateway": ("ApiGatewayProviderRole", "ApiGatewayAssociation", "ApiGatewayServiceAccount", {"apigateway"}),
    "cloudfront": ("CloudFrontProviderRole", "CloudFrontAssociation", "CloudFrontServiceAccount", {"cloudfront"}),
    "cloudwatchlogs": ("LogsProviderRole", "LogsAssociation", "LogsServiceAccount", {"logs"}),
}
SERVERLESS_ACTIONS = {
    "lambda": {"lambda:AddPermission", "lambda:CreateFunction", "lambda:DeleteFunction", "lambda:GetFunction",
               "lambda:GetFunctionCodeSigningConfig", "lambda:GetFunctionConfiguration", "lambda:GetPolicy",
               "lambda:ListTags", "lambda:ListVersionsByFunction", "lambda:RemovePermission", "lambda:TagResource",
               "lambda:UntagResource", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration",
               "s3:GetObject", "s3:GetObjectVersion", "iam:PassRole"},
    "apigateway": {"apigateway:DELETE", "apigateway:GET", "apigateway:PATCH", "apigateway:POST", "apigateway:PUT"},
    "cloudfront": {"cloudfront:CreateDistribution", "cloudfront:DeleteDistribution", "cloudfront:GetDistribution",
                   "cloudfront:ListTagsForResource", "cloudfront:TagResource", "cloudfront:UntagResource",
                   "cloudfront:UpdateDistribution"},
    "cloudwatchlogs": {"logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:DescribeLogGroups", "logs:ListTagsForResource",
                       "logs:PutRetentionPolicy", "logs:TagLogGroup", "logs:TagResource", "logs:UntagResource"},
}
SERVERLESS_FORBIDDEN = {"lambda:CreateFunctionUrlConfig", "lambda:UpdateFunctionUrlConfig", "lambda:DeleteFunctionUrlConfig",
                        "lambda:InvokeFunctionUrl", "lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency",
                        "lambda:PutProvisionedConcurrencyConfig", "cloudfront:CreateInvalidation",
                        "cloudfront:CreateOriginAccessControl", "cloudfront:UpdateOriginAccessControl",
                        "cloudfront:DeleteOriginAccessControl"}
ARN = "arn:${AWS::Partition}"
RUNTIME_NAME = "${NamePrefix}runtime-${ClusterName}"
RUNTIME_ARN = ARN + ":iam::${AWS::AccountId}:role/" + RUNTIME_NAME
OAC_NAME = "${NamePrefix}spa-${ClusterName}"
SERVERLESS_RESOURCES = {
    "lambda": {ARN + ":lambda:${AWS::Region}:${AWS::AccountId}:function:${NamePrefix}*",
               ARN + ":lambda:${AWS::Region}:${AWS::AccountId}:function:${NamePrefix}*:*",
               ARN + ":s3:::${NamePrefix}*/*", RUNTIME_ARN},
    "apigateway": {ARN + ":apigateway:${AWS::Region}::/restapis", ARN + ":apigateway:${AWS::Region}::/restapis/*",
                   ARN + ":apigateway:${AWS::Region}::/tags/*"},
    "cloudfront": {ARN + ":cloudfront::${AWS::AccountId}:distribution/*", "*"},
    "cloudwatchlogs": {ARN + ":logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${NamePrefix}*",
                       ARN + ":logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${NamePrefix}*:*", "*"},
}
SERVERLESS_STAR = {
    ("cloudfront", "CreateTaggedDistribution"): {"cloudfront:CreateDistribution"},
    ("cloudwatchlogs", "AccountLevelReads"): {"logs:DescribeLogGroups"},
}
TAG_REQUEST = {("StringEquals", "aws:RequestTag/platform"): ["sample-plat"]}
TAG_RESOURCE = {("StringEquals", "aws:ResourceTag/platform"): ["sample-plat"]}
SERVERLESS_TAG_EXEMPT = {
    ("apigateway", "TagRecipeRestApis"): ({"apigateway:DELETE", "apigateway:PUT"}, {ARN + ":apigateway:${AWS::Region}::/tags/*"}),
}
RUNTIME_ACTIONS = {"dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:DeleteItem", "dynamodb:GetItem",
                   "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:UpdateItem",
                   "logs:CreateLogStream", "logs:PutLogEvents"}
PROVIDER_TRUST = {"": {"effect": "Allow", "actions": ["sts:AssumeRole", "sts:TagSession"], "resources": None,
                       "principals": ["pods.eks.amazonaws.com"],
                       "conditions": {("StringEquals", "aws:SourceAccount"): ["${AWS::AccountId}"],
                                      ("ArnLike", "aws:SourceArn"): ["arn:${AWS::Partition}:eks:${AWS::Region}:${AWS::AccountId}:cluster/${ClusterName}"]}}}
RUNTIME_TRUST = {"LambdaService": {"effect": "Allow", "actions": ["sts:AssumeRole"], "resources": None,
                                   "principals": ["lambda.amazonaws.com"], "conditions": {}}}
OAC_CFN = {"OriginAccessControlOriginType": "s3", "SigningBehavior": "always", "SigningProtocol": "sigv4"}
OAC_TF = {"origin_access_control_origin_type": "s3", "signing_behavior": "always", "signing_protocol": "sigv4"}


def hcl_map(body, name):
    found = blocks(body, re.escape(name) + r"\s*=")
    return dict(re.findall(r'^\s*([a-z0-9_]+)\s*=\s*"?([^"\n]+?)"?\s*$', found[0], re.M)) if found else {}


def is_read(action):
    service, operation = action.split(":", 1)
    return operation == "GET" if service == "apigateway" else operation.startswith(("Get", "List", "Describe"))


def serverless_least_privilege(side, key, statements, findings):
    services, seen = SERVERLESS_PROVIDERS[key][3], set()
    for sid, statement in statements.items():
        actions, resources = set(statement["actions"]), statement["resources"] or []
        where = f"Serverless {side} {key} {sid or '(no Sid)'}"
        if statement["effect"] != "Allow":
            findings.append(f"{where}: effect {statement['effect']} is not Allow")
            continue
        seen |= actions
        findings.extend(f"{where}: action wildcard {action}" for action in sorted(a for a in actions if "*" in a))
        findings.extend(f"{where}: forbidden action {action}" for action in sorted(actions & SERVERLESS_FORBIDDEN))
        findings.extend(f"{where}: action {action} is outside the provider services {sorted(services)}"
                        for action in sorted(a for a in actions if a.split(":")[0] not in services))
        findings.extend(f"{where}: action {action} is outside the closed list of the pinned controller"
                        for action in sorted(actions - SERVERLESS_ACTIONS[key] - SERVERLESS_FORBIDDEN))
        findings.extend(f"{where}: resource {resource} is outside the recipe scope"
                        for resource in sorted(set(resources) - SERVERLESS_RESOURCES[key]))
        if "*" in resources and not actions <= SERVERLESS_STAR.get((key, sid), set()):
            findings.append(f"{where}: Resource \"*\" with {sorted(actions - SERVERLESS_STAR.get((key, sid), set()))}")
        if key in ("cloudfront", "apigateway"):
            writes = {action for action in actions if not is_read(action)}
            create = (actions == {"cloudfront:CreateDistribution"} or
                      (actions == {"apigateway:POST"} and resources == [ARN + ":apigateway:${AWS::Region}::/restapis"]))
            if "cloudfront:CreateDistribution" in actions and not create:
                findings.append(f"{where}: CreateDistribution shares its statement with other actions")
            exempt_actions, exempt_resources = SERVERLESS_TAG_EXEMPT.get((key, sid), (None, None))
            exempt = exempt_actions is not None and actions <= exempt_actions and sorted(resources) == sorted(exempt_resources)
            if exempt_actions is not None and not exempt:
                findings.append(f"{where}: the tag exemption covers only {sorted(exempt_actions)} on {sorted(exempt_resources)}")
            if writes and not exempt and statement["conditions"] != (TAG_REQUEST if create else TAG_RESOURCE):
                findings.append(f"{where}: write {sorted(writes)} without the platform=sample-plat tag condition")
            if not writes and statement["conditions"]:
                findings.append(f"{where}: read with condition {statement['conditions']}")
        if "iam:PassRole" in actions and (actions != {"iam:PassRole"} or resources != [RUNTIME_ARN] or
                                          statement["conditions"] != {("StringEquals", "iam:PassedToService"): ["lambda.amazonaws.com"]}):
            findings.append(f"{where}: iam:PassRole must stand alone, on {RUNTIME_ARN}, with iam:PassedToService=lambda.amazonaws.com")
        permission = actions & {"lambda:AddPermission", "lambda:RemovePermission"}
        if permission and statement["conditions"] != {("StringEquals", "lambda:Principal"): ["apigateway.amazonaws.com"]}:
            findings.append(f"{where}: {sorted(permission)} without lambda:Principal=apigateway.amazonaws.com")
    findings.extend(f"Serverless {side} {key}: controller action {action} is missing"
                    for action in sorted(SERVERLESS_ACTIONS[key] - seen))


def iam_writes(actions):
    return sorted(action for action in actions if action.lower().startswith("iam:") and action != "iam:PassRole")


def check_serverless_identity(root, findings):
    template = load_cfn(root / "infrastructure" / "cloudformation" / "crossplane-identity.yaml")
    tf = (root / "infrastructure" / "terraform" / "crossplane-identity.tf").read_text(encoding="utf-8")
    parameters = {key: value.get("Default") for key, value in template["Parameters"].items()}
    resources = template["Resources"]
    local = (blocks(tf, r"(?m)^locals") or [""])[0]
    tf_accounts = hcl_map(local, "crossplane_serverless_service_accounts")
    tf_policies = hcl_map(local, "crossplane_serverless_policies")
    packages = json.dumps([document for document in yaml.safe_load_all(
        (root / "platform" / "components" / "crossplane" / "packages" / "packages.yaml").read_text(encoding="utf-8")) if document])
    images = (root / "platform" / "components" / "registry" / "images.txt").read_text(encoding="utf-8")
    for where, text in (("packages.yaml", packages), ("registry/images.txt", images), ("CloudFormation", json.dumps(template)), ("Terraform", tf)):
        if re.search(r"provider-aws-iam\b", text):
            findings.append(f"Serverless identity: provider-aws-iam present in {where}")
    expected_roles = set(CROSSPLANE_ROLE_IDS) | {"ServerlessRuntimeRole"} | {value[0] for value in SERVERLESS_PROVIDERS.values()}
    expected_associations = set(CROSSPLANE_ASSOCIATION_IDS) | {value[1] for value in SERVERLESS_PROVIDERS.values()}
    roles = {key for key, value in resources.items() if value["Type"] == "AWS::IAM::Role"}
    associations = {key for key, value in resources.items() if value["Type"] == "AWS::EKS::PodIdentityAssociation"}
    if roles != expected_roles or associations != expected_associations:
        findings.append(f"Serverless CloudFormation identity set differs: roles={sorted(roles)} associations={sorted(associations)}")
    for key, value in resources.items():
        if value["Type"] in ("AWS::IAM::ManagedPolicy", "AWS::IAM::Policy", "AWS::IAM::User", "AWS::IAM::InstanceProfile"):
            findings.append(f"Serverless CloudFormation {key}: {value['Type']} is not allowed in the Crossplane identity")
        for policy in value["Properties"].get("Policies") or [] if value["Type"] == "AWS::IAM::Role" else []:
            bad = iam_writes(action for statement in cfn_statements(policy["PolicyDocument"]).values() for action in statement["actions"])
            if bad:
                findings.append(f"Serverless CloudFormation {key}/{policy['PolicyName']}: IAM write {bad}")
    for match in re.finditer(r'data "aws_iam_policy_document" "([a-z0-9_]+)"', tf):
        body = blocks(tf, r'data "aws_iam_policy_document" "' + match.group(1) + '"')[0]
        bad = iam_writes(action for statement in tf_statements(body, findings, match.group(1)).values() for action in statement["actions"])
        if bad:
            findings.append(f"Serverless Terraform {match.group(1)}: IAM write {bad}")
    if re.search(r'resource "aws_iam_(policy|user|instance_profile)" ', tf):
        findings.append("Serverless Terraform identity creates an aws_iam_policy, aws_iam_user or aws_iam_instance_profile")
    if sorted(tf_accounts) != sorted(SERVERLESS_PROVIDERS):
        findings.append(f"Serverless Terraform service accounts {sorted(tf_accounts)} != {sorted(SERVERLESS_PROVIDERS)}")
    trust_blocks = blocks(tf, r'data "aws_iam_policy_document" "crossplane_trust"')
    role_blocks = blocks(tf, r'resource "aws_iam_role" "crossplane_serverless"')
    policy_blocks = blocks(tf, r'resource "aws_iam_role_policy" "crossplane_serverless"')
    association_blocks = blocks(tf, r'resource "aws_eks_pod_identity_association" "crossplane_serverless"')
    if not all((trust_blocks, role_blocks, policy_blocks, association_blocks)):
        findings.append("Serverless Terraform identity is missing a role, policy or association block")
        return
    for_each = r"for_each\s*=\s*local\.crossplane_identity_enabled \? local\.crossplane_serverless_service_accounts : \{\}"
    for expression, body in ((for_each, role_blocks[0]), (for_each, policy_blocks[0]), (for_each, association_blocks[0]),
                             (r"assume_role_policy\s*=\s*data\.aws_iam_policy_document\.crossplane_trust\[0\]\.json", role_blocks[0]),
                             (r"policy\s*=\s*local\.crossplane_serverless_policies\[each\.key\]", policy_blocks[0]),
                             (r"namespace\s*=\s*local\.crossplane_namespace", association_blocks[0]),
                             (r"service_account\s*=\s*each\.value", association_blocks[0]),
                             (r"role_arn\s*=\s*aws_iam_role\.crossplane_serverless\[each\.key\]\.arn", association_blocks[0])):
        if not re.search(expression, body):
            findings.append(f"Serverless Terraform wiring differs: {expression}")
    tf_trust = tf_statements(trust_blocks[0], findings, "serverless trust")
    if tf_trust != PROVIDER_TRUST:
        findings.append(f"Serverless Terraform provider trust differs from the account and cluster scoped trust: {tf_trust}")
    actions_total = 0
    for key, (role_id, association_id, account_parameter, _services) in SERVERLESS_PROVIDERS.items():
        role = resources.get(role_id, {}).get("Properties")
        if not role:
            findings.append(f"Serverless CloudFormation role {role_id} is missing")
            continue
        tf_name = normalize_tf((hcl_string(role_blocks[0], "name") or "").replace("${each.key}", key), findings, f"{key} role name")
        if normalize_cfn(role["RoleName"]) != tf_name or tf_name != "${ClusterName}-crossplane-" + key:
            findings.append(f"Serverless {key} role name differs: CloudFormation={normalize_cfn(role['RoleName'])!r} Terraform={tf_name!r}")
        policies = role.get("Policies") or []
        tf_policy_name = (hcl_string(policy_blocks[0], "name") or "").replace("${each.key}", key)
        if len(policies) != 1 or policies[0]["PolicyName"] != tf_policy_name or tf_policy_name != "sample-plat-" + key:
            findings.append(f"Serverless {key} inline policy name differs: CloudFormation={[p.get('PolicyName') for p in policies]} Terraform={tf_policy_name!r}")
            continue
        cfn_trust = cfn_statements(role["AssumeRolePolicyDocument"])
        if cfn_trust != PROVIDER_TRUST or cfn_trust != tf_trust:
            findings.append(f"Serverless {key} trust differs between CloudFormation and Terraform or leaves the account and cluster scope")
        reference = re.fullmatch(r"data\.aws_iam_policy_document\.([a-z0-9_]+)\.json", tf_policies.get(key, ""))
        document = blocks(tf, r'data "aws_iam_policy_document" "' + reference.group(1) + '"') if reference else []
        if not document:
            findings.append(f"Serverless {key}: local.crossplane_serverless_policies does not point at a policy document")
            continue
        cfn_document, tf_document = cfn_statements(policies[0]["PolicyDocument"]), tf_statements(document[0], findings, f"{key} policy")
        if cfn_document != tf_document:
            findings.append(f"Serverless {key} permissions differ between CloudFormation and Terraform")
        serverless_least_privilege("CloudFormation", key, cfn_document, findings)
        serverless_least_privilege("Terraform", key, tf_document, findings)
        actions_total += sum(len(statement["actions"]) for statement in cfn_document.values())
        association = resources.get(association_id, {}).get("Properties")
        if not association:
            findings.append(f"Serverless CloudFormation association {association_id} is missing")
            continue
        account = parameters.get(normalize_cfn(association["ServiceAccount"])[2:-1])
        if (normalize_cfn(association["ServiceAccount"]) != "${" + account_parameter + "}" or account != tf_accounts.get(key)
                or account != "provider-aws-" + key or association["RoleArn"] != {"GetAtt": f"{role_id}.Arn"}
                or parameters.get(normalize_cfn(association["Namespace"])[2:-1]) != "crossplane-system"):
            findings.append(f"Serverless {key} association differs: CloudFormation={account!r} Terraform={tf_accounts.get(key)!r}")
    runtime = resources.get("ServerlessRuntimeRole", {}).get("Properties")
    runtime_role = blocks(tf, r'resource "aws_iam_role" "serverless_runtime"')
    runtime_policy = blocks(tf, r'resource "aws_iam_role_policy" "serverless_runtime"')
    runtime_trust = blocks(tf, r'data "aws_iam_policy_document" "serverless_runtime_trust"')
    runtime_document = blocks(tf, r'data "aws_iam_policy_document" "serverless_runtime"')
    if not runtime or not all((runtime_role, runtime_policy, runtime_trust, runtime_document)):
        findings.append("Serverless runtime role is missing from CloudFormation or Terraform")
    else:
        names = (normalize_cfn(runtime["RoleName"]), normalize_tf(hcl_string(runtime_role[0], "name") or "", findings, "runtime role name"))
        if names != (RUNTIME_NAME, RUNTIME_NAME):
            findings.append(f"Serverless runtime role name differs: {names}")
        for expression, body in ((r"count\s*=\s*local\.crossplane_identity_enabled \? 1 : 0", runtime_role[0]),
                                 (r"assume_role_policy\s*=\s*data\.aws_iam_policy_document\.serverless_runtime_trust\.json", runtime_role[0]),
                                 (r"count\s*=\s*local\.crossplane_identity_enabled \? 1 : 0", runtime_policy[0]),
                                 (r"role\s*=\s*aws_iam_role\.serverless_runtime\[0\]\.id", runtime_policy[0]),
                                 (r"policy\s*=\s*data\.aws_iam_policy_document\.serverless_runtime\.json", runtime_policy[0])):
            if not re.search(expression, body):
                findings.append(f"Serverless Terraform runtime wiring differs: {expression}")
        raw = runtime["AssumeRolePolicyDocument"].get("Statement") or []
        if len(raw) != 1 or raw[0].get("Principal") != {"Service": "lambda.amazonaws.com"} or raw[0].get("Condition"):
            findings.append("Serverless CloudFormation runtime trust is not exactly lambda.amazonaws.com")
        if len(re.findall(r"\bprincipals\s*\{", runtime_trust[0])) != 1 or len(blocks(runtime_trust[0], r"\bstatement")) != 1:
            findings.append("Serverless Terraform runtime trust needs exactly one statement and one principals block")
        for side, trust in (("CloudFormation", cfn_statements(runtime["AssumeRolePolicyDocument"])),
                            ("Terraform", tf_statements(runtime_trust[0], findings, "runtime trust"))):
            if trust != RUNTIME_TRUST:
                findings.append(f"Serverless {side} runtime trust differs: {trust}")
        policies = runtime.get("Policies") or []
        if len(policies) != 1 or policies[0]["PolicyName"] != hcl_string(runtime_policy[0], "name") or policies[0]["PolicyName"] != "sample-plat-runtime":
            findings.append("Serverless runtime inline policy name differs")
        else:
            cfn_document = cfn_statements(policies[0]["PolicyDocument"])
            tf_document = tf_statements(runtime_document[0], findings, "runtime policy")
            if cfn_document != tf_document:
                findings.append("Serverless runtime permissions differ between CloudFormation and Terraform")
            for side, document in (("CloudFormation", cfn_document), ("Terraform", tf_document)):
                for sid, statement in document.items():
                    if statement["effect"] != "Allow" or not set(statement["actions"]) <= RUNTIME_ACTIONS or statement["conditions"]:
                        findings.append(f"Serverless {side} runtime {sid}: actions outside table items and log writes")
                    for resource in statement["resources"] or ["*"]:
                        if not re.search(r":(table/\$\{NamePrefix\}\*(/index/\*)?|log-group:/aws/lambda/\$\{NamePrefix\}\*:\*)$", resource):
                            findings.append(f"Serverless {side} runtime {sid}: resource {resource} is outside the recipe prefix")
    oac = resources.get("ServerlessOriginAccessControl", {})
    tf_oac = blocks(tf, r'resource "aws_cloudfront_origin_access_control" "serverless"')
    if oac.get("Type") != "AWS::CloudFront::OriginAccessControl" or not tf_oac:
        findings.append("Serverless origin access control is missing from CloudFormation or Terraform")
    else:
        config = oac["Properties"]["OriginAccessControlConfig"]
        names = (normalize_cfn(config.get("Name")), normalize_tf(hcl_string(tf_oac[0], "name") or "", findings, "origin access control name"))
        if names != (OAC_NAME, OAC_NAME):
            findings.append(f"Serverless origin access control name differs: {names}")
        if {key: config.get(key) for key in OAC_CFN} != OAC_CFN or {key: hcl_string(tf_oac[0], key) for key in OAC_TF} != OAC_TF:
            findings.append("Serverless origin access control is not s3, always, sigv4 in both fronts")
        if not re.search(r"count\s*=\s*local\.crossplane_identity_enabled \? 1 : 0", tf_oac[0]):
            findings.append("Serverless Terraform origin access control is not gated by enable_crossplane_identity")
    outputs = template.get("Outputs") or {}
    if (outputs.get("ServerlessRuntimeRoleArn", {}).get("Value") != {"GetAtt": "ServerlessRuntimeRole.Arn"}
            or outputs.get("ServerlessOacId", {}).get("Value") != {"GetAtt": "ServerlessOriginAccessControl.Id"}):
        findings.append("Serverless CloudFormation outputs ServerlessRuntimeRoleArn and ServerlessOacId differ")
    tf_outputs = (root / "infrastructure" / "terraform" / "outputs.tf").read_text(encoding="utf-8")
    for name, expression in (("serverless_runtime_role_arn", r"coalesce\(one\(aws_iam_role\.serverless_runtime\[\*\]\.arn\), \"disabled\"\)"),
                             ("serverless_oac_id", r"coalesce\(one\(aws_cloudfront_origin_access_control\.serverless\[\*\]\.id\), \"disabled\"\)")):
        match = re.search(r'output "' + name + r'" \{(.*?)\n\}', tf_outputs, re.S)
        if not match or not re.search(r"value\s*=\s*" + expression, match.group(1)):
            findings.append(f"Serverless Terraform output {name} differs")
    return actions_total


# Closed identity inventory of both fronts. Every IAM, Pod Identity, access entry and origin access control resource
# of the extension is listed here; anything added, renamed or removed in either front fails, and so does any managed
# policy, permissions boundary or extra inline policy. Both lists change together, in the same review as the IaC.
IDENTITY_CFN_TYPES = ("AWS::IAM::", "AWS::EKS::PodIdentityAssociation", "AWS::EKS::AccessEntry",
                      "AWS::CloudFront::OriginAccessControl")
IDENTITY_CFN = {
    "crossplane-identity.yaml": {
        "ProviderRole": "AWS::IAM::Role", "S3Association": "AWS::EKS::PodIdentityAssociation",
        "DynamoDbAssociation": "AWS::EKS::PodIdentityAssociation", "ServerlessRuntimeRole": "AWS::IAM::Role",
        "ServerlessOriginAccessControl": "AWS::CloudFront::OriginAccessControl",
        "LambdaProviderRole": "AWS::IAM::Role", "ApiGatewayProviderRole": "AWS::IAM::Role",
        "CloudFrontProviderRole": "AWS::IAM::Role", "LogsProviderRole": "AWS::IAM::Role",
        "LambdaAssociation": "AWS::EKS::PodIdentityAssociation", "ApiGatewayAssociation": "AWS::EKS::PodIdentityAssociation",
        "CloudFrontAssociation": "AWS::EKS::PodIdentityAssociation", "LogsAssociation": "AWS::EKS::PodIdentityAssociation",
    },
    "nodes.yaml": {"NodeRole": "AWS::IAM::Role", "NodeInstanceProfile": "AWS::IAM::InstanceProfile",
                   "NodeAccessEntry": "AWS::EKS::AccessEntry"},
}
IDENTITY_CFN_ROLE_KEYS = {"AssumeRolePolicyDocument", "Description", "Policies", "RoleName", "Tags"}
IDENTITY_CFN_MANAGED = {
    ("nodes.yaml", "NodeRole"): {
        "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy", "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
        "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
        "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"},
}
IDENTITY_TF_TYPES = re.compile(r"aws_iam_|aws_eks_pod_identity_association$|aws_eks_access_|aws_cloudfront_origin_access_control$")
IDENTITY_TF = {
    ("crossplane-identity.tf", "aws_iam_role", "crossplane"), ("crossplane-identity.tf", "aws_iam_role_policy", "crossplane"),
    ("crossplane-identity.tf", "aws_eks_pod_identity_association", "crossplane"),
    ("crossplane-identity.tf", "aws_iam_role", "serverless_runtime"),
    ("crossplane-identity.tf", "aws_iam_role_policy", "serverless_runtime"),
    ("crossplane-identity.tf", "aws_cloudfront_origin_access_control", "serverless"),
    ("crossplane-identity.tf", "aws_iam_role", "crossplane_serverless"),
    ("crossplane-identity.tf", "aws_iam_role_policy", "crossplane_serverless"),
    ("crossplane-identity.tf", "aws_eks_pod_identity_association", "crossplane_serverless"),
    ("ecr-mirror-identity.tf", "aws_iam_role", "ecr_mirror"),
    ("ecr-mirror-identity.tf", "aws_iam_role_policy_attachment", "ecr_mirror"),
    ("ecr-mirror-identity.tf", "aws_eks_pod_identity_association", "ecr_mirror"),
    ("modules/nodes/main.tf", "aws_eks_access_entry", "node"),
    ("modules/cluster/main.tf", "aws_iam_role", "cluster"),
    ("modules/cluster/main.tf", "aws_iam_role_policy_attachment", "cluster"),
    ("modules/nodes/main.tf", "aws_iam_role", "node"), ("modules/nodes/main.tf", "aws_iam_role_policy_attachment", "node"),
    ("modules/nodes/main.tf", "aws_iam_instance_profile", "node"),
    ("modules/nodes/main.tf", "aws_iam_role_policy_attachment", "ebs_csi"),
}
IDENTITY_TF_ATTACHMENTS = {
    "ecr_mirror": {"arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"},
    "cluster": {"arn:aws:iam::aws:policy/AmazonEKSClusterPolicy", "arn:aws:iam::aws:policy/AmazonEKSLocalOutpostClusterPolicy"},
    "node": {"arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy", "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
             "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"},
    "ebs_csi": {"arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"},
}
IDENTITY_TF_POLICY_ROLE = {
    "crossplane": r"aws_iam_role\.crossplane\[0\]\.id",
    "serverless_runtime": r"aws_iam_role\.serverless_runtime\[0\]\.id",
    "crossplane_serverless": r"aws_iam_role\.crossplane_serverless\[each\.key\]\.id",
}
IAM_ROLE_NAME_MAX = 64


def cluster_name_max(template):
    """Longest cluster name that keeps every Crossplane identity name within the IAM limit of 64 characters."""
    defaults = {key: str(value.get("Default", "")) for key, value in template["Parameters"].items()}
    longest = 0
    for value in template["Resources"].values():
        if value["Type"] == "AWS::IAM::Role":
            name = normalize_cfn(value["Properties"]["RoleName"])
            if "${ClusterName}" in name:
                longest = max(longest, len(re.sub(r"\$\{(\w+)\}", lambda m: "" if m.group(1) == "ClusterName"
                                                  else defaults.get(m.group(1), m.group(0)), name)))
    return IAM_ROLE_NAME_MAX - longest


def check_identity_inventory(root, findings):
    cfn_dir = root / "infrastructure" / "cloudformation"
    tf_dir = root / "infrastructure" / "terraform"
    seen_cfn = {}
    for path in sorted(cfn_dir.glob("*.y*ml")):
        resources = (load_cfn(path) or {}).get("Resources") or {}
        for key, value in resources.items():
            kind = value.get("Type", "")
            if kind.startswith(IDENTITY_CFN_TYPES):
                seen_cfn.setdefault(path.name, {})[key] = kind
            properties = value.get("Properties") or {}
            if kind == "AWS::IAM::Role":
                managed = set(properties.get("ManagedPolicyArns") or [])
                if managed != IDENTITY_CFN_MANAGED.get((path.name, key), set()):
                    findings.append(f"CloudFormation {path.name}/{key}: managed policies {sorted(managed)} differ from the closed inventory")
                if "PermissionsBoundary" in properties:
                    findings.append(f"CloudFormation {path.name}/{key}: permissions boundary is not part of the closed inventory")
                if path.name == "crossplane-identity.yaml":
                    extra = set(properties) - IDENTITY_CFN_ROLE_KEYS
                    if extra or len(properties.get("Policies") or []) != 1:
                        findings.append(f"CloudFormation {key}: role properties {sorted(extra)} or inline policy count "
                                        f"{len(properties.get('Policies') or [])} outside the closed inventory")
        if path.name == "crossplane-identity.yaml":
            others = sorted({value.get("Type") for value in resources.values()} -
                            {"AWS::IAM::Role", "AWS::EKS::PodIdentityAssociation", "AWS::CloudFront::OriginAccessControl"})
            if others:
                findings.append(f"CloudFormation crossplane-identity.yaml declares types outside the identity boundary: {others}")
            limit = (load_cfn(path)["Parameters"].get("ClusterName") or {}).get("MaxLength")
            if limit != cluster_name_max(load_cfn(path)):
                findings.append(f"CloudFormation ClusterName MaxLength {limit} != {cluster_name_max(load_cfn(path))} (IAM role name limit)")
    if seen_cfn != IDENTITY_CFN:
        findings.append(f"CloudFormation identity inventory differs: {json.dumps(seen_cfn, sort_keys=True)}")
    seen_tf = set()
    if list(tf_dir.rglob("*.tf.json")):
        findings.append("Terraform JSON configuration is not allowed in the identity inventory")
    for path in sorted(tf_dir.rglob("*.tf")):
        if ".terraform" in path.parts:
            continue
        relative, text = path.relative_to(tf_dir).as_posix(), path.read_text(encoding="utf-8")
        for token in ("managed_policy_arns", "inline_policy", "permissions_boundary"):
            if re.search(r"^\s*" + token + r"\b", text, re.M):
                findings.append(f"Terraform {relative}: {token} is not part of the closed inventory")
        for match in re.finditer(r'(?m)^\s*resource\s+"([a-z0-9_]+)"\s+"([a-z0-9_]+)"', text):
            kind, name = match.groups()
            if not IDENTITY_TF_TYPES.match(kind):
                continue
            seen_tf.add((relative, kind, name))
            body = balanced(text, text.index("{", match.end() - 1))
            if kind == "aws_iam_role_policy_attachment":
                arns = set(re.findall(r'"(arn:aws:iam::aws:policy/[^"]+)"', body))
                literal = re.search(r'^\s*policy_arn\s*=\s*(\S+)', body, re.M)
                if arns != IDENTITY_TF_ATTACHMENTS.get(name) or not literal or not (
                        literal.group(1) == "each.value" or literal.group(1).strip('"') in arns):
                    findings.append(f"Terraform {relative} attachment {name}: policies {sorted(arns)} differ from the closed inventory")
            if kind == "aws_iam_role_policy" and name in IDENTITY_TF_POLICY_ROLE and not re.search(
                    r"^\s*role\s*=\s*" + IDENTITY_TF_POLICY_ROLE[name] + r"\s*$", body, re.M):
                findings.append(f"Terraform inline policy {name} is not attached to its own role")
    if seen_tf != IDENTITY_TF:
        findings.append(f"Terraform identity inventory differs: added={sorted(seen_tf - IDENTITY_TF)} missing={sorted(IDENTITY_TF - seen_tf)}")
    role = (blocks((tf_dir / "crossplane-identity.tf").read_text(encoding="utf-8"), r'resource "aws_iam_role" "crossplane"') or [""])[0]
    expected = cluster_name_max(load_cfn(cfn_dir / "crossplane-identity.yaml"))
    if not re.search(r"condition\s*=\s*length\(var\.cluster_name\)\s*<=\s*" + str(expected) + r"\b", role):
        findings.append(f"Terraform Crossplane role does not refuse a cluster name longer than {expected} characters")


def check(root):
    findings = []
    try:
        emitted_contracts(root, findings)
        check_structure(root, findings)
        check_ebs_storage(root, findings)
        check_crossplane_identity(root, findings)
        check_serverless_identity(root, findings)
        check_identity_inventory(root, findings)
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
        ("serverless provider-aws-iam package", "platform/components/crossplane/packages/packages.yaml", "  name: provider-aws-lambda\nspec:\n  package:", "  name: provider-aws-iam\nspec:\n  package:"),
        ("serverless CloudFront invalidation", "infrastructure/terraform/crossplane-identity.tf", '"cloudfront:GetDistribution", "cloudfront:ListTagsForResource"]', '"cloudfront:GetDistribution", "cloudfront:ListTagsForResource", "cloudfront:CreateInvalidation"]'),
        ("serverless API Gateway write without tag", "infrastructure/cloudformation/crossplane-identity.yaml", "                  - !Sub \"arn:${AWS::Partition}:apigateway:${AWS::Region}::/restapis/*\"\n                Condition:\n                  StringEquals:\n                    aws:ResourceTag/platform: sample-plat\n", "                  - !Sub \"arn:${AWS::Partition}:apigateway:${AWS::Region}::/restapis/*\"\n"),
        ("serverless PassRole of any role", "infrastructure/terraform/crossplane-identity.tf", 'role/${local.crossplane_name_prefix}runtime-${var.cluster_name}"]', 'role/*"]'),
        ("serverless runtime trust widened", "infrastructure/cloudformation/crossplane-identity.yaml", "            Principal: {Service: lambda.amazonaws.com}", "            Principal: {Service: [lambda.amazonaws.com, ec2.amazonaws.com]}"),
        ("serverless origin access control signing drift", "infrastructure/terraform/crossplane-identity.tf", 'signing_behavior                  = "always"', 'signing_behavior                  = "no-override"'),
        ("serverless Terraform output removed", "infrastructure/terraform/outputs.tf", 'output "serverless_oac_id" {', 'output "serverless_oac_identifier" {'),
        ("serverless service account drift", "infrastructure/cloudformation/crossplane-identity.yaml", "    Default: provider-aws-cloudwatchlogs", "    Default: provider-aws-logs"),        ('identity: CloudFormation managed Admin policy on a provider role', 'infrastructure/cloudformation/crossplane-identity.yaml', '      RoleName: !Sub "${ClusterName}-crossplane-lambda"\n', '      RoleName: !Sub "${ClusterName}-crossplane-lambda"\n      ManagedPolicyArns: ["arn:aws:iam::aws:policy/AdministratorAccess"]\n'),
        ('identity: Terraform-only Admin attachment on the provider roles', 'infrastructure/terraform/crossplane-identity.tf', 'resource "aws_eks_pod_identity_association" "crossplane_serverless" {', 'resource "aws_iam_role_policy_attachment" "crossplane_serverless_admin" {\n  for_each   = local.crossplane_identity_enabled ? local.crossplane_serverless_service_accounts : {}\n  role       = aws_iam_role.crossplane_serverless[each.key].name\n  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"\n}\n\nresource "aws_eks_pod_identity_association" "crossplane_serverless" {'),
        ('identity: Terraform-only Admin attachment on the original Crossplane role', 'infrastructure/terraform/crossplane-identity.tf', 'resource "aws_eks_pod_identity_association" "crossplane_serverless" {', 'resource "aws_iam_role_policy_attachment" "crossplane_admin" {\n  count      = local.crossplane_identity_enabled ? 1 : 0\n  role       = aws_iam_role.crossplane[0].name\n  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"\n}\n\nresource "aws_eks_pod_identity_association" "crossplane_serverless" {'),
        ('identity: Terraform-only role associated to another service account', 'infrastructure/terraform/crossplane-identity.tf', 'resource "aws_eks_pod_identity_association" "crossplane_serverless" {', 'resource "aws_iam_role" "rogue" {\n  count              = local.crossplane_identity_enabled ? 1 : 0\n  name               = "${var.cluster_name}-rogue"\n  assume_role_policy = data.aws_iam_policy_document.crossplane_trust[0].json\n}\n\nresource "aws_eks_pod_identity_association" "rogue" {\n  count           = local.crossplane_identity_enabled ? 1 : 0\n  cluster_name    = module.cluster.cluster_name\n  namespace       = local.crossplane_namespace\n  service_account = "default"\n  role_arn        = aws_iam_role.rogue[0].arn\n}\n\nresource "aws_eks_pod_identity_association" "crossplane_serverless" {'),
        ('identity: Terraform-only inline policy on the runtime role', 'infrastructure/terraform/crossplane-identity.tf', 'resource "aws_eks_pod_identity_association" "crossplane_serverless" {', 'resource "aws_iam_role_policy" "runtime_extra" {\n  count  = local.crossplane_identity_enabled ? 1 : 0\n  name   = "extra"\n  role   = aws_iam_role.serverless_runtime[0].id\n  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "dynamodb:*", Resource = "*" }] })\n}\n\nresource "aws_eks_pod_identity_association" "crossplane_serverless" {'),
        ('identity: CloudFormation-only RolePolicy on the runtime role', 'infrastructure/cloudformation/crossplane-identity.yaml', '\nOutputs:\n', '\n  RuntimeExtra:\n    Type: AWS::IAM::RolePolicy\n    Properties:\n      RoleName: !Ref ServerlessRuntimeRole\n      PolicyName: extra\n      PolicyDocument: {Version: "2012-10-17", Statement: [{Effect: Allow, Action: "dynamodb:*", Resource: "*"}]}\n\nOutputs:\n'),
        ('identity: CloudFormation permissions boundary', 'infrastructure/cloudformation/crossplane-identity.yaml', '      RoleName: !Sub "${ClusterName}-crossplane-lambda"\n', '      RoleName: !Sub "${ClusterName}-crossplane-lambda"\n      PermissionsBoundary: !Sub "arn:${AWS::Partition}:iam::aws:policy/AdministratorAccess"\n'),
        ('identity: managed policy of an existing attachment widened', 'infrastructure/terraform/ecr-mirror-identity.tf', '"arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"', '"arn:aws:iam::aws:policy/AdministratorAccess"'),
        ('identity: cluster name limit dropped in CloudFormation', 'infrastructure/cloudformation/crossplane-identity.yaml', '    MaxLength: 38\n', ''),
        ('identity: cluster name limit drift in Terraform', 'infrastructure/terraform/crossplane-identity.tf', 'length(var.cluster_name) <= 38', 'length(var.cluster_name) <= 41'),
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
    serverless_actions = check_serverless_identity(root, [])
    controls = 0 if arguments.skip_mutation_controls else mutation_controls(root)
    print(f"PASS iac-parity contract-keys={len(CONTRACT_KEYS)} fronts=2 shared-bootstrap=1 "
          f"serverless-roles={len(SERVERLESS_PROVIDERS)} serverless-actions={serverless_actions} mutation-controls={controls}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
