

#!/bin/bash

# Fail fast
set -euo pipefail

# === CONFIGURATION ===
kubectl apply -f .

# # === CONFIGURATION ===
# CLUSTER_NAME="modern-engineering"
# REGION="us-west-2"
# NAMESPACE="crossplane-system"
# POLICY_NAME="crossplane-kubernetes-provider-policy"
# SERVICE_ACCOUNT_NAME="crossplane-irsa-kubernetes-provider-sa"
# PROVIDER_MANIFEST="kubernetes-provider.yaml"

# # Get AWS Account ID dynamically
# ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# echo "Using AWS Account ID: $ACCOUNT_ID"

# # Step 1: Apply the provider manifest
# echo "Applying provider manifest..."
# kubectl apply -f "$PROVIDER_MANIFEST"

# # Step 2: Create IAM policy
# echo "Creating IAM policy..."
# POLICY_ARN="arn:aws:iam::$ACCOUNT_ID:policy/$POLICY_NAME"
# aws iam create-policy \
#   --policy-name "$POLICY_NAME" \
#   --policy-document "{
#     \"Version\": \"2012-10-17\",
#     \"Statement\": [
#       {
#         \"Effect\": \"Allow\",
#         \"Action\": [ \"eks:DescribeCluster\" ],
#         \"Resource\": \"arn:aws:eks:$REGION:$ACCOUNT_ID:cluster/$CLUSTER_NAME\"
#       }
#     ]
#   }" || echo "Policy may already exist. Skipping."

# # Step 3: Create IAM service account
# echo "Creating IAM service account..."
# eksctl create iamserviceaccount \
#   --name "$SERVICE_ACCOUNT_NAME" \
#   --namespace "$NAMESPACE" \
#   --cluster "$CLUSTER_NAME" \
#   --attach-policy-arn "$POLICY_ARN" \
#   --approve

# # Step 4: Patch deployment
# echo "Patching Crossplane provider deployment..."
# kubectl patch deployment provider-kubernetes-af58fcd0ba4b \
#   -n "$NAMESPACE" \
#   --type json \
#   -p "[{\"op\": \"replace\", \"path\": \"/spec/template/spec/serviceAccountName\", \"value\": \"$SERVICE_ACCOUNT_NAME\"}]"

# # Step 5: Restart provider pod
# echo "Restarting Crossplane provider pod..."
# kubectl delete pod -n "$NAMESPACE" -l pkg.crossplane.io/provider=provider-kubernetes

# echo "Done!"

