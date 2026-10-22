# EC2 instance store boundary

This extension provisions platform PVCs through `ec2-instance-store-sc`, backed by the EKS EC2 local instance store CSI driver. Data survives a regional network interruption but does not survive node termination. Back up anything that must outlive a node.

The source implementation was not validated on an EC2 instance store Outpost. Before deployment, verify that the selected node type is supported by the driver, run `bash preflight.sh`, install a pinned add-on version while connected, and apply `smoke-test.yaml`. This package must not be presented as hardware-validated until those checks pass on the target Outpost.
