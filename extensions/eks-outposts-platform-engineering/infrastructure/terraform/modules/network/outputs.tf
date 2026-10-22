output "vpc_id" { value = aws_vpc.this.id }
output "public_subnet_id" { value = aws_subnet.public.id }
output "outpost_subnet_id" { value = aws_subnet.outpost.id }
output "outpost_route_table_id" { value = aws_route_table.outpost.id }
output "public_route_table_id" { value = aws_route_table.public.id }
output "nat_gateway_id" { value = aws_nat_gateway.this.id }
output "outpost_subnet_cidr" { value = aws_subnet.outpost.cidr_block }
output "bastion_cidr" { value = local.bastion_cidr }
