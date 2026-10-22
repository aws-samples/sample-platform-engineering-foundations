locals {
  tags = var.tags
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = var.name })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, { Name = var.name })
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zone
  cidr_block              = var.public_subnet_cidr
  map_public_ip_on_launch = true

  tags = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_subnet" "outpost" {
  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zone
  outpost_arn             = var.outpost_arn
  cidr_block              = var.outpost_subnet_cidr
  map_public_ip_on_launch = false

  tags = merge(local.tags, { Name = "${var.name}-local" })
}

resource "aws_eip" "nat" {
  domain = "vpc"

  depends_on = [aws_internet_gateway.this]

  tags = merge(local.tags, { Name = "${var.name}-nat" })
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id

  depends_on = [aws_internet_gateway.this]

  tags = merge(local.tags, { Name = var.name })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  route_table_id = aws_route_table.public.id
  subnet_id      = aws_subnet.public.id
}

resource "aws_route_table" "outpost" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.tags, { Name = "${var.name}-local" })
}

resource "aws_route" "outpost_default" {
  route_table_id         = aws_route_table.outpost.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this.id
}

resource "aws_route_table_association" "outpost" {
  route_table_id = aws_route_table.outpost.id
  subnet_id      = aws_subnet.outpost.id
}

locals { bastion_cidr = coalesce(var.bastion_cidr, var.public_subnet_cidr) }
