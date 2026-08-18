#!/bin/bash

export AWS_PAGER=""

# Set security group names
SOURCE_SG_TAG_NAME="modern-engineering-node"
TARGET_SG_TAG_NAME="eks-cluster-sg-modern-engineering-223581541"

# Optional: set region
AWS_REGION="us-west-2"

# Get the security group IDs from their names
SOURCE_SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=${SOURCE_SG_TAG_NAME}" \
  --query "SecurityGroups[0].GroupId" \
  --output text \
  --region "${AWS_REGION}")

TARGET_SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=tag:Name,Values=${TARGET_SG_TAG_NAME}" \
  --query "SecurityGroups[0].GroupId" \
  --output text \
  --region "${AWS_REGION}")

if [[ -z "$SOURCE_SG_ID" || -z "$TARGET_SG_ID" ]]; then
  echo "Failed to retrieve one or both security group IDs."
  exit 1
fi

# Add inbound rule to allow all traffic from source SG to target SG
aws ec2 authorize-security-group-ingress \
  --group-id "$TARGET_SG_ID" \
  --protocol -1 \
  --source-group "$SOURCE_SG_ID" \
  --region "$AWS_REGION"

if [[ $? -eq 0 ]]; then
  echo "Inbound rule successfully added: $SOURCE_SG_TAG_NAME -> $TARGET_SG_TAG_NAME"
else
  echo "Could not add rule (possibly already exists or permission issue)."
fi