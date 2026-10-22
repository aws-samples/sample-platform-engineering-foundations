#!/usr/bin/env python3
import json, re, sys
from pathlib import Path
required = {"cluster_name", "aws_region", "account_id", "outpost_arn", "kubernetes_version", "registry_service_ip", "node_subnet_cidr", "bastion_subnet_cidr", "kubernetes_service_ip_cidr", "cluster_dns_service_ip", "ebs_csi_controller_credential_cidr"}
if len(sys.argv) != 3:
    raise SystemExit("usage: render-secret.py contract.json template.yaml")
data = json.loads(Path(sys.argv[1]).read_text())
missing = sorted(required - data.keys())
invalid = sorted(key for key in required if data.get(key) in (None, "", "disabled"))
if missing:
    raise SystemExit("missing contract keys: " + ", ".join(missing))
if invalid:
    raise SystemExit("invalid contract values: " + ", ".join(invalid))
data["gitea_repo"] = data.get("gitea_repo", "http://gitea-http.git-local.svc.cluster.local:3000/platform-admin/platform-demo.git")
text = Path(sys.argv[2]).read_text()
for key, value in data.items():
    text = text.replace("${" + key.upper() + "}", str(value))
left = sorted(set(re.findall(r"\$\{[A-Z0-9_]+\}", text)))
if left:
    raise SystemExit("unresolved template keys: " + ", ".join(left))
print(text, end="")
