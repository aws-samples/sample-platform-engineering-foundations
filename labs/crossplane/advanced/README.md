# Crossplane Serverless Multi-Tier Composition

## 🎯 Overview

This composition provides a **production-ready serverless multi-tier architecture** using Crossplane to orchestrate AWS services. It creates a complete API backend with Lambda functions, DynamoDB tables, and API Gateway - all from a single Kubernetes manifest.

**Architecture**: API Gateway → Lambda → DynamoDB (Users & Posts tables)

**Region**: us-west-2 (Oregon)

---

## 📋 Table of Contents

1. [What This Composition Does](#what-this-composition-does)
2. [Architecture](#architecture)
3. [Components](#components)
4. [Workshop Integration](#workshop-integration)
5. [Installation](#installation)
6. [Usage](#usage)
7. [Customization](#customization)

---

## What This Composition Does

### The Problem

Creating a serverless API on AWS requires:
- Lambda function with IAM roles and policies
- DynamoDB tables with proper configuration
- API Gateway with OpenAPI specification
- CloudWatch logs and monitoring
- Security groups and networking
- **~500+ lines of CloudFormation/Terraform**

### The Solution

With this Crossplane Composition:

```yaml
apiVersion: app.platform.cloud/v1alpha1
kind: ServerlessMultiTier
metadata:
  name: my-api
spec:
  parameters:
    region: us-west-2
    name: my-api
    lambda:
      s3Bucket: my-lambda-bucket
      s3Key: function.zip
      size: medium
    database:
      attribute:
        - name: id
          type: "N"
      hashKey: id
    api:
      openApiSpecification: '{...}'
```

**Result**: Complete serverless API with ~50 lines of YAML

---

## Architecture

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Request                              │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                      API Gateway (REST)                          │
│  • OpenAPI 3.0 Specification                                    │
│  • CORS enabled                                                 │
│  • Lambda proxy integration                                     │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Lambda Function (Python)                      │
│  • Runtime: Python 3.x                                          │
│  • Memory: 256MB - 4096MB (configurable)                        │
│  • Timeout: 60s                                                 │
│  • Environment: DynamoDB table names                            │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                    DynamoDB Tables (2)                           │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │   Users Table    │  │   Posts Table    │                    │
│  │  • PAY_PER_REQ   │  │  • PAY_PER_REQ   │                    │
│  │  • Hash Key: id  │  │  • Hash Key: id  │                    │
│  └──────────────────┘  └──────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/v1/users` | List all users |
| POST | `/api/v1/users` | Create user |
| GET | `/api/v1/users/{id}` | Get user by ID |
| PUT | `/api/v1/users/{id}` | Update user |
| DELETE | `/api/v1/users/{id}` | Delete user |
| GET | `/api/v1/posts` | List all posts |
| POST | `/api/v1/posts` | Create post |
| GET | `/api/v1/posts/{id}` | Get post by ID |
| PUT | `/api/v1/posts/{id}` | Update post |
| DELETE | `/api/v1/posts/{id}` | Delete post |

---

## Components

### 1. XRD (CompositeResourceDefinition)

**File**: `workshop-setup/platform/backstage/templates/custom-catalog/app/serverless-multi-tier/definition.yaml`

Defines the API schema for ServerlessMultiTier:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xserverlessmultitiers.app.platform.cloud
spec:
  group: app.platform.cloud
  names:
    kind: XServerlessMultiTier
    plural: xserverlessmultitiers
  claimNames:
    kind: ServerlessMultiTier
    plural: serverlessmultitiers
```

**Key Parameters**:
- `region`: AWS region
- `name`: Application name
- `lambda.s3Bucket`: S3 bucket with Lambda code
- `lambda.s3Key`: S3 key for Lambda zip
- `lambda.size`: small (256MB), medium (1GB), large (2GB), xlarge (4GB)
- `database.attribute`: DynamoDB attributes
- `database.hashKey`: Primary key
- `api.openApiSpecification`: OpenAPI 3.0 spec

### 2. Composition

**File**: `workshop-setup/platform/backstage/templates/custom-catalog/app/serverless-multi-tier/v0.0.1/composition.yaml`

Implements the abstraction using Crossplane pipeline mode:

**Pipeline Steps**:

1. **parse-and-extract** (function-go-templating)
   - Extracts Lambda ARN from status
   - Parses OpenAPI spec
   - Replaces placeholders (##lambda_arn##, ##region##)

2. **create-resources** (function-patch-and-transform)
   - Creates 2 DynamoDB tables (users, posts)
   - Creates Lambda function
   - Creates API Gateway REST API
   - Configures IAM roles and policies

**Resources Created**:
- `database-users`: XDynamoDBTable
- `database-posts`: XDynamoDBTable
- `lambda-function`: XLambdaFunction
- `api-gateway`: XAPIGatewayREST

### 3. Lambda Function

**File**: `workshop-setup/function-python-users-posts/main.py`

Python Lambda function with:
- **CRUD operations** for Users and Posts
- **DynamoDB integration** via boto3
- **Error handling** and validation
- **CORS support**
- **Health check endpoint**

**Key Features**:
```python
# Database operations
def get_user(user_id)
def create_user(name, email)
def update_user(user_id, name, email)
def delete_user(user_id)

def get_post(post_id)
def create_post(title, content, user_id)
def update_post(post_id, title, content)
def delete_post(post_id)
```

### 4. Crossplane Providers

**Required Providers** (in `workshop-setup/configs/`):
- `provider-lambda.yaml`: AWS Lambda
- `provider-dynamo.yaml`: DynamoDB
- `provider-apigateway.yaml`: API Gateway
- `provider-s3.yaml`: S3 (for Lambda code)
- `provider-kubernetes.yaml`: Kubernetes resources

**Functions**:
- `function-go-templating.yaml`: Template processing
- `function-patch-and-transform.yaml`: Resource patching
- `function-auto-ready.yaml`: Auto-readiness

---

## Workshop Integration

### For EKS Auto Mode + Capabilities Workshop

This composition integrates with the **Platform Engineering Foundations on AWS** workshop:

**Module 02: EKS Capabilities**
- ✅ Uses **Crossplane** for infrastructure orchestration
- ✅ Deploys via **ArgoCD** for GitOps
- ✅ Can use **Kro** for additional resource orchestration
- ✅ Complements **ACK** for AWS service management

### Workshop Flow

```
1. Setup EKS Auto Mode cluster
   ↓
2. Enable EKS Capabilities (ArgoCD, Kro, ACK)
   ↓
3. Install Crossplane
   ↓
4. Install Crossplane Providers
   ↓
5. Deploy Serverless Multi-Tier Composition
   ↓
6. Create ServerlessMultiTier Claim
   ↓
7. Verify AWS resources created
```

---

## Installation

### Prerequisites

- EKS cluster with Auto Mode enabled
- EKS Capabilities enabled (ArgoCD, Kro, ACK)
- kubectl configured
- AWS credentials configured

### Step 1: Install Crossplane

```bash
# Add Crossplane Helm repo
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update

# Install Crossplane
helm install crossplane \
  crossplane-stable/crossplane \
  --namespace crossplane-system \
  --create-namespace \
  --wait
```

### Step 2: Install Providers

```bash
cd workshop-setup/configs

# Install all providers
kubectl apply -f provider-lambda.yaml
kubectl apply -f provider-dynamo.yaml
kubectl apply -f provider-apigateway.yaml
kubectl apply -f provider-s3.yaml
kubectl apply -f provider-kubernetes.yaml

# Install functions
kubectl apply -f function-go-templating.yaml
kubectl apply -f function-patch-and-transform.yaml
kubectl apply -f function-auto-ready.yaml

# Wait for providers to be healthy
kubectl wait --for=condition=healthy provider.pkg.crossplane.io --all --timeout=300s
```

### Step 3: Configure AWS Provider

```bash
# Create AWS credentials secret
kubectl create secret generic aws-creds \
  -n crossplane-system \
  --from-literal=credentials="[default]
aws_access_key_id = YOUR_ACCESS_KEY
aws_secret_access_key = YOUR_SECRET_KEY"

# Create ProviderConfig
cat <<EOF | kubectl apply -f -
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: aws-creds
      key: credentials
EOF
```

### Step 4: Deploy Composition

```bash
cd workshop-setup/platform/backstage/templates/custom-catalog/app/serverless-multi-tier

# Deploy XRD
kubectl apply -f definition.yaml

# Deploy Composition
kubectl apply -f v0.0.1/composition.yaml

# Verify
kubectl get xrd
kubectl get composition
```

---

## Usage

### Step 1: Upload Lambda Code to S3

```bash
cd workshop-setup/function-python-users-posts

# Zip Lambda function
zip -r function.zip main.py db.py domain.py __init__.py

# Upload to S3
aws s3 mb s3://my-lambda-bucket-$(date +%s)
aws s3 cp function.zip s3://my-lambda-bucket-XXXXX/function-python-users-posts.zip
```

### Step 2: Create ServerlessMultiTier Claim

```yaml
apiVersion: app.platform.cloud/v1alpha1
kind: ServerlessMultiTier
metadata:
  name: my-api
  namespace: default
spec:
  compositionSelector:
    matchLabels:
      app.platform.cloud/type: serverlessmultitier
  parameters:
    region: us-west-2
    deletionPolicy: Delete
    providerConfigRef:
      name: default
    name: my-api
    database:
      attribute:
        - name: id
          type: "N"
      hashKey: id
    lambda:
      s3Bucket: my-lambda-bucket-XXXXX
      s3Key: function-python-users-posts.zip
      size: medium
    api:
      openApiSpecification: '{"openapi":"3.0.1",...}'  # See examples/xr.yaml
    tags:
      app: "my-api"
      env: "dev"
```

### Step 3: Apply and Monitor

```bash
# Apply claim
kubectl apply -f my-api-claim.yaml

# Watch resources being created
kubectl get serverlessmultitier
kubectl get xserverlessmultitier
kubectl get managed

# Check status
kubectl describe serverlessmultitier my-api
```

### Step 4: Get API Endpoint

```bash
# Get API Gateway URL
kubectl get serverlessmultitier my-api -o jsonpath='{.status.api.endpoint}'

# Test health endpoint
curl https://YOUR_API_ID.execute-api.us-west-2.amazonaws.com/health
```

### Step 5: Test API

```bash
API_URL="https://YOUR_API_ID.execute-api.us-west-2.amazonaws.com"

# Create user
curl -X POST $API_URL/api/v1/users \
  -H "Content-Type: application/json" \
  -d '{"name":"John Doe","email":"john@example.com"}'

# List users
curl $API_URL/api/v1/users

# Create post
curl -X POST $API_URL/api/v1/posts \
  -H "Content-Type: application/json" \
  -d '{"title":"My Post","content":"Hello World","user_id":1}'

# List posts
curl $API_URL/api/v1/posts
```

---

## Customization

### Lambda Size Options

| Size | Memory | Use Case |
|------|--------|----------|
| `small` | 256 MB | Simple CRUD operations |
| `medium` | 1024 MB | Standard APIs (recommended) |
| `large` | 2048 MB | Heavy processing |
| `xlarge` | 4096 MB | ML inference, large datasets |

### DynamoDB Configuration

**Billing Mode**: PAY_PER_REQUEST (on-demand)

**Custom Attributes**:
```yaml
database:
  attribute:
    - name: id
      type: "N"  # Number
    - name: email
      type: "S"  # String
  hashKey: id
  rangeKey: email  # Optional sort key
```

### API Gateway CORS

Already configured in OpenAPI spec:
```json
"x-amazon-apigateway-cors": {
  "allowOrigins": ["*"],
  "allowMethods": ["GET","POST","PUT","DELETE","OPTIONS"],
  "allowHeaders": ["Content-Type","Authorization"],
  "maxAge": 86400
}
```

---

## Troubleshooting

### Providers Not Healthy

```bash
# Check provider status
kubectl get provider

# Check provider logs
kubectl logs -n crossplane-system -l pkg.crossplane.io/provider=provider-aws-lambda
```

### Composition Not Creating Resources

```bash
# Check XR status
kubectl describe xserverlessmultitier

# Check events
kubectl get events --sort-by='.lastTimestamp'

# Check Crossplane logs
kubectl logs -n crossplane-system deployment/crossplane -f
```

### Lambda Function Fails

```bash
# Check Lambda logs in CloudWatch
aws logs tail /aws/lambda/my-api-function --follow --region us-west-2

# Check IAM permissions
aws lambda get-function --function-name my-api-function --region us-west-2
```

### API Gateway 403 Errors

```bash
# Check Lambda permissions
aws lambda get-policy --function-name my-api-function --region us-west-2

# Add API Gateway invoke permission if missing
aws lambda add-permission \
  --function-name my-api-function \
  --statement-id apigateway-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --region us-west-2
```

---

## Cleanup

```bash
# Delete claim (will delete all AWS resources)
kubectl delete serverlessmultitier my-api

# Verify resources deleted
kubectl get managed

# Delete composition and XRD
kubectl delete composition xserverlessmultitier.app.platform.cloud
kubectl delete xrd xserverlessmultitiers.app.platform.cloud

# Uninstall providers
kubectl delete provider provider-aws-lambda
kubectl delete provider provider-aws-dynamodb
kubectl delete provider provider-aws-apigateway

# Uninstall Crossplane
helm uninstall crossplane -n crossplane-system
```

---

## Files Reference

```
composition-serverless-multi-tier/
├── README.md (this file)
└── workshop-setup/
    ├── configs/
    │   ├── provider-lambda.yaml
    │   ├── provider-dynamo.yaml
    │   ├── provider-apigateway.yaml
    │   ├── provider-s3.yaml
    │   ├── provider-kubernetes.yaml
    │   ├── function-go-templating.yaml
    │   ├── function-patch-and-transform.yaml
    │   └── setup-crossplane-provider.sh
    ├── function-python-users-posts/
    │   ├── main.py (Lambda handler)
    │   ├── db.py (DynamoDB operations)
    │   └── domain.py (Data models)
    ├── platform/backstage/templates/custom-catalog/app/serverless-multi-tier/
    │   ├── definition.yaml (XRD)
    │   ├── v0.0.1/composition.yaml (Composition)
    │   ├── examples/xr.yaml (Example claim)
    │   └── examples/swagger.yaml (Full OpenAPI spec)
    └── static/ (Frontend React app)
```

---

## Next Steps

1. **Integrate with ArgoCD**: Deploy composition via GitOps
2. **Add Monitoring**: CloudWatch dashboards and alarms
3. **Add Authentication**: API Gateway authorizers
4. **Add CI/CD**: Automate Lambda deployments
5. **Add Frontend**: Deploy React app from `static/` folder
6. **Scale**: Add more Lambda functions and DynamoDB tables

---

## References

- **Workshop**: Platform Engineering Foundations on AWS
- **Crossplane Docs**: https://docs.crossplane.io/
- **AWS Provider**: https://marketplace.upbound.io/providers/upbound/provider-aws/
- **Composition Functions**: https://docs.crossplane.io/latest/concepts/composition-functions/

---

**Created**: 2026-03-04  
**Version**: 1.0  
**Region**: us-west-2 (Oregon)
