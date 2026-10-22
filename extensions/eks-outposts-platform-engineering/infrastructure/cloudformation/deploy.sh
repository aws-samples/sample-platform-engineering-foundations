#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 parameters.json" >&2; exit 2; }
for tool in aws jq python3; do command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }; done
CONFIG=$1
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
REGION=$(jq -er .region "$CONFIG")
NETWORK=$(jq -er .network_stack "$CONFIG")
CLUSTER=$(jq -er .cluster_stack "$CONFIG")
NODES=$(jq -er .nodes_stack "$CONFIG")
IDENTITY=$(jq -er .identity_stack "$CONFIG")
P(){ jq -er --arg key "$1" '.parameters[$key]' "$CONFIG"; }
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || { echo "unable to confirm AWS account" >&2; exit 2; }
aws cloudformation deploy --region "$REGION" --stack-name "$NETWORK" --template-file "$ROOT/infrastructure/cloudformation/network.yaml" --parameter-overrides OutpostArn="$(P OutpostArn)" AvailabilityZone="$(P AvailabilityZone)" VpcCidr="$(P VpcCidr)" PublicSubnetCidr="$(P PublicSubnetCidr)" OutpostSubnetCidr="$(P OutpostSubnetCidr)" Name=platform-outposts Owner="$(P Owner)" Project="$(P Project)"
SUBNET=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$NETWORK" --query "Stacks[0].Outputs[?OutputKey=='OutpostSubnetId'].OutputValue" --output text)
aws cloudformation deploy --region "$REGION" --stack-name "$CLUSTER" --template-file "$ROOT/infrastructure/cloudformation/cluster.yaml" --capabilities CAPABILITY_NAMED_IAM --parameter-overrides ClusterName="$(P ClusterName)" KubernetesVersion="$(P KubernetesVersion)" ClusterRoleArn="$(P ClusterRoleArn)" OutpostArn="$(P OutpostArn)" SubnetIds="$SUBNET" ControlPlaneInstanceType="$(P ControlPlaneInstanceType)" EtcdInstanceType="$(P EtcdInstanceType)" SpreadLevel=none Owner="$(P Owner)" Project="$(P Project)"
aws eks wait cluster-active --region "$REGION" --name "$(P ClusterName)"
ENDPOINT=$(aws eks describe-cluster --region "$REGION" --name "$(P ClusterName)" --query cluster.endpoint --output text)
CA=$(aws eks describe-cluster --region "$REGION" --name "$(P ClusterName)" --query cluster.certificateAuthority.data --output text)
SERVICE_CIDR=$(aws eks describe-cluster --region "$REGION" --name "$(P ClusterName)" --query cluster.kubernetesNetworkConfig.serviceIpv4Cidr --output text)
SG=$(P NodeSecurityGroupIds)
if [[ "$SG" == "<NODE_SECURITY_GROUP_ID>" ]]; then SG=$(aws eks describe-cluster --region "$REGION" --name "$(P ClusterName)" --query cluster.resourcesVpcConfig.clusterSecurityGroupId --output text); fi
aws cloudformation deploy --region "$REGION" --stack-name "$NODES" --template-file "$ROOT/infrastructure/cloudformation/nodes.yaml" --capabilities CAPABILITY_NAMED_IAM --parameter-overrides ClusterName="$(P ClusterName)" ClusterEndpoint="$ENDPOINT" ClusterCertificateAuthority="$CA" ClusterServiceCidr="$SERVICE_CIDR" OutpostSubnetId="$SUBNET" NodeSecurityGroupIds="$SG" InstanceType="$(P InstanceType)" NodeAmiSsmParameter="/aws/service/eks/optimized-ami/$(P KubernetesVersion)/amazon-linux-2023/x86_64/standard/recommended/image_id" LocalRegistryHost="$(P LocalRegistryHost)" LocalRegistryIp="$(P LocalRegistryIp)" LocalRegistryCaPemBase64="$(P LocalRegistryCaPemBase64)" Owner="$(P Owner)" Project="$(P Project)"
aws cloudformation deploy --region "$REGION" --stack-name "$IDENTITY" --template-file "$ROOT/infrastructure/cloudformation/crossplane-identity.yaml" --capabilities CAPABILITY_NAMED_IAM --parameter-overrides ClusterName="$(P ClusterName)"
python3 "$ROOT/scripts/emit-contract.py" cloudformation --region "$REGION" --network-stack "$NETWORK" --cluster-stack "$CLUSTER" --registry-service-ip "$(P LocalRegistryIp)" > "$ROOT/platform-contract.json"
echo "contract: $ROOT/platform-contract.json"
