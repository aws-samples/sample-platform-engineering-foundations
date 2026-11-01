# Egress cut with Chaos Mesh

This component cuts, for a bounded time, all egress of the selected platform pods towards the AWS Region and the Internet, and proves that the local platform keeps working: Gitea, Harbor, Argo CD, VictoriaMetrics, VictoriaLogs and the Kubernetes API. Chaos Mesh lifts the cut by itself at the end of the duration. `run` measures before, during and after the cut, and every measurement has a control that makes it fail.

Chaos Mesh is installed only for the demo and removed afterwards. It stays outside GitOps on purpose: Argo CD would recreate the experiment after the recovery and fight the rollback.

## What the demo proves, and what it does not

| Proves | Does not prove |
|---|---|
| The platform works with no egress to the Region or the Internet: Argo CD reconciles from the local Gitea, and Harbor, VictoriaMetrics and VictoriaLogs answer | That the cluster survives a Service Link disconnection. The cut is on the **pod** network; the control plane, kubelet and containerd keep reaching the Region |
| Target pods that call out (the Argo CD repo server egress) lose the Region without taking down the rest | Behavior of pods **recreated** during the cut: Chaos Mesh injects into the pods selected at the start, not into pods created later |
| The operator keeps the Kubernetes API during the cut, from the hosts listed in `operator_ips` | Anything about `hostNetwork` pods: they are refused by construction, because a cut on them would cut the node. Crossplane core runs `hostNetwork`, so `crossplane-system` stays out and its providers keep reaching the Region during the cut |
| The Grafana dashboard shows the same result that `run` prints: both probes publish each sample as a series, and the report keeps the timestamp of each one | That a pod created during the cut was cut. The [Retail Store](../../apps/retail-store/README.md) has no egress outside its namespace through its own NetworkPolicy, not through the `NetworkChaos` |

The cut is by destination, with one named exception for the management path (the operator IPs). Say it out loud in the same sentence that announces the cut.

## How the cut is built

A `NetworkChaos` `partition` with `direction: to`, `mode: all`, a duration between 30 s and 15 min (the demo scene uses exactly **8 min**) and `externalTargets` equal to the **IPv4 complement** of the preserved set. Targets are CIDRs only, never names, so the set does not depend on DNS at injection time.

| Preserved | Why |
|---|---|
| `node_subnet_cidr` (Outpost subnet) | nodes, pods, control plane ENIs |
| `service_cidr` | ClusterIPs: in the pod network namespace the destination is still the ClusterIP, before DNAT |
| `127.0.0.0/8` | `kubectl port-forward` enters the pod through loopback |
| `169.254.0.0/16` | NodeLocal DNS, the Pod Identity agent, instance metadata |
| `operator_ips` (/32 each) | the named exception: pod replies to the operator host |
| `extra_preserve_cidrs` | local networks reached through the local gateway, if any |

Everything else drops, including the rest of the VPC in the Region (NAT, other subnets, interface endpoints).

`render` refuses an empty set (with empty `externalTargets` and no `target`, the Chaos Mesh 2.8.7 partition cuts **all** pod egress), a `/0` CIDR, overlap between cut and preserved, more than 128 CIDRs, and checks that the two sets together cover the IPv4 space exactly once.

Four blast-radius defenses live in Chaos Mesh ([`chaos-mesh-values.yaml`](chaos-mesh-values.yaml)) and `check-chart` verifies them on the rendered chart before the install:

- `enableFilterNamespace: true`: only namespaces annotated with `chaos-mesh.org/inject=enabled` receive faults. `run` annotates the target namespaces at the start and marks them with the label `egress-chaos.demo/annotated`; rollback removes both. A namespace annotated before the demo stays as it was.
- `allowHostNetworkTesting: false`.
- images by digest, and webhooks only for the `chaos-mesh.org` group, so a webhook outage never blocks a platform pod.
- every Service `ClusterIP`: the chart default for the dashboard is `NodePort`, and `check-chart` refuses `NodePort` and `LoadBalancer`.

The offline tests read the same defenses, the image digests and the chart pin of the installer from the real files, so a change to any of them fails before any install.

The Chaos Mesh images are pulled by digest from `ghcr.io` during the install, while connected. They are not mirrored to Harbor because the component is removed after the demo.

## Files

