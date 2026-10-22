#!/usr/bin/env python3
import argparse, ipaddress, json, subprocess

def run(*args): return subprocess.check_output(args, text=True).strip()
def service_ip(cidr): return str(next(ipaddress.ip_network(cidr).hosts())) + "/32"
def main():
  p=argparse.ArgumentParser(); sp=p.add_subparsers(dest="mode", required=True)
  c=sp.add_parser("cloudformation"); c.add_argument("--region", required=True); c.add_argument("--network-stack", required=True); c.add_argument("--cluster-stack", required=True); c.add_argument("--registry-service-ip", required=True)
  t=sp.add_parser("terraform"); t.add_argument("--directory", required=True)
  a=p.parse_args()
  if a.mode=="terraform":
    raw=json.loads(run("terraform", f"-chdir={a.directory}", "output", "-json")); values={k:v["value"] for k,v in raw.items()}; data={"cluster_name":values["cluster_name"],"aws_region":values["region"],"account_id":values["account_id"],"outpost_arn":values["outpost_arn"],"kubernetes_version":values["local_cluster_version"],"registry_service_ip":values["registry_service_ip"],"node_subnet_cidr":values["node_subnet_cidr"],"bastion_subnet_cidr":values["bastion_cidr"],"kubernetes_service_ip_cidr":values["kubernetes_service_ip_cidr"],"cluster_dns_service_ip":values["cluster_dns_service_ip"]}
  else:
    def outputs(stack):
      raw=json.loads(run("aws","cloudformation","describe-stacks","--region",a.region,"--stack-name",stack,"--output","json")); return {x["OutputKey"]:x["OutputValue"] for x in raw["Stacks"][0].get("Outputs",[])}
    n,c=outputs(a.network_stack),outputs(a.cluster_stack)
    cluster=json.loads(run("aws","eks","describe-cluster","--region",a.region,"--name",c["ClusterName"],"--output","json"))["cluster"]
    data={"cluster_name":c["ClusterName"],"aws_region":n["Region"],"account_id":n["AccountId"],"outpost_arn":n["OutpostArn"],"kubernetes_version":c["LocalClusterVersion"],"registry_service_ip":a.registry_service_ip,"node_subnet_cidr":n["NodeSubnetCidr"],"bastion_subnet_cidr":n["BastionCidr"],"kubernetes_service_ip_cidr":service_ip(cluster["kubernetesNetworkConfig"]["serviceIpv4Cidr"]),"cluster_dns_service_ip":str(ipaddress.ip_network(cluster["kubernetesNetworkConfig"]["serviceIpv4Cidr"]).network_address + 10)}
  data["ebs_csi_controller_credential_cidr"]="169.254.170.23/32"
  data["gitea_repo"]="http://gitea-http.git-local.svc.cluster.local:3000/platform-admin/platform-demo.git"
  print(json.dumps(data, indent=2))
if __name__=="__main__": main()
