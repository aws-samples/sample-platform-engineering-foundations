#!/usr/bin/env python3
"""test_queries_doc.py - QUERIES.md is DERIVED from queries.yaml, byte for byte.

  python3 platform/components/observability/connectivity/tests/test_queries_doc.py           check (rc 1 on drift)
  python3 platform/components/observability/connectivity/tests/test_queries_doc.py --write   regenerate QUERIES.md

To change a query, change queries.yaml and run --write; a hand edit of QUERIES.md fails here.
"""
import sys
import unittest
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
QUERIES, DOC = HERE.parent / "queries.yaml", HERE.parent / "QUERIES.md"
WHERE = {"panel": "Grafana, panel **{panel}**, and VMUI", "annotation": "Grafana, dashboard annotation, and VMUI",
         "explore": "VMUI only"}

HEAD = """# Connectivity queries: VMUI and Grafana

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
| `up{{vantage=...}}` | the vmagent scrape of each probe |

Labels: `vantage` = `cut` (inside the cut) or `control` (outside it), `target_class` = `region`, `internet` or
`local`, `target_name` = `host:port` of the target. A sample older than {stale} s is stale and is not a state.

## Check on the cluster

```bash
python3 platform/components/observability/connectivity/tests/test_connectivity.py --live-url http://127.0.0.1:8428
python3 platform/components/observability/connectivity/tests/test_connectivity.py --live-url http://127.0.0.1:8428 --require-probes
```

The first runs outside a Chaos run: the positive control (`pod_ip_node` of `demo-netpol`) must return a series
before any empty result is trusted, and the same selector with a missing namespace must return nothing. The second
runs during a `run`: it requires both vantages, the three classes and no stale sample.
"""


def render(q):
    out = [HEAD.format(stale=q["stale_after_seconds"])]
    out.append("## Queries\n")
    for x in q["queries"]:
        out.append(f"### {x['title']}\n")
        out.append(f"`{x['id']}`: {WHERE[x['kind']].format(panel=x.get('panel'))}.\n")
        out.append("```promql\n" + x["expr"] + "\n```\n")
    return "\n".join(out)


class QueriesDoc(unittest.TestCase):
    def setUp(self):
        self.q = yaml.safe_load(QUERIES.read_text())

    def test_doc_is_byte_identical_to_the_render(self):
        self.assertEqual(DOC.read_text(), render(self.q), "QUERIES.md drifted from queries.yaml: run --write")

    def test_every_expr_appears_verbatim_in_its_own_block(self):
        doc = DOC.read_text()
        for x in self.q["queries"]:
            self.assertEqual(doc.count("```promql\n" + x["expr"] + "\n```"), 1, x["id"])

    def test_hand_edit_fails(self):
        doc = DOC.read_text()
        e = self.q["queries"][0]["expr"]
        self.assertNotEqual(doc.replace(e, e.replace("< 90", "< 120")), render(self.q))
        self.assertNotEqual(doc + "\nloose note\n", render(self.q))


if __name__ == "__main__":
    if "--write" in sys.argv:
        DOC.write_text(render(yaml.safe_load(QUERIES.read_text())))
        print(f"OK {DOC.name} regenerated")
        sys.exit(0)
    unittest.main()