| File | Role |
|---|---|
| [`egress_chaos.py`](egress_chaos.py) | `render`, `check-chart`, `run` and `rollback` |
| [`install.sh`](install.sh) | installs or removes Chaos Mesh 2.8.7: downloads the chart, verifies its SHA-256, runs `check-chart`, applies the namespace NetworkPolicies and only then runs `helm install` |
| [`chaos-mesh-values.yaml`](chaos-mesh-values.yaml) | chart values with the three defenses |
| [`inputs.example.json`](inputs.example.json) | input template with the scene duration (`8m`) |
| [`tests/test_egress_chaos.py`](tests/test_egress_chaos.py) | offline suite |

The probe series are consumed by the queries in [`../observability/connectivity/queries.yaml`](../observability/connectivity/queries.yaml), documented in [`QUERIES.md`](../observability/connectivity/QUERIES.md), and by the dashboard in [`../observability/dashboards/platform-connectivity-dashboard.yaml`](../observability/dashboards/platform-connectivity-dashboard.yaml).

## Inputs

Copy `inputs.example.json` outside Git and fill it per cluster. The CIDRs come from the Argo CD cluster Secret that the shared bootstrap renders from `platform-contract.json`:

```bash
kubectl -n argocd get secret -l argocd.argoproj.io/secret-type=cluster \
  -o jsonpath='{.items[0].metadata.annotations.node_subnet_cidr} {.items[0].metadata.annotations.kubernetes_service_ip_cidr}{"\n"}'
```

- `service_cidr`: the service IPv4 CIDR of the cluster (`aws eks describe-cluster --query cluster.kubernetesNetworkConfig.serviceIpv4Cidr`).
- `operator_ips`: the private IPs of the hosts that run `kubectl` during the demo, for example the bastion.
- `target_namespaces`: the platform namespaces. `crossplane-system` and `monitoring` stay out: they run `hostNetwork` pods (Crossplane core and node-exporter) and the preflight refuses them. `kube-system`, `chaos-mesh`, `default` and the control namespace are refused, and so is any `retail-*` namespace (rc 2 before any namespace is annotated or any `NetworkChaos` is created).
- `region_probe` and `internet_probe`: one endpoint in the cluster Region and one on the Internet, as `host:port`.
- `local_probes`: the local services that must keep answering **from inside** the cut.

`run` checks the inputs against the live cluster before cutting: Service `kubernetes` at the declared IP, the cluster Secret annotations equal to the inputs, no node, API endpoint, target pod or load balancer IP inside the cut, no `hostNetwork` pod in the target namespaces, and the external probe names resolving to IPs that the cut covers.

## Run

```bash
bash platform/components/chaos-egress/install.sh install --inputs ~/egress-inputs.json --context <ctx>   # connected; once per cluster
python3 platform/components/chaos-egress/egress_chaos.py render --inputs ~/egress-inputs.json --out /tmp/egress-cut --choreography
python3 platform/components/chaos-egress/egress_chaos.py run --inputs ~/egress-inputs.json --context <ctx> --report ~/egress-cut-report.json --choreography
```

`run` follows this order and prints a table per round (probe, kind, target, expected, observed, result):

1. **Preflight** (nothing created yet). A failure here exits with rc 3.
2. **Probes**: a BusyBox pod from the local Harbor in `egress-chaos-probe` (vantage `cut`, inside the cut) and another in `egress-chaos-control` (vantage `control`, outside it), each with a Service, plus one `VMServiceScrape` for both. Both measure the same targets.
3. **Before**: everything must be open in both vantages, and `platform-root` must be `Synced`. A non-green baseline, a missing series or a missing `control` vantage exits with rc 3, **without injecting anything**.
4. **Cut**: annotates the namespaces, applies the `NetworkChaos` and waits for `AllInjected`, recorded in the report as UTC wall clock and epoch (`all_injected_at`, `all_injected_at_epoch`).
5. **During**, one round per new probe sample: inside, Region and Internet blocked and every local service open; outside, everything open (proof that the block comes from the cut, not from the Region being down); the API answers the operator. Only samples that started after `AllInjected` and end before the duration count. Once, a hard refresh of `platform-root` must reconcile from the local Gitea.
6. **Automatic recovery**: `run` deletes nothing; it waits for Chaos Mesh to reach `AllRecovered` at the end of the duration, with 120 s of slack, and records `all_recovered_at` and `all_recovered_at_epoch`.
7. **After**: everything open again, with a sample that started after `AllRecovered`, and no target pod restarted during the cut.
8. **Cleanup**, always, including on error, Ctrl-C or SIGTERM. Deleting the two probe namespaces removes the probes, Services and the `VMServiceScrape`.

