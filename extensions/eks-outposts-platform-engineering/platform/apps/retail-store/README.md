# Local Retail Store

A local workload that is created and keeps working without the AWS Region: the storefront of the [AWS Retail Store sample application](https://github.com/aws-containers/retail-store-sample-app) with a real cart persisted in DynamoDB Local, all inside the cluster. It is the workload the [egress cut scene](../../components/chaos-egress/README.md#the-8-minute-scene) creates while the platform has no route to the Region.

Source: `aws-containers/retail-store-sample-app` release `v1.6.3`, commit `d7a380b843e0759e58754f74188ea18252a51415`, license MIT-0 (third-party attribution: `src/ui/ATTRIBUTION.md` and `src/cart/ATTRIBUTION.md` of the same commit). The manifest derives from the `src/ui/chart` and `src/cart/chart` charts of that commit: same ports, readiness checks, user 1000, read-only root file system and `/tmp` in memory.

## What runs

| Pod | Image (local Harbor, by index digest) | Role |
|---|---|---|
| `retail-ui` | `apps/retail-store-sample-ui:1.6.3` | Storefront. Catalog, orders and checkout use the UI built-in mocks; only the cart is real |
| `retail-cart` | `apps/retail-store-sample-cart:1.6.3` | Cart API, `RETAIL_CART_PERSISTENCE_PROVIDER=dynamodb`, table `Items`, `CREATE_TABLE=false`, endpoint `http://retail-dynamodb:8000` |
| `retail-dynamodb`, container `dynamodb` | `apps/aws-dynamodb-local:1.25.1` | DynamoDB Local, in memory, `-sharedDb`. Demo only: one pod, no high availability, no backup; recreating the pod deletes the carts |
| `retail-dynamodb`, container `table-init` | `apps/aws-cli:2.39.1` | Sidecar on the official AWS CLI image. Creates `Items` with the schema the Cart would create, then keeps reconciling |

The four images are in [`../../components/registry/images.txt`](../../components/registry/images.txt) (Harbor project `apps`), so the shared bootstrap mirrors them while connected.

Why a sidecar: with `CREATE_TABLE=true`, Cart v1.6.3 deletes and recreates the table on every start, so restarting only the Cart would wipe every cart. The Cart runs with `CREATE_TABLE=false` and the sidecar owns the table:

- It talks to `http://127.0.0.1:8000` inside the pod, runs `describe-table` and calls `create-table` only on `ResourceNotFoundException`. An existing table, or `ResourceInUseException` from a concurrent create, is a no-op. No path deletes, updates or writes items. It describes again every 10 s.
- The sidecar readiness passes only while `Items` was seen `ACTIVE` in the last three rounds, so the database pod, and the `retail-dynamodb` Service endpoint, are Ready only with the table in place. A stuck loop restarts only the sidecar; the in-memory data stays.
- After a DynamoDB Local restart, the demo carts are lost by design; the sidecar recreates an empty `Items` and the Cart API works again without a manual step.
- Argo CD sync waves: wave 0 (database, Services, NetworkPolicies, UI), then wave 1 the Cart, which reads `Items` at startup.

The Cart and the sidecar carry placeholder AWS credentials (`localdemoonly`) because the SDK requires one even with a local endpoint. They grant nothing: the endpoint is local, and no NetworkPolicy lets the pods leave the namespace.

## What the platform enforces

- Images only from `harbor.local` by digest.
- Network: [`namespace.yaml`](namespace.yaml) sets default deny plus DNS. [`retail-store.yaml`](retail-store.yaml) opens only UI -> Cart :8080 -> DynamoDB Local :8000. No egress rule leaves the namespace, so the store is born without a route to the Region or the Internet, independent of any `NetworkChaos`. The egress cut refuses `retail-*` namespaces as targets.
- Exposure: every Service is `ClusterIP`, and the quota sets `services.loadbalancers` and `services.nodeports` to `0`. Reach the storefront with `kubectl port-forward`.
- Capacity: 534m CPU and 1.625 GiB of memory requested in steady state, sidecar included; no container above the LimitRange maximum of 2 GiB. The quota also covers one rolling-update surge pod.

## Enable, use and remove

The ApplicationSet renders the Application `retail-store` only for a cluster Secret labeled `enable_retail_store=true`:

```bash
kubectl -n argocd label secret <cluster-name> enable_retail_store=true --overwrite
kubectl -n argocd wait application/retail-store --for=jsonpath='{.status.health.status}'=Healthy --timeout=10m
kubectl -n retail-store port-forward svc/retail-ui 8080:80
```

Open `http://127.0.0.1:8080`, add an item to the cart, then prove that the cart survives a Cart-only restart:

```bash
kubectl -n retail-store rollout restart deployment/retail-cart
kubectl -n retail-store rollout status deployment/retail-cart --timeout=5m
```

To remove the store, delete the label; the ApplicationSet preserves resources on deletion, so delete the namespace too:

```bash
kubectl -n argocd label secret <cluster-name> enable_retail_store-
kubectl -n argocd delete application retail-store --ignore-not-found
kubectl delete namespace retail-store --ignore-not-found
```

## Tests

```bash
python3 platform/apps/retail-store/tests/test_retail_store.py
```

The test is offline. It checks the manifest, network, capacity and delivery contract, and it runs the sidecar script locally against a fake `aws` and `sleep` with DynamoDB state: slow endpoint, existing table with an item, memory loss while the sidecar is alive, and a non-ResourceNotFound error. Each control (a public image, an unmirrored digest, `CREATE_TABLE=true`, a Job, no sidecar, `delete-table`, egress outside the namespace, a LoadBalancer Service, the Cart in the database wave, a memory limit above the LimitRange, a readiness that ignores the table, a sidecar that exits after the first create, an unconditional `create-table`) must fail.
