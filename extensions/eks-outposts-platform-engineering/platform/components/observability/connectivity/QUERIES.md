# Connectivity queries: VMUI and Grafana

> Generated from `queries.yaml` by `python3 tests/test_queries_doc.py --write`. Do not edit by hand: the test fails on
> any drift. To change a query, change `queries.yaml`, run `--write`, then run `python3 tests/test_connectivity.py`.

The `platform_probe_*` series come from the two probes of the egress cut in `platform/components/chaos-egress` and
exist only while a `run` is active. The Grafana dashboard **Platform connectivity during disconnection** uses the queries marked as
panel or annotation; VMUI is for investigation.

## Open VMUI

```bash
kubectl -n monitoring port-forward svc/vmsingle-victoria-metrics-victoria-metrics-k8s-stack 8428:8428 >/dev/null 2>&1 &
```

Then open `http://127.0.0.1:8428/vmui/` in a browser.

## Vocabulary

| Series | Meaning |
|---|---|
| `platform_probe_success` | 1 when the TCP connect succeeded in that sample, 0 when it did not |
| `platform_probe_latency_seconds` | connect duration; close to 4 s is the probe timeout |
| `platform_probe_sample_timestamp_seconds` | start epoch of the target sample; its age measures staleness |
| `up{vantage=...}` | the vmagent scrape of each probe |

Labels: `vantage` = `cut` (inside the cut) or `control` (outside it), `target_class` = `region`, `internet` or
`local`, `target_name` = `host:port` of the target. A sample older than 90 s is stale and is not a state.

## Check on the cluster

```bash
python3 platform/components/observability/connectivity/tests/test_connectivity.py --live-url http://127.0.0.1:8428
python3 platform/components/observability/connectivity/tests/test_connectivity.py --live-url http://127.0.0.1:8428 --require-probes
```

The first runs outside a Chaos run: the positive control (`pod_ip_node` of `demo-netpol`) must return a series
before any empty result is trusted, and the same selector with a missing namespace must return nothing. The second
runs during a `run`: it requires both vantages, the three classes and no stale sample.

## Queries

### UP/DOWN state per vantage and class, fresh samples only

`connectivity_state`: Grafana, panel **Connectivity State Timeline**, and VMUI.

```promql
min by (vantage, target_class) (platform_probe_success and on (vantage, target_class, target_name) (time() - platform_probe_sample_timestamp_seconds < 90))
```

### Whether any probe has a fresh sample (1 = FRESH, 0 = NO SAMPLE); the series is always present

`probe_samples_fresh`: Grafana, panel **Connectivity State Timeline**, and VMUI.

```promql
(count(platform_probe_success and on (vantage, target_class, target_name) (time() - platform_probe_sample_timestamp_seconds < 90)) > bool 0) or vector(0)
```

### Local services seen from INSIDE the cut, per target

`local_services_probe`: Grafana, panel **Local Services**, and VMUI.

```promql
min by (target_name) (platform_probe_success{vantage="cut",target_class="local"} and on (vantage, target_class, target_name) (time() - platform_probe_sample_timestamp_seconds{vantage="cut",target_class="local"} < 90))
```

### Retail Store Deployments with an available replica (no network probe, from kube-state-metrics)

`local_workloads_ready`: Grafana, panel **Local Services**, and VMUI.

```promql
min by (namespace, deployment) (kube_deployment_status_replicas_available{namespace=~"retail-.+"} > bool 0)
```

### vmagent reaches the probe of each vantage

`scrape_up`: Grafana, panel **Scrape Integrity**, and VMUI.

```promql
max by (vantage) (up{namespace=~"egress-chaos-probe|egress-chaos-control"})
```

### Age of the oldest sample per vantage and class (above 90 s is stale)

`sample_age`: Grafana, panel **Scrape Integrity**, and VMUI.

```promql
max by (vantage, target_class) (time() - platform_probe_sample_timestamp_seconds)
```

### Series per vantage; without control there is no proof that the Region is up

`vantage_series`: Grafana, panel **Scrape Integrity**, and VMUI.

```promql
count by (vantage) (platform_probe_success)
```

### Seconds with the class DOWN in the last 15 minutes (10 s step; a class never DOWN shows 0)

`unavailable_seconds`: Grafana, panel **Unavailable seconds**, and VMUI.

```promql
sum_over_time((min by (vantage, target_class) (platform_probe_success) == bool 0)[15m:10s]) * 10
```

### Region changes state in the cut vantage (observed start and end of the cut)

`region_transition`: Grafana, dashboard annotation, and VMUI.

```promql
changes(platform_probe_success{vantage="cut",target_class="region"}[1m]) > 0
```

### Retail Store namespace created by the Argo CD sync (value = instant, in ms)

`retail_namespace_created`: Grafana, dashboard annotation, and VMUI.

```promql
kube_namespace_created{namespace=~"retail-.+"} * 1000
```

### Retail Store with every Deployment having a ready replica

`retail_ready`: Grafana, dashboard annotation, and VMUI.

```promql
min by (namespace) (kube_deployment_status_replicas_ready{namespace=~"retail-.+"}) >= 1
```

### Pods per namespace

`namespaces`: VMUI only.

```promql
count by (namespace) (kube_pod_info)
```

### Pod, IP and node of a namespace (replace demo-netpol with any namespace)

`pod_ip_node`: VMUI only.

```promql
max by (namespace, pod, pod_ip, node) (kube_pod_info{namespace="demo-netpol"})
```

### Result of each target in both vantages (1 = open, 0 = not open)

`probe_by_target`: VMUI only.

```promql
max by (vantage, target_class, target_name) (platform_probe_success)
```

### Connect latency of each target; close to 4 s is the probe timeout, not slowness

`probe_latency`: VMUI only.

```promql
max by (vantage, target_class, target_name) (platform_probe_latency_seconds)
```