A sample that does not arrive (exec failed, missing series, stale series, sample outside the window) counts as `error`, never as `blocked`: a check failure is not proof of a cut. Deadlines and intervals use the monotonic clock; the wall clock only stamps events and samples.

`--report` writes the JSON atomically after every round and right after `AllInjected` (`partial: true`); the final write carries `partial: false` and the `result`. rc: 0 PASS, 1 FAIL, 2 invalid input, 3 INCONCLUSIVE (nothing was injected).

## The 8-minute scene

`--choreography` requires exactly `8m`; any other duration exits with rc 2. A shorter duration such as `2m` stays valid without the flag for a rehearsal. The scene inside the cut:

1. Start `run` and open the [connectivity dashboard](../observability/dashboards/platform-connectivity-dashboard.yaml) in Grafana.
2. After `AllInjected`, enable the [Retail Store](../../apps/retail-store/README.md): `kubectl -n argocd label secret <cluster-name> enable_retail_store=true --overwrite`. Argo CD syncs it from the local Gitea and the kubelet pulls its images from the local Harbor.
3. Use the store through `kubectl -n retail-store port-forward svc/retail-ui 8080:80` while the Region and the Internet are unreachable from the platform pods.
4. Wait for `AllRecovered`. Only then open the [Serverless multi-tier](../crossplane/README.md#serverless-multi-tier) claim, which creates Regional resources and is not covered by the cut.

## Probes and series

Each probe runs, every `interval_seconds`, the same TCP connect (`nc -z -w 4`) to the Region, the Internet and every `local_probes` entry. The sample is written to a temporary file and swapped in with `mv` at `/tmp/www/metrics`, which BusyBox `httpd` serves on port 9797. Port 9797 is already allowed by the vmagent egress policy to the Outpost subnet ([`monitoring.yaml`](../network-policies/monitoring.yaml)), so the probe needs no change to a shared policy; the probe NetworkPolicy accepts ingress only from vmagent on that port.

| Series | Value |
|---|---|
| `platform_probe_success` | 1 = the connect succeeded, 0 = it did not |
| `platform_probe_latency_seconds` | connect duration, timeout included |
| `platform_probe_sample_timestamp_seconds` | start epoch of the sample of that target |

Labels on every series: `vantage="cut|control"`, `target_class="region|internet|local"` and `target_name="<host:port>"`. The scrape `up` also carries `vantage` (Service label through `targetLabels`).

`run` does not connect by itself: every round it reads the metrics file of each pod, so the JSON report and the series are the same measurement. Each report row carries `vantage`, `target_class`, `target_name`, `observed_at` (UTC) and `observed_at_epoch`, which is exactly the value of `platform_probe_sample_timestamp_seconds` in that sample.

## Rollback and uninstall

```bash
python3 platform/components/chaos-egress/egress_chaos.py rollback --inputs ~/egress-inputs.json --context <ctx>
bash platform/components/chaos-egress/install.sh uninstall --inputs ~/egress-inputs.json --context <ctx>
```

`rollback` is idempotent and verifies that no `NetworkChaos` of the demo and no `PodNetworkChaos` rule remain. If a rule is stuck, `--force` removes the finalizers and recreates the affected pods. `uninstall` runs the rollback first and stops if it does not finish clean, because without the controller nobody removes the iptables rules that may still be in the pods. `--purge-crds` also removes the Chaos Mesh CRDs.

## Tests

```bash
python3 -m unittest discover -s platform/components/chaos-egress/tests
EGRESS_CHAOS_CHART=/path/to/chaos-mesh-2.8.7.tgz python3 -m unittest discover -s platform/components/chaos-egress/tests
```

The suite runs `run` end to end against a fake cluster that simulates the Chaos Mesh controller, and anchors the fake probe output to the real probe loop, executed in `sh` with fake `nc`, `httpd` and `sleep`. With `EGRESS_CHAOS_CHART` pointing at the pinned chart, it also validates the rendered `NetworkChaos` against the CRD schema of that chart. The live behavior of this assembled package has not been measured; see the [validation boundary](../../../README.md#validation-boundary).
