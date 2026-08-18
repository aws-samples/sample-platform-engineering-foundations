#!/bin/bash

# Variables
old_owner_name="upbound-provider-family-aws"
new_owner_name="provider-family-aws"
# Get the new UID from providers.pkg.crossplane.io
new_uid=$(kubectl get providers.pkg.crossplane.io $new_owner_name -o jsonpath='{.metadata.uid}')
echo "Replacing with: $(kubectl get providers.pkg.crossplane.io $new_owner_name -o jsonpath='{.spec.image}')"


# Get all CRDs with the old owner name
crds=$(kubectl get crds -o json | jq -r --arg old_owner_name "$old_owner_name" '.items[] | select(.metadata.ownerReferences[]?.name == $old_owner_name) | .metadata.name')

# Loop through each CRD and patch it
for crd in $crds; do
  echo "Patching CRD: $crd"

  # Get the index of the old owner reference
  index=$(kubectl get crd $crd -o json | jq -r --arg old_owner_name "$old_owner_name" '
    .metadata.ownerReferences | to_entries[] | select(.value.name == $old_owner_name) | .key')

  # Check if index was found
  if [ -z "$index" ]; then
    echo "Old owner reference not found for CRD: $crd"
    continue
  fi

  # Patch the CRD
  kubectl patch crd $crd --type='json' -p='[
    {"op": "remove", "path": "/metadata/ownerReferences/'$index'"},
    {"op": "add", "path": "/metadata/ownerReferences/-", "value": {"apiVersion": "pkg.crossplane.io/v1", "kind": "ProviderRevision", "name": "'$new_owner_name'", "uid": "'$new_uid'", "controller": true}}
  ]'
done