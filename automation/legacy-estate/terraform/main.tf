# =============================================================================
# Legacy estate - payments platform
# =============================================================================
# READ-ONLY INPUT. This is the "inherited" Terraform repository that module 4.2
# transforms into ACK adoption manifests. It is NEVER applied: no `terraform
# init`, no `terraform apply`. Running it would create real resources, and the
# exercise is about reading IaC, not provisioning it.
#
# The estate is deliberately mixed so the transformation output is interesting:
#   - resources whose identifier lives in `spec` (bucket name, role name, DB
#     identifier) resolve statically, straight from these literals
#   - resources whose identifier only exists after an apply (security group id,
#     VPC id) cannot be resolved from source and become TODO(discovery) items
#   - the serverless-api module is a composition unit, so it becomes a kro
#     ResourceGraphDefinition rather than a pile of loose manifests
#
# Only services this workshop enables as ACK controllers are used here: S3, RDS,
# EC2, IAM, Lambda and API Gateway v2.
# =============================================================================

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# -----------------------------------------------------------------------------
# Storage. The bucket name is a literal, so adoption needs no adoption-fields:
# the S3 controller finds the bucket by spec.name.
# -----------------------------------------------------------------------------
resource "aws_s3_bucket" "ledger_archive" {
  bucket = "${var.project}-ledger-archive-${var.account_suffix}"

  tags = {
    Project     = var.project
    Environment = var.environment
    Compliance  = "retain-7y"
  }
}

resource "aws_s3_bucket" "statements" {
  bucket = "${var.project}-customer-statements-${var.account_suffix}"

  tags = {
    Project     = var.project
    Environment = var.environment
  }
}

# -----------------------------------------------------------------------------
# IAM. Role names are literals in spec, so these resolve statically too.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "settlement_worker" {
  name = "${var.project}-settlement-worker"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Project = var.project
  }
}

resource "aws_iam_role_policy_attachment" "settlement_worker_basic" {
  role       = aws_iam_role.settlement_worker.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# -----------------------------------------------------------------------------
# Network. A security group keeps its id in `status`, not `spec`, and that id
# does not exist until an apply. This is the resource that will show up as
# TODO(discovery) in the report, and it is the same failure mode section 4.1
# made you reproduce on purpose.
# -----------------------------------------------------------------------------
resource "aws_security_group" "settlement_db" {
  name        = "${var.project}-settlement-db"
  description = "Postgres access for the settlement engine"
  vpc_id      = var.vpc_id

  ingress {
    description = "Postgres from the application subnets"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.application_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Project = var.project
  }
}

# -----------------------------------------------------------------------------
# Database. dbInstanceIdentifier is in spec, so this one resolves statically.
# -----------------------------------------------------------------------------
resource "aws_db_instance" "settlement" {
  identifier     = "${var.project}-settlement"
  engine         = "postgres"
  engine_version = "17.10"
  instance_class = var.db_instance_class

  allocated_storage = 100
  storage_encrypted = true
  multi_az          = var.environment == "prod"

  db_name  = "settlement"
  username = "settlement_admin"

  vpc_security_group_ids = [aws_security_group.settlement_db.id]
  skip_final_snapshot    = false

  tags = {
    Project     = var.project
    Environment = var.environment
  }
}

# -----------------------------------------------------------------------------
# The composition unit. A module is an architectural statement: these resources
# deploy and evolve together, parameterized by these inputs. The transformation
# turns it into a kro ResourceGraphDefinition plus an instance, instead of
# flattening it into unrelated manifests.
# -----------------------------------------------------------------------------
module "refunds_api" {
  source = "./modules/serverless-api"

  api_name        = "${var.project}-refunds"
  project         = var.project
  environment     = var.environment
  memory_size     = 512
  artifact_bucket = aws_s3_bucket.ledger_archive.bucket
}
