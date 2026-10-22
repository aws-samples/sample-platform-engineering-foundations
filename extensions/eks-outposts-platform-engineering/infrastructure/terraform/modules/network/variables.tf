variable "name" { type = string }
variable "outpost_arn" { type = string }
variable "availability_zone" { type = string }
variable "vpc_cidr" { type = string }
variable "public_subnet_cidr" { type = string }
variable "outpost_subnet_cidr" { type = string }
variable "bastion_cidr" {
  type    = string
  default = null
}
variable "tags" {
  type    = map(string)
  default = {}
}
