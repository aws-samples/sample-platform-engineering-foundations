# Cleanup

Delete in reverse order of creation, and remove what the labs created *inside* the clusters before
deleting the stacks that own the clusters. Skipping that order is the usual reason a stack sits in
`DELETE_IN_PROGRESS` for an hour and then fails.

Three NAT Gateways and three EKS control planes bill by the hour whether or not anyone is using
them, so cleanup is also the main cost control.

---

## Order

```
1. Resources created BY the clusters during the labs
     Crossplane claims and composite resources
     ACK resources
     kro instances
     Kubernetes ingresses and Services of type LoadBalancer
2. IDE stack        psp-workshop-code-editor
3. Main stack       psp-workshop-eks
4. Verify nothing survived
```

---

## 1. Remove what the labs created

These are real AWS resources whose lifecycle is owned by controllers in the cluster. CloudFormation
does not know about them, so deleting the stack will not remove them, and in some cases the leftover
resources block VPC deletion.

Do this for each cluster you used.

```bash
aws eks update-kubeconfig --name psp-cluster-1-platform --region us-east-1
```

### Crossplane

```bash
# Claims and composite resources first, so compositions delete their managed resources
kubectl get composite -A
kubectl delete composite --all -A

kubectl get managed
kubectl delete managed --all
```

Wait until `kubectl get managed` returns nothing before moving on. Crossplane deletes the underlying
AWS resources asynchronously, and deleting the provider while managed resources remain leaves
orphans in your account.

### ACK

```bash
# Reverse of the order used to create them
kubectl delete -f labs/ack/basic/resources/ --ignore-not-found
```

> Anything you adopted following `automation/ack-resource-adoption` should carry
> `services.k8s.aws/deletion-policy: retain`, so deleting the Kubernetes resource leaves the AWS
> resource in place. That is intentional. If you also want the AWS resource gone, delete it directly.

### kro

```bash
kubectl delete -f labs/kro/basic/instances/ --ignore-not-found
kubectl delete -f labs/kro/basic/resource-group/ --ignore-not-found
```

### Load balancers created from Kubernetes

Ingresses and Services of type LoadBalancer create load balancers, target groups, and security
groups outside CloudFormation's knowledge. Remove them before the stacks.

```bash
kubectl get ingress -A
kubectl get svc -A --field-selector spec.type=LoadBalancer

kubectl delete ingress --all -A
kubectl delete svc --all -A --field-selector spec.type=LoadBalancer
```

---

## 2. Delete the IDE stack

```bash
aws cloudformation delete-stack --stack-name psp-workshop-code-editor --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name psp-workshop-code-editor --region us-east-1
```

---

## 3. Delete the main stack

```bash
aws cloudformation delete-stack --stack-name psp-workshop-eks --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name psp-workshop-eks --region us-east-1
```

The ECR repository must be empty, or deletion fails:

```bash
aws ecr list-images --repository-name <BackstageECRRepositoryUri basename> --region us-east-1
aws ecr batch-delete-image --repository-name <name> --image-ids imageTag=latest --region us-east-1
```

---

## 4. Verify

```bash
aws eks list-clusters --region us-east-1
aws ec2 describe-vpcs --region us-east-1 \
  --filters "Name=tag:Name,Values=psp-*" --query 'Vpcs[].VpcId'
aws ec2 describe-nat-gateways --region us-east-1 \
  --filter "Name=state,Values=available" --query 'NatGateways[].NatGatewayId'
aws ec2 describe-addresses --region us-east-1 --query 'Addresses[].PublicIp'
aws elbv2 describe-load-balancers --region us-east-1 --query 'LoadBalancers[].LoadBalancerName'
```

Elastic IPs and NAT Gateways are the two that most often survive and keep billing. An unattached
Elastic IP costs money precisely because it is unattached.

---

## When stack deletion gets stuck

### A namespace stays in `Terminating`

Usually a finalizer waiting on something that no longer exists, or pods on a node the API server
cannot reach.

```bash
kubectl delete pods --all -n <namespace> --force --grace-period=0
kubectl get namespace <namespace> -o json | jq '.spec.finalizers'
```

Only clear a finalizer after confirming in the AWS console or CLI that the resource it protects is
actually gone.

### VPC deletion fails on dependencies

Something is still attached. Common culprits are a load balancer created from Kubernetes, an ENI
left behind by a deleted load balancer, or a security group referenced by a rule in another group.

```bash
aws ec2 describe-network-interfaces --region us-east-1 \
  --filters "Name=vpc-id,Values=<vpc-id>" \
  --query 'NetworkInterfaces[].{ID:NetworkInterfaceId,Desc:Description,Status:Status}'
```

### A security group cannot be deleted

A security group cannot be removed while another group's rule references it. Find the referencing
groups and revoke those rules first:

```bash
aws ec2 describe-security-groups --region us-east-1 \
  --query "SecurityGroups[?IpPermissions[?UserIdGroupPairs[?GroupId=='<sg-id>']]].GroupId"
```

### Peering connections

Deleting the VPCs removes the peering connections. If a connection lingers in `deleting`, it clears
on its own; it does not incur charges.

---

## Fastest path if you no longer care about the account contents

For a throwaway sandbox account, deleting the two stacks and then removing whatever the verification
commands above still report is quicker than working through the cluster-side cleanup. Do not do this
in a shared account: orphaned load balancers, Elastic IPs, and ENIs will keep billing and will
confuse the next person to use it.
