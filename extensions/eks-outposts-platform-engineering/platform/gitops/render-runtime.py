#!/usr/bin/env python3
import json, sys
from pathlib import Path
if len(sys.argv) != 3:
    raise SystemExit("usage: render-runtime.py contract.json runtime-repo")
data=json.loads(Path(sys.argv[1]).read_text())
keys={
  "OUTPOST_SUBNET_CIDR": "node_subnet_cidr",
  "BASTION_SUBNET_CIDR": "bastion_subnet_cidr",
  "KUBERNETES_SERVICE_IP_CIDR": "kubernetes_service_ip_cidr",
  "CLUSTER_DNS_SERVICE_IP": "cluster_dns_service_ip",
  "EBS_CSI_CONTROLLER_CREDENTIAL_CIDR": "ebs_csi_controller_credential_cidr",
}
missing=[source for source in keys.values() if source not in data]
invalid=[source for source in keys.values() if data.get(source) in (None, "", "disabled")]
if missing: raise SystemExit("missing runtime contract keys: " + ", ".join(missing))
if invalid: raise SystemExit("invalid runtime contract values: " + ", ".join(invalid))
root=Path(sys.argv[2])
paths=list((root/"components"/"network-policies").glob("*.yaml")) + list((root/"apps"/"network-policy-demo").glob("*.yaml")) + [root/"components"/"crossplane"/"ca"/"networkpolicies.yaml", root/"components"/"node-local-dns"/"node-local-dns.yaml"]
for path in paths:
    text=path.read_text()
    for token, source in keys.items(): text=text.replace("${"+token+"}", str(data[source]))
    left=[token for token in keys if "${"+token+"}" in text]
    if left: raise SystemExit(f"{path}: unresolved runtime keys: {left}")
    path.write_text(text)
