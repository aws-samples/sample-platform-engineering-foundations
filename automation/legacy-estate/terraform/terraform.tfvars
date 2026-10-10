# The transformation reads tfvars as one of its identifier sources. These values
# are what make the bucket names and the DB identifier resolvable statically.
account_suffix    = "417256"
environment       = "prod"
db_instance_class = "db.r6g.large"
vpc_id            = "vpc-0f9e2c41a7b3d58e0"
application_cidrs = ["10.0.0.0/16", "10.1.0.0/16"]
