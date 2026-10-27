"""Cluster API: read-heavy Kubernetes explorer + gated ops for the Agent Platform IDP.

Runs INSIDE the cluster VPC (private subnets) and reaches the private EKS endpoint.
Auth to the portal mirrors platform-api (API GW AWS_IAM + the internal gateway session allowlist).
Auth to Kubernetes uses the Lambda role via EKS access entry (group platform-cluster-api),
with a presigned STS token (aws-iam-authenticator scheme). RBAC lives in cluster-rbac.yaml.

Parity with the upstream Kubernetes Dashboard, minus interactive exec (needs websockets):
workloads, pods (+detail/logs), services/ingress, config/storage (secret NAMES only),
nodes, namespaces, events, and the platform view (kro RGDs/instances, ACK objects).
Writes (scale/restart/delete pod) are PLATFORM_ADMINS only and audit-logged.

Inventario live por capability (issue #8) e detalhe por instancia (issue #9):
  GET /cluster/capabilities   capabilities vivas (RGD kro + grupos ACK do RBAC)
  GET /cluster/instances      lista por capability/kind/namespace, com filtro,
                              ordenacao e paginacao por cursor
  GET /cluster/instance       uma instancia: metadata segura, generation,
                              observedGeneration, conditions, outputs nao
                              sensiveis, freshness e trail MR/Argo/recurso
As tres sao LEITURA. Nenhum servico novo: reusam _k8s, _ns_path, _meta e
_argo_application desta mesma Lambda. Erro de origem nunca vira lista vazia
(campo `sources[]` com `ok`, `partial`, e 502 quando toda fonte falhou), Ready
exige condition real com observedGeneration atual, e Secret nao e lido nem
listado por elas. A acao Day-2 segue nos handlers governados de POST.

Agent Builder (docs/agent-platform/design-agent-builder.md, secoes 5.6 a 5.9),
atras da flag AGENT_BUILDER_ENABLED:
  GET  /cluster/agents                         inventario vivo dos agents do builder
  GET  /cluster/agents/{name}                  condicoes reais, eventos e estado do Argo
  GET  /cluster/agent-tools                    tools descobertas vs catalogo read-only
  GET  /cluster/agent-name-check?name=          unicidade de nome, fail closed
  POST /cluster/agent-dry-run                  validacao de forma + CRD vivo, sem efeito
  POST /cluster/agents/{name}/a2a-test         teste A2A pelo service proxy
  GET  /cluster/agents/{name}/a2a-test/{task}  estado do teste
Nenhuma dessas rotas escreve no cluster. A Lambda nao tem, e nao deve ganhar,
verbo de escrita em agents.kagent.dev: o caminho de escrita e o Git, pelo MR.

Escopo de projeto (issue #10, ADR-0009): toda rota com dado de namespace passa por
platform_scope.resolve antes de ler o API server. O projeto vem na query (`project`), o
namespace em `ns` (GET) ou no body (POST de operação), e o servidor decide com o alias assinado
pelo the internal gateway. /cluster/nodes fica fora do escopo: é infraestrutura, sem dado de projeto.

Métricas de CPU/memória (backlog cluster-metrics), leitura da Metrics API (metrics.k8s.io):
  GET /cluster/pod-metrics?ns=   amostra por pod e container, com o mesmo escopo de /cluster/pods
  GET /cluster/node-metrics      amostra por node e % do allocatable, fora do escopo como /cluster/nodes
Estado explícito em `metrics.status` (available, not_installed, unavailable, forbidden, error) e
`pods`/`nodes` null quando não há dado, nunca lista vazia. Ver o bloco "Métricas" abaixo.

Observabilidade: a rota de detalhe emite `agent_builder_agent_observed` do contrato
em tests/fixtures/agent-builder-e2e/observability-spec.json (fase, causa, frescor e
idade), e o a2a-test emite `agent_builder_a2a_test` / `agent_builder_a2a_denied`.
Dos tres sai medida e enum: prompt, manifest, mensagem de condicao e resposta do
agent nunca entram em log.
"""
from __future__ import annotations

import base64
import datetime
import hashlib
import json
import os
import re
import ssl
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import sys
import uuid
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

import botocore.session
from botocore.signers import RequestSigner

# Escopo de projeto (backend/platform_scope): no bundle fica ao lado deste arquivo, no repo um
# nível acima. Mesmo pacote que a platform-api usa, então as duas Lambdas não divergem.
try:
    import platform_scope
except ImportError:  # pragma: no cover - caminho do repo, exercitado pelos testes
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import platform_scope
# Trilha de eventos (audit-log/notifications): backend/platform_events, no bundle. Produtor das ações Day 2.
# Identidade do caller (backstage-killer 2b): backend/platform_identity, modos iam e jwt.
try:
    import platform_events
    import platform_identity
except ImportError:  # pragma: no cover
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import platform_events
    import platform_identity

REGION = os.environ.get("CLUSTER_REGION", "sa-east-1")
CLUSTER_NAME = os.environ.get("CLUSTER_NAME", "appmod-agent-platform-lab")
CLUSTER_ENDPOINT = os.environ["CLUSTER_ENDPOINT"]
CLUSTER_CA_B64 = os.environ["CLUSTER_CA_B64"]
EXPECTED_ROLE = os.environ.get("EXPECTED_ROLE", "PortalInvokeRole")
EXPECTED_ACCOUNT = os.environ.get("EXPECTED_ACCOUNT", "111122223333")
AUTHORIZED_ALIASES = {a.strip() for a in os.environ.get("AUTHORIZED_ALIASES", "").split(",") if a.strip()}
PLATFORM_ADMINS = {a.strip() for a in os.environ.get("PLATFORM_ADMINS", "").split(",") if a.strip()}
ALLOWED_ORIGINS = {o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()}

_ssl_context_cache: ssl.SSLContext | None = None



# "*" admits every session of EXPECTED_ROLE, which is how the whole team gets in. That is safe
# because the internal gateway enforces the membership before it ever assumes the role: the the gateway IAM role
# the internal allowlist resource (<allowlist-resource-id>) grants "Can assume" only to team
# platform-team, the app needs "Can view app" on its the gateway app resource, and the internal gateway sets
# the session name to the the corporate SSO alias server-side, so a browser cannot forge it. Joining or
# leaving the team changes access with no redeploy. An EMPTY list still denies everyone, and
# PLATFORM_ADMINS never honours "*".
ALIAS_PATTERN = re.compile(r"[a-z][a-z0-9._-]{0,63}")


def _alias_authorized(alias: str) -> bool:
    if not alias or not ALIAS_PATTERN.fullmatch(alias):
        return False
    return "*" in AUTHORIZED_ALIASES or alias in AUTHORIZED_ALIASES

def _ssl_context() -> ssl.SSLContext:
    global _ssl_context_cache
    if _ssl_context_cache is None:
        ca_file = tempfile.NamedTemporaryFile(delete=False, suffix=".crt")
        ca_file.write(base64.b64decode(CLUSTER_CA_B64))
        ca_file.close()
        _ssl_context_cache = ssl.create_default_context(cafile=ca_file.name)
    return _ssl_context_cache

_botocore = botocore.session.get_session()
# Store de eventos. Vazio desliga; o client sai da mesma sessão botocore, criado na primeira gravação.
EVENTS_TABLE = os.environ.get("EVENTS_TABLE", "")
_events_store: Any = None


def _events() -> Any:
    global _events_store
    if _events_store is None:
        client = _botocore.create_client("dynamodb", region_name=REGION) if EVENTS_TABLE else None
        _events_store = platform_events.EventStore(client, EVENTS_TABLE)
    return _events_store
_sts_client = _botocore.create_client("sts", region_name=REGION)


def _k8s_token() -> str:
    signer = RequestSigner(
        _sts_client.meta.service_model.service_id, REGION, "sts", "v4",
        _botocore.get_credentials(), _botocore.get_component("event_emitter"),
    )
    url = signer.generate_presigned_url(
        {
            "method": "GET",
            "url": f"https://sts.{REGION}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
            "body": {},
            "headers": {"x-k8s-aws-id": CLUSTER_NAME},
            "context": {},
        },
        region_name=REGION, expires_in=60, operation_name="",
    )
    return "k8s-aws-v1." + base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")


def _k8s(method: str, path: str, body: dict[str, Any] | None = None,
         content_type: str = "application/json", raw: bool = False) -> Any:
    request = urllib.request.Request(
        CLUSTER_ENDPOINT + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {_k8s_token()}", "Content-Type": content_type, "Accept": "*/*"},
    )
    with urllib.request.urlopen(request, context=_ssl_context(), timeout=25) as response:
        payload = response.read()
    return payload.decode(errors="replace") if raw else json.loads(payload)


def _ns_path(base: str, namespace: str, suffix: str = "") -> str:
    scope = f"/namespaces/{urllib.parse.quote(namespace)}" if namespace and namespace != "_all" else ""
    return f"{base}{scope}{suffix}"


def _meta(item: dict[str, Any]) -> dict[str, Any]:
    metadata = item.get("metadata", {})
    return {"name": metadata.get("name"), "namespace": metadata.get("namespace"),
            "created": metadata.get("creationTimestamp"), "labels": metadata.get("labels", {})}


def _workloads(namespace: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    specs = [
        ("deployments", "/apis/apps/v1", "/deployments"),
        ("statefulsets", "/apis/apps/v1", "/statefulsets"),
        ("daemonsets", "/apis/apps/v1", "/daemonsets"),
        ("jobs", "/apis/batch/v1", "/jobs"),
        ("cronjobs", "/apis/batch/v1", "/cronjobs"),
    ]
    for key, base, suffix in specs:
        items = _k8s("GET", _ns_path(base, namespace, suffix)).get("items", [])
        rows = []
        for item in items:
            status, spec = item.get("status", {}), item.get("spec", {})
            row = _meta(item)
            if key in ("deployments", "statefulsets"):
                row.update({"ready": f"{status.get('readyReplicas', 0)}/{spec.get('replicas', 0)}",
                            "updated": status.get("updatedReplicas", 0), "kind": key[:-1]})
            elif key == "daemonsets":
                row.update({"ready": f"{status.get('numberReady', 0)}/{status.get('desiredNumberScheduled', 0)}", "kind": "daemonset"})
            elif key == "jobs":
                row.update({"ready": f"{status.get('succeeded', 0)}/{spec.get('completions', 1)}",
                            "active": status.get("active", 0), "kind": "job"})
            else:
                row.update({"schedule": spec.get("schedule"), "suspend": spec.get("suspend", False),
                            "lastRun": status.get("lastScheduleTime"), "kind": "cronjob"})
            rows.append(row)
        out[key] = rows
    return out


def _pods(namespace: str) -> list[dict[str, Any]]:
    items = _k8s("GET", _ns_path("/api/v1", namespace, "/pods")).get("items", [])
    rows = []
    for item in items:
        status = item.get("status", {})
        containers = status.get("containerStatuses", []) or []
        rows.append({**_meta(item),
                     "phase": status.get("phase"),
                     "ready": f"{sum(1 for c in containers if c.get('ready'))}/{len(containers)}",
                     "restarts": sum(c.get("restartCount", 0) for c in containers),
                     "node": item.get("spec", {}).get("nodeName"),
                     "containers": [c.get("name") for c in containers],
                     "ip": status.get("podIP")})
    return rows


def _pod_detail(namespace: str, name: str) -> dict[str, Any]:
    pod = _k8s("GET", f"/api/v1/namespaces/{urllib.parse.quote(namespace)}/pods/{urllib.parse.quote(name)}")
    field = urllib.parse.quote(f"involvedObject.name={name}")
    events = _k8s("GET", f"/api/v1/namespaces/{urllib.parse.quote(namespace)}/events?fieldSelector={field}").get("items", [])
    spec, status = pod.get("spec", {}), pod.get("status", {})
    return {
        **_meta(pod), "phase": status.get("phase"), "node": spec.get("nodeName"), "ip": status.get("podIP"),
        "qos": status.get("qosClass"), "serviceAccount": spec.get("serviceAccountName"),
        "containers": [{"name": c.get("name"), "image": c.get("image"),
                        "resources": c.get("resources", {})} for c in spec.get("containers", [])],
        "conditions": [{"type": c.get("type"), "status": c.get("status")} for c in status.get("conditions", [])],
        "events": [{"reason": e.get("reason"), "message": (e.get("message") or "")[:300],
                    "type": e.get("type"), "count": e.get("count"), "last": e.get("lastTimestamp")}
                   for e in events[-25:]],
    }


def _services(namespace: str) -> dict[str, Any]:
    services = _k8s("GET", _ns_path("/api/v1", namespace, "/services")).get("items", [])
    ingresses = _k8s("GET", _ns_path("/apis/networking.k8s.io/v1", namespace, "/ingresses")).get("items", [])
    return {
        "services": [{**_meta(item), "type": item["spec"].get("type"),
                      "clusterIP": item["spec"].get("clusterIP"),
                      "external": (item.get("status", {}).get("loadBalancer", {}).get("ingress") or [{}])[0].get("hostname", ""),
                      "ports": [f"{p.get('port')}/{p.get('protocol', 'TCP')}" for p in item["spec"].get("ports", [])]}
                     for item in services],
        "ingresses": [{**_meta(item),
                       "hosts": [r.get("host", "*") for r in item.get("spec", {}).get("rules", [])]}
                      for item in ingresses],
    }


def _config(namespace: str) -> dict[str, Any]:
    configmaps = _k8s("GET", _ns_path("/api/v1", namespace, "/configmaps")).get("items", [])
    secrets = _k8s("GET", _ns_path("/api/v1", namespace, "/secrets")).get("items", [])
    pvcs = _k8s("GET", _ns_path("/api/v1", namespace, "/persistentvolumeclaims")).get("items", [])
    return {
        "configmaps": [{**_meta(i), "keys": sorted((i.get("data") or {}).keys())[:20]} for i in configmaps],
        # Secret VALUES never leave the cluster: names and types only.
        "secrets": [{**_meta(i), "type": i.get("type"), "keys": sorted((i.get("data") or {}).keys())[:20]} for i in secrets],
        "pvcs": [{**_meta(i), "phase": i.get("status", {}).get("phase"),
                  "capacity": i.get("status", {}).get("capacity", {}).get("storage"),
                  "storageClass": i.get("spec", {}).get("storageClassName")} for i in pvcs],
    }


def _nodes() -> list[dict[str, Any]]:
    items = _k8s("GET", "/api/v1/nodes").get("items", [])
    rows = []
    for item in items:
        status = item.get("status", {})
        labels = item.get("metadata", {}).get("labels", {})
        ready = next((c.get("status") for c in status.get("conditions", []) if c.get("type") == "Ready"), "Unknown")
        rows.append({**_meta(item), "ready": ready,
                     "instanceType": labels.get("node.kubernetes.io/instance-type"),
                     "capacityType": labels.get("eks.amazonaws.com/capacityType", "ON_DEMAND"),
                     "pool": labels.get("platform.appmod/pool", "core"),
                     "arch": labels.get("kubernetes.io/arch"),
                     "zone": labels.get("topology.kubernetes.io/zone"),
                     "version": status.get("nodeInfo", {}).get("kubeletVersion"),
                     "cpu": status.get("capacity", {}).get("cpu"),
                     "memory": status.get("capacity", {}).get("memory")})
    return rows


# ---------------------------------------------------------------------------
# Métricas de CPU e memória (backlog cluster-metrics), o mesmo dado do `kubectl top`.
#
# Fonte: a Metrics API (`metrics.k8s.io`), servida pelo metrics-server através da camada de
# agregação do API server. Doc oficial: kubernetes.io/docs/tasks/debug/debug-cluster/
# resource-metrics-pipeline/. Três fatos de lá que este código respeita:
#   - a versão do grupo NÃO é fixa: `v1` é stable desde o Kubernetes 1.37 e o cluster do lab
#     (1.36, metrics-server v0.9.0) serve `v1beta1`. Por isso a versão sai da discovery do grupo;
#   - CPU é a média em cpu units sobre `window`, e memória é o working set em bytes no instante
#     `timestamp`. O dado é uma AMOSTRA, não um total, e pod recém-criado ainda não tem amostra;
#   - a API só existe se houver um APIService registrado para `metrics.k8s.io`.
#
# Estados explícitos, nenhum deles vira lista vazia (mesma regra da invariante I-A):
#   available       200, linhas com valor
#   not_installed   200 com `pods`/`nodes` null: o grupo não está registrado (404 na discovery),
#                   que é resposta definitiva, igual ao grupo ACK ausente
#   unavailable     503: APIService registrado mas o metrics-server não responde
#   forbidden       502: o API server recusou a leitura (falta o grant de RBAC)
#   error           502: qualquer outra falha de leitura
# Saída sanitizada: só nome, namespace, número e timestamp. A PodMetrics carrega os labels do
# pod em metadata, e eles não saem daqui.
# ---------------------------------------------------------------------------
METRICS_API_GROUP = "metrics.k8s.io"
# Versões cujo formato este código conhece. Outra versão servida não é lida às cegas.
METRICS_API_VERSIONS = ("v1", "v1beta1")
METRICS_ROWS_MAX = 2000
# Acima disto a amostra não descreve mais o agora. O metrics-server coleta a cada 15 a 60 s.
METRICS_STALE_SECONDS = 300

METRICS_AVAILABLE = "available"
METRICS_NOT_INSTALLED = "not_installed"
METRICS_UNAVAILABLE = "unavailable"
METRICS_FORBIDDEN = "forbidden"
METRICS_ERROR = "error"
_METRICS_HTTP_STATUS = {METRICS_AVAILABLE: 200, METRICS_NOT_INSTALLED: 200,
                        METRICS_UNAVAILABLE: 503, METRICS_FORBIDDEN: 502, METRICS_ERROR: 502}
_METRICS_ERROR_TEXT = {
    METRICS_UNAVAILABLE: "metrics api is registered but not answering",
    METRICS_FORBIDDEN: "the cluster refused the metrics read",
    METRICS_ERROR: "the metrics api could not be read",
}

CONTAINER_NAME_PATTERN = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
# Quantity do Kubernetes (apimachinery resource.Quantity): número, e então sufixo binário,
# sufixo decimal ou expoente. Usage negativo não existe, então o sinal é recusado.
_QUANTITY_PATTERN = re.compile(r"\A(\d+(?:\.\d*)?|\.\d+)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E|[eE][+-]?\d{1,3})?\Z")
_QUANTITY_SUFFIX = {
    "": Decimal(1), "n": Decimal("1e-9"), "u": Decimal("1e-6"), "m": Decimal("1e-3"),
    "k": Decimal("1e3"), "M": Decimal("1e6"), "G": Decimal("1e9"), "T": Decimal("1e12"),
    "P": Decimal("1e15"), "E": Decimal("1e18"),
    "Ki": Decimal(2 ** 10), "Mi": Decimal(2 ** 20), "Gi": Decimal(2 ** 30),
    "Ti": Decimal(2 ** 40), "Pi": Decimal(2 ** 50), "Ei": Decimal(2 ** 60),
}
# `window` é um time.Duration do Go serializado: "30s", "10.5s", "1m0s", "500ms".
_DURATION_PART = re.compile(r"(\d+(?:\.\d+)?)(h|ms|us|µs|ns|m|s)")
_DURATION_SECONDS = {"h": 3600.0, "m": 60.0, "s": 1.0, "ms": 1e-3, "us": 1e-6, "µs": 1e-6, "ns": 1e-9}


def _quantity(raw: Any) -> Decimal | None:
    """Quantity em unidades base (cores ou bytes). None quando não é uma quantity válida."""
    if not isinstance(raw, str) or len(raw) > 64:
        return None
    match = _QUANTITY_PATTERN.match(raw.strip())
    if not match:
        return None
    number, suffix = Decimal(match.group(1)), match.group(2) or ""
    if suffix[:1] in ("e", "E"):
        return number.scaleb(int(suffix[1:]))
    return number * _QUANTITY_SUFFIX[suffix]


def _millicores(raw: Any) -> int | None:
    value = _quantity(raw)
    return int((value * 1000).to_integral_value(rounding=ROUND_HALF_UP)) if value is not None else None


def _bytes(raw: Any) -> int | None:
    value = _quantity(raw)
    return int(value.to_integral_value(rounding=ROUND_HALF_UP)) if value is not None else None


def _window_seconds(raw: Any) -> float | None:
    if not isinstance(raw, str) or not raw or len(raw) > 40:
        return None
    parts = _DURATION_PART.findall(raw)
    if not parts or "".join(number + unit for number, unit in parts) != raw:
        return None
    return round(sum(float(number) * _DURATION_SECONDS[unit] for number, unit in parts), 3)


def _metrics_state(status: str, reason: str = "", api_version: str = "") -> dict[str, str]:
    return {"status": status, "reason": reason, "apiVersion": api_version}


def _metrics_failure(error: BaseException) -> dict[str, str]:
    """Classifica a falha de leitura. HTTPError antes de URLError: é subclasse dele."""
    if isinstance(error, urllib.error.HTTPError):
        if error.code == 404:
            return _metrics_state(METRICS_NOT_INSTALLED, "metrics_api_not_registered")
        if error.code == 503:
            return _metrics_state(METRICS_UNAVAILABLE, "metrics_api_service_unavailable")
        if error.code in (401, 403):
            return _metrics_state(METRICS_FORBIDDEN, f"http_{error.code}")
        return _metrics_state(METRICS_ERROR, f"http_{error.code}")
    if isinstance(error, (urllib.error.URLError, TimeoutError)):
        return _metrics_state(METRICS_ERROR, "unreachable")
    return _metrics_state(METRICS_ERROR, "unreadable")


def _metrics_version() -> tuple[str, dict[str, str] | None]:
    """Versão servida do grupo metrics.k8s.io, ou o estado que explica por que não há uma."""
    try:
        group = _k8s("GET", f"/apis/{METRICS_API_GROUP}")
    except (OSError, ValueError, KeyError, TypeError) as error:
        return "", _metrics_failure(error)
    if not isinstance(group, dict):
        return "", _metrics_state(METRICS_ERROR, "unreadable")
    preferred = str((group.get("preferredVersion") or {}).get("version") or "")
    served = [str((entry or {}).get("version") or "") for entry in group.get("versions") or []
              if isinstance(entry, dict)]
    if preferred in METRICS_API_VERSIONS:
        return preferred, None
    known = next((version for version in METRICS_API_VERSIONS if version in served), "")
    if known:
        return known, None
    return "", _metrics_state(METRICS_ERROR, "unsupported_metrics_version")


def _metrics_list(suffix: str) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Lista uma coleção da Metrics API. Nunca levanta: a falha volta como estado."""
    version, failure = _metrics_version()
    if failure is not None:
        return [], failure
    try:
        payload = _k8s("GET", f"/apis/{METRICS_API_GROUP}/{version}{suffix}")
    except (OSError, ValueError, KeyError, TypeError) as error:
        state = _metrics_failure(error)
        # Discovery leu e a coleção deu 404: o grupo existe, então isto não é "não instalado".
        if state["status"] == METRICS_NOT_INSTALLED:
            state = _metrics_state(METRICS_ERROR, "http_404")
        return [], {**state, "apiVersion": f"{METRICS_API_GROUP}/{version}"}
    api_version = f"{METRICS_API_GROUP}/{version}"
    if not isinstance(payload, dict) or not isinstance(payload.get("items", []), list):
        return [], _metrics_state(METRICS_ERROR, "unreadable", api_version)
    items = [item for item in payload.get("items") or [] if isinstance(item, dict)]
    return items, _metrics_state(METRICS_AVAILABLE, "", api_version)


def _metrics_sample(item: dict[str, Any], now: int) -> dict[str, Any]:
    """Campos de amostra comuns a pod e node: quando, sobre qual janela e se ainda descreve o agora.

    O timestamp sai reescrito no formato canônico em UTC, nunca ecoado cru do API server.
    """
    moment = _epoch_any(item.get("timestamp"))
    canonical = (datetime.datetime.fromtimestamp(moment, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                 if moment is not None else None)
    return {"timestamp": canonical,
            "windowSeconds": _window_seconds(item.get("window")),
            # Sem timestamp legível não dá para provar que a amostra é atual.
            "stale": moment is None or now - moment > METRICS_STALE_SECONDS}


def _pod_metrics_rows(items: list[dict[str, Any]], now: int) -> tuple[list[dict[str, Any]], int]:
    rows, dropped = [], 0
    for item in items:
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        name, namespace = str(metadata.get("name") or ""), str(metadata.get("namespace") or "")
        if not OBJECT_NAME_PATTERN.fullmatch(name) or not NAMESPACE_PATTERN.fullmatch(namespace):
            dropped += 1
            continue
        containers = []
        for container in item.get("containers") or []:
            if not isinstance(container, dict):
                continue
            container_name = str(container.get("name") or "")
            if not CONTAINER_NAME_PATTERN.fullmatch(container_name):
                continue
            usage = container.get("usage") if isinstance(container.get("usage"), dict) else {}
            containers.append({"name": container_name, "cpuMillicores": _millicores(usage.get("cpu")),
                               "memoryBytes": _bytes(usage.get("memory"))})
        # Total só quando TODO container tem valor: soma parcial seria um número que mente.
        cpu = [c["cpuMillicores"] for c in containers]
        memory = [c["memoryBytes"] for c in containers]
        rows.append({"name": name, "namespace": namespace, **_metrics_sample(item, now),
                     "cpuMillicores": sum(cpu) if containers and None not in cpu else None,
                     "memoryBytes": sum(memory) if containers and None not in memory else None,
                     "containers": containers})
    rows.sort(key=lambda row: (row["namespace"], row["name"]))
    return rows, dropped


def _node_allocatable() -> dict[str, tuple[int | None, int | None]] | None:
    """Allocatable de cada node, o denominador do `kubectl top node`. None quando não deu para ler."""
    try:
        listing = _k8s("GET", "/api/v1/nodes")
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if not isinstance(listing, dict) or not isinstance(listing.get("items") or [], list):
        return None
    out = {}
    for item in listing.get("items") or []:
        if not isinstance(item, dict):
            continue
        name = str((item.get("metadata") or {}).get("name") or "")
        allocatable = (item.get("status") or {}).get("allocatable") or {}
        if name and isinstance(allocatable, dict):
            out[name] = (_millicores(allocatable.get("cpu")), _bytes(allocatable.get("memory")))
    return out


def _percent(used: int | None, total: int | None) -> int | None:
    if used is None or not total:
        return None
    return int((Decimal(used) * 100 / Decimal(total)).to_integral_value(rounding=ROUND_HALF_UP))


def _metrics_response(state: dict[str, str], key: str, rows: list[dict[str, Any]] | None,
                      extra: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    status = _METRICS_HTTP_STATUS[state["status"]]
    body: dict[str, Any] = {"metrics": state, **extra, "readAt": int(time.time())}
    if state["status"] == METRICS_AVAILABLE:
        truncated = len(rows or []) > METRICS_ROWS_MAX
        body.update({key: (rows or [])[:METRICS_ROWS_MAX], "truncated": truncated})
    else:
        # null, nunca []: lista vazia diria "nenhum pod consome nada".
        body[key] = None
        if status != 200:
            body["error"] = _METRICS_ERROR_TEXT[state["status"]]
    print(json.dumps({"event": "cluster_api_metrics", "collection": key, "status": state["status"],
                      "reason": state["reason"], "rows": len(rows) if rows is not None else None}))
    return status, body


def _pod_metrics_view(params: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /cluster/pod-metrics: amostra de CPU e memória por pod e por container."""
    namespace = _namespace_scope(params.get("ns"))
    items, state = _metrics_list(_ns_path("", namespace, "/pods"))
    rows, dropped = _pod_metrics_rows(items, int(time.time())) if state["status"] == METRICS_AVAILABLE else (None, 0)
    return _metrics_response(state, "pods", rows, {"namespace": namespace, "dropped": dropped})


def _node_metrics_view() -> tuple[int, dict[str, Any]]:
    """GET /cluster/node-metrics: amostra por node, com % do allocatable como no `kubectl top node`."""
    items, state = _metrics_list("/nodes")
    if state["status"] != METRICS_AVAILABLE:
        return _metrics_response(state, "nodes", None, {"allocatableReadable": False})
    now, allocatable = int(time.time()), _node_allocatable()
    rows = []
    for item in items:
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        name = str(metadata.get("name") or "")
        if not OBJECT_NAME_PATTERN.fullmatch(name):
            continue
        usage = item.get("usage") if isinstance(item.get("usage"), dict) else {}
        cpu, memory = _millicores(usage.get("cpu")), _bytes(usage.get("memory"))
        cpu_total, memory_total = (allocatable or {}).get(name, (None, None))
        rows.append({"name": name, **_metrics_sample(item, now), "cpuMillicores": cpu, "memoryBytes": memory,
                     "cpuPercent": _percent(cpu, cpu_total), "memoryPercent": _percent(memory, memory_total)})
    rows.sort(key=lambda row: row["name"])
    return _metrics_response(state, "nodes", rows, {"allocatableReadable": allocatable is not None})


def _platform_view() -> dict[str, Any]:
    rgds = _k8s("GET", "/apis/kro.run/v1alpha1/resourcegraphdefinitions").get("items", [])
    discovery = _k8s("GET", "/apis/kro.run/v1alpha1").get("resources", [])
    instances = []
    for resource in discovery:
        plural = resource.get("name", "")
        if "/" in plural or plural == "resourcegraphdefinitions" or "list" not in resource.get("verbs", []):
            continue
        for item in _k8s("GET", f"/apis/kro.run/v1alpha1/{plural}").get("items", []):
            conditions = item.get("status", {}).get("conditions", [])
            synced = next((c.get("status") for c in conditions if "Synced" in c.get("type", "")), "Unknown")
            # outputs: os campos string do status (url, distributionStatus...), que o trail do tour
            # lê. Sem conditions, que carregam mensagens longas e não são contrato.
            outputs = {k: v for k, v in item.get("status", {}).items() if isinstance(v, str)}
            instances.append({**_meta(item), "kind": item.get("kind"),
                              "state": item.get("status", {}).get("state", "?"), "synced": synced,
                              "outputs": outputs})
    return {
        "rgds": [{**_meta(item), "state": item.get("status", {}).get("state"),
                  "kind": item.get("spec", {}).get("schema", {}).get("kind"),
                  "topology": len(item.get("spec", {}).get("resources", []))} for item in rgds],
        "instances": instances,
    }


# ---------------------------------------------------------------------------
# Inventário live por capability e detalhe por instância (issues #8 e #9).
#
# Contrato: GET /cluster/capabilities, GET /cluster/instances e
# GET /cluster/instance. Os três LEEM o cluster e só isso: a escrita Day-2
# continua nos handlers governados que já existiam (/cluster/scale,
# /cluster/restart, /cluster/delete-pod), com o mesmo gate de PLATFORM_ADMINS.
# Nenhum serviço novo: o que há aqui reusa _k8s, _ns_path, _meta e
# _argo_application desta mesma Lambda.
#
# As quatro invariantes que estes endpoints carregam:
#
#   I-A  Erro de origem NUNCA vira lista vazia. Toda fonte lida entra em
#        `sources[]` com `ok`; `partial` fica true quando alguma falhou, e
#        quando TODAS falharam a rota responde 502, não 200 com `items: []`.
#   I-B  Ready exige condition real E observedGeneration atual. Sem condition,
#        ou com status velho, `ready` é false com o motivo em `readyBasis`.
#        observedGeneration ausente é "não dá para provar", logo não-Ready.
#   I-C  Nenhuma credencial no payload. Secret não é listado nem lido aqui, e
#        os outputs passam por allowlist de tipo mais negação por nome de chave
#        e por forma do valor.
#   I-D  Namespace e autorização são aplicados no BACKEND. O namespace entra na
#        URL do API server (escopo do lado do servidor), e o alias já passou
#        pelo gate do handler antes de qualquer leitura.
# ---------------------------------------------------------------------------

KRO_API = "/apis/kro.run/v1alpha1"
# Grupos ACK que o cluster-rbac.yaml concede a este grupo. Uma capability ACK só
# é listada se o grupo estiver aqui: pedir um grupo sem grant devolveria 403, e
# 403 engolido é exatamente o erro de origem que a issue #8 proíbe esconder.
ACK_API_GROUPS = tuple(group.strip() for group in os.environ.get(
    "ACK_API_GROUPS",
    "dynamodb.services.k8s.aws,s3.services.k8s.aws,lambda.services.k8s.aws,"
    "iam.services.k8s.aws,apigatewayv2.services.k8s.aws").split(",") if group.strip())
INSTANCES_ARGO_APPLICATION = os.environ.get("INSTANCES_ARGO_APPLICATION", "agent-platform-instances")
# Diretório que a Application das instâncias aplica. Portal (Create) e Platform Assistant gravam
# `platform/instances/<name>.yaml`; a cluster-api só usa isto para apontar o arquivo a editar.
INSTANCES_GITOPS_DIRECTORY = os.environ.get("INSTANCES_GITOPS_DIRECTORY", "platform/instances")

PAGE_SIZE_DEFAULT = 50
PAGE_SIZE_MAX = 200
# Teto por fonte numa só resposta. Acima disso a fonte volta com `truncated`,
# para a página não depender de um list sem limite no API server.
SOURCE_FETCH_LIMIT = 500
ALL_NAMESPACES = "_all"

# RFC 1123 label, que é o que o Kubernetes aceita como nome de namespace. Serve a
# duas coisas: recusar o que o API server recusaria e impedir que `ns` injete
# path (`../`, `?`, `/`) na URL montada por _ns_path.
NAMESPACE_PATTERN = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
# Kind é PascalCase do CRD; plural é o nome de recurso em minúsculas.
KIND_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9]{0,62}")
CAPABILITY_PATTERN = re.compile(r"[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?")
OBJECT_NAME_PATTERN = re.compile(r"[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?")

# Condições que valem como "pronto" nos engines da plataforma. Vem do
# readyCondition declarado nas capability.yaml do catálogo: InstanceSynced (kro),
# ACK.ResourceSynced (ACK), Available (inference-eks), mais Ready/Synced.
READY_CONDITION_TYPES = ("Ready", "InstanceSynced", "ACK.ResourceSynced", "Available", "Synced")
# Condição que, em True, é problema e não saúde: entra no topo da ordenação.
NEGATIVE_CONDITION_TYPES = ("ACK.Terminal", "ACK.Recoverable", "Degraded", "Stalled", "Failed")
# Subconjunto que, em True, NEGA Ready mesmo com a condition de prontidão em True.
# `ACK.Recoverable` fica DE FORA de propósito: no ACK ele é o erro RETENTÁVEL do
# último reconcile e coexiste com `ACK.ResourceSynced=True`, então bloquear por ele
# faria a linha piscar entre pronto e não-pronto a cada retry. Terminal, Degraded,
# Stalled e Failed são estado declarado de falha, e esses negam.
READY_BLOCKING_CONDITION_TYPES = ("ACK.Terminal", "Degraded", "Stalled", "Failed")

# Nome de Application do Argo: RFC 1123 subdomain, que é o que o Kubernetes aceita.
# Existe porque o alvo sai da ANNOTATION `argocd.argoproj.io/tracking-id` do objeto,
# que é texto de terceiro. Sem esta validação, um tracking-id
# `../../../../api/v1/namespaces/kube-system/secrets/x:Agent:ns/n` virava path montado
# contra o API server com o token da Lambda - medido em 15/10/2026, o request saiu.
ARGO_APPLICATION_PATTERN = re.compile(r"[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?")

READY_BASIS_TRUE = "CONDITION_TRUE"
READY_BASIS_NO_CONDITION = "NO_READY_CONDITION"
READY_BASIS_STALE = "STATUS_STALE"
READY_BASIS_NO_OBSERVED = "OBSERVED_GENERATION_MISSING"
# Condition de falha declarada em True. Precede os outros motivos porque é causa,
# não sintoma: dizer STATUS_STALE num objeto com ACK.Terminal esconde o que houve.
READY_BASIS_NEGATIVE = "NEGATIVE_CONDITION"

# Frescor: acima disto, um objeto que nunca convergiu não é "provisionando".
INSTANCE_CONVERGE_BUDGET_SECONDS = 900

MESSAGE_MAX = 300
OUTPUT_VALUE_MAX = 512
OUTPUTS_MAX = 40

# Nome de chave que, por si, basta para o campo não sair. A comparação é por
# substring em minúsculas e sem separador, então "accessKeyId", "access_key_id"
# e "ACCESS-KEY-ID" caem no mesmo token.
_SENSITIVE_KEY_TOKENS = (
    "secret", "token", "password", "passwd", "passphrase", "credential", "cred",
    "privatekey", "apikey", "accesskey", "sessionkey", "signature", "bearer",
    "authorization", "auth", "certificate", "cert", "keymaterial", "connectionstring",
    "dsn", "dbpassword", "clientsecret", "sharedkey", "sas", "pem", "pfx", "keystore",
)
# Chave que contém um token acima mas é inócua e útil no trail. Precede a negação.
_SENSITIVE_KEY_ALLOW = frozenset({
    "secretsmanagerarn", "secretarn", "secretname", "secretref", "kmskeyarn",
    "kmskeyid", "certificatearn", "authmode", "authtype",
})
# Forma de valor que denuncia credencial mesmo com nome de chave limpo.
_SENSITIVE_VALUE_PATTERNS = (
    re.compile(r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b"),          # AWS access key id
    re.compile(r"-{3,}\s*BEGIN[A-Z ]*(?:PRIVATE KEY|CERTIFICATE)"),   # PEM
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\."),     # JWT
    re.compile(r"\bghp_[A-Za-z0-9]{20,}\b|\bglpat-[A-Za-z0-9_-]{15,}\b"),  # PAT
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),                  # Slack token
    # userinfo de URL com senha. O `*` antes do `:` é deliberado: `redis://:senha@host`
    # NÃO tem usuário e com `+` escapava inteiro - medido em 15/10/2026.
    re.compile(r"\b[a-z][a-z0-9+.-]*://[^/\s:@]*:[^/\s@]+@"),
    # `chave=valor` de credencial em texto livre: DSN, .ini, kubeconfig, query string.
    # O prefixo exige início ou separador para `:secret:` de ARN não casar, que é o
    # que mantém `secretArn` publicável (ele está na allowlist de chave e no trail).
    re.compile(r"(?i)(?:^|[\s,;&?\"'{\[])(?:"
               r"aws[-_]?secret[-_]?access[-_]?key|client[-_]?key[-_]?data|"
               r"client[-_]?certificate[-_]?data|client[-_]?secret|"
               r"access[-_]?token|refresh[-_]?token|session[-_]?token|id[-_]?token|"
               r"private[-_]?token|bearer[-_]?token|private[-_]?key|"
               r"api[-_]?key|apikey|access[-_]?key|secret[-_]?key|"
               r"password|passwd|pwd|secret|token|authorization"
               r")\s*[:=]\s*\S"),
    # URL pré-assinada: o parâmetro de assinatura JÁ é a credencial.
    re.compile(r"(?i)[?&]x-amz-(?:signature|credential|security-token)="),
    re.compile(r"(?i)[?&](?:sig|signature)=\S"),
)


def _epoch_any(stamp: Any) -> int | None:
    """Timestamp do Kubernetes em epoch. Aceita o que _epoch aceita, mais fração e offset.

    _epoch cobre só `%Y-%m-%dT%H:%M:%SZ`, que é o formato de metadata. Em
    `lastTransitionTime` há controller que escreve fração de segundo ou offset,
    e nesses casos _epoch devolvia None, o que viraria "sem idade" em vez de
    idade real. Não altera _epoch: o Agent Builder depende do comportamento dele.
    """
    direct = _epoch(stamp)
    if direct is not None:
        return direct
    if not isinstance(stamp, str) or not stamp:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return int(parsed.timestamp())


def _sensitive_key(key: str) -> bool:
    flat = re.sub(r"[^a-z0-9]", "", str(key).lower())
    if flat in _SENSITIVE_KEY_ALLOW:
        return False
    return any(token in flat for token in _SENSITIVE_KEY_TOKENS)


def _sensitive_value(value: str) -> bool:
    return any(pattern.search(value) for pattern in _SENSITIVE_VALUE_PATTERNS)


def _safe_text(value: Any, limit: int = MESSAGE_MAX) -> str:
    """Texto de controller publicável: cortado e NEGADO pela forma do valor.

    Um só ponto para message, reason e state porque os três são a mesma classe -
    string que um controller de terceiro escreve no status. `reason` e `state`
    passavam direto enquanto `message` era negada, que é a invariante I-C furada
    por um lado só (medido em 15/10/2026: reason com `password=` no payload).
    Nega o campo inteiro em vez de mascarar: credencial parcial ainda é credencial.
    A negação roda no valor COMPLETO e o corte vem depois, nunca o contrário: um
    `password=` que começa no caractere 299 sobreviveria ao teste feito no texto já
    cortado, porque o `\\S` que o padrão exige teria ficado fora do corte.
    """
    text = str(value or "")
    return "" if _sensitive_value(text) else text[:limit]


# Host único de onde um link de MR pode vir. Prefixo com a barra final de propósito:
# sem ela, `https://github.com@evil.example/` passaria o startswith.
_MR_URL_PREFIX = "https://github.com/"


def _safe_mr_url(raw: Any) -> str | None:
    """URL de MR publicável, ou None. Host interno, sem query e sem credencial.

    O prefixo sozinho não bastava: `https://github.com/x/-/merge_requests/1?private_token=glpat-...`
    passava inteiro para a UI com o token dentro (medido em 15/10/2026). A query e o
    fragmento saem porque a URL de um MR não precisa de nenhum dos dois, e é neles
    que mora o parâmetro de credencial.
    """
    url = str(raw or "")
    if not url.startswith(_MR_URL_PREFIX) or len(url) > OUTPUT_VALUE_MAX:
        return None
    if _sensitive_value(url) or any(char in url for char in '\\ \t\n\r"\'<>'):
        return None
    clean = url.split("?", 1)[0].split("#", 1)[0]
    # `@` no authority trocaria o host efetivo no browser; `//` no path é redirect
    # aberto em alguns proxies. Nenhum dos dois aparece numa URL de MR real.
    if "@" in clean or "//" in clean[len("https://"):]:
        return None
    return clean


def _safe_outputs(status: dict[str, Any]) -> dict[str, str]:
    """Campos de status publicáveis: url, arn, distributionStatus e afins.

    Allowlist de TIPO (só str, int, bool e float viram output) somada à negação
    por nome de chave e por forma de valor. `conditions` fica fora porque é
    lista e carrega mensagem longa, e sai no seu próprio campo já sanitizado.
    Invariante I-C: nada que pareça credencial atravessa daqui.
    """
    outputs: dict[str, str] = {}
    for key, value in sorted((status or {}).items()):
        if len(outputs) >= OUTPUTS_MAX:
            break
        if key == "conditions" or _sensitive_key(key):
            continue
        if isinstance(value, bool):
            rendered = "true" if value else "false"
        elif isinstance(value, (int, float)):
            rendered = str(value)
        elif isinstance(value, str):
            rendered = value
        else:
            continue
        if _sensitive_value(rendered):
            continue
        outputs[str(key)] = rendered[:OUTPUT_VALUE_MAX]
    return outputs


SPEC_MAX_DEPTH = 6
SPEC_MAX_ITEMS = 60


def _safe_spec(spec: Any, depth: int = 0) -> Any:
    """`spec` publicável de uma instância kro (environments-promotion: a promoção copia o spec para o
    ambiente seguinte, e o portal não lê Git). Mesma disciplina do `_safe_outputs`, recursiva: só str,
    int, float, bool, list e dict; chave sensível por nome sai inteira (`_sensitive_key`), string com
    forma de credencial sai (`_sensitive_value`), profundidade e tamanho limitados. Invariante I-C.
    Chave removida é omitida, nunca substituída por marcador: o manifest promovido não pode carregar
    um placeholder que pareça valor."""
    if depth > SPEC_MAX_DEPTH:
        return None
    if isinstance(spec, bool) or isinstance(spec, (int, float)):
        return spec
    if isinstance(spec, str):
        return None if _sensitive_value(spec) else spec[:OUTPUT_VALUE_MAX]
    if isinstance(spec, list):
        items = [_safe_spec(value, depth + 1) for value in spec[:SPEC_MAX_ITEMS]]
        return [value for value in items if value is not None]
    if isinstance(spec, dict):
        out: dict[str, Any] = {}
        for key, value in sorted(spec.items())[:SPEC_MAX_ITEMS]:
            if _sensitive_key(str(key)):
                continue
            safe = _safe_spec(value, depth + 1)
            if safe is not None:
                out[str(key)[:120]] = safe
        return out
    return None


def _condition_rank(condition: dict[str, Any]) -> tuple[int, str]:
    """Relevância da condition: problema primeiro, saúde depois (issue #9)."""
    kind = str(condition.get("type") or "")
    state = str(condition.get("status") or "Unknown")
    if kind in NEGATIVE_CONDITION_TYPES and state == "True":
        rank = 0
    elif kind in READY_CONDITION_TYPES and state == "False":
        rank = 1
    elif state == "False":
        rank = 2
    elif state == "Unknown":
        rank = 3
    elif kind in READY_CONDITION_TYPES:
        rank = 4
    else:
        rank = 5
    # Dentro do mesmo rank, a transição mais recente primeiro.
    return rank, "~" if not condition.get("lastTransitionTime") else str(condition["lastTransitionTime"])


def _condition_rows(status: dict[str, Any], now: int) -> list[dict[str, Any]]:
    """Conditions reais do objeto, ordenadas por relevância e com mensagem truncada."""
    rows: list[dict[str, Any]] = []
    for condition in (status or {}).get("conditions", []) or []:
        if not isinstance(condition, dict):
            continue
        transition = condition.get("lastTransitionTime")
        moment = _epoch_any(transition)
        rows.append({
            "type": str(condition.get("type") or ""),
            "status": str(condition.get("status") or "Unknown"),
            # reason e message são texto de controller, logo passam os dois pela
            # mesma negação de forma dos outputs: condition de ACK já veio com
            # credencial no meio, e o reason não era filtrado.
            "reason": _safe_text(condition.get("reason"), 120),
            "message": _safe_text(condition.get("message")),
            "lastTransition": transition if isinstance(transition, str) else None,
            "ageSeconds": (now - moment) if moment is not None else None,
        })
    rows.sort(key=lambda row: _condition_rank(row))
    return rows


def _int_or_none(value: Any) -> int | None:
    """int de verdade. bool é int em Python e `observedGeneration: true` não é geração."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _observed_generation(status: dict[str, Any], conditions: list[dict[str, Any]]) -> int | None:
    """observedGeneration da leitura, do topo do status OU da própria condition.

    O topo vence quando existe. Faltando lá, vale o campo da CONDITION: o kro
    publica no formato de `metav1.Condition`, que carrega `observedGeneration` em
    cada condition, e o topo do status de uma instância kro pode simplesmente não
    existir. Ler só o topo fazia TODA instância kro real cair em
    OBSERVED_GENERATION_MISSING e nunca aparecer Ready (medido em 15/10/2026).

    Nenhuma das duas presentes continua sendo "não dá para provar", nunca Ready:
    é o caso do ACK, cujo `Condition` (apis/core/v1alpha1) tem type, status,
    lastTransitionTime, reason e message e NÃO tem observedGeneration - nem o
    status dele publica um no topo. A consequência está medida em teste: recurso
    ACK fica não-Ready com basis OBSERVED_GENERATION_MISSING. Afrouxar isso é
    decisão de produto, não de implementação, porque derruba a invariante I-B.
    """
    top = _int_or_none(status.get("observedGeneration"))
    if top is not None:
        return top
    ordered = [row for kind in READY_CONDITION_TYPES for row in conditions
               if str(row.get("type")) == kind] + conditions
    for candidate in ordered:
        found = _int_or_none(candidate.get("observedGeneration"))
        if found is not None:
            return found
    return None


def _ready_state(item: dict[str, Any]) -> dict[str, Any]:
    """Ready do objeto. Invariante I-B: condition real E observedGeneration atual.

    Precedência dos motivos, do mais específico para o mais genérico:

      1. condition de falha DECLARADA em True (READY_BLOCKING_CONDITION_TYPES).
         Um objeto com `ACK.Terminal=True` e `Ready=True` ao mesmo tempo não é
         pronto: o controller está dizendo que o spec não converge. Antes daqui a
         primeira condition de prontidão em True ganhava e a linha saía Ready.
      2. condition de prontidão declarada False. Com `Ready=True` e
         `InstanceSynced=False` no mesmo objeto, a NEGATIVA manda - a ordem de
         preferência de READY_CONDITION_TYPES não pode escolher a conveniente.
      3. nenhuma condition de prontidão -> NO_READY_CONDITION.
      4. sem observedGeneration provável -> OBSERVED_GENERATION_MISSING.
      5. observedGeneration atrás da generation -> STATUS_STALE.
    """
    metadata = item.get("metadata", {}) or {}
    status = item.get("status", {}) or {}
    conditions = [row for row in (status.get("conditions") or []) if isinstance(row, dict)]
    generation = _int_or_none(metadata.get("generation"))
    observed = _observed_generation(status, conditions)
    current = generation is not None and observed is not None and observed >= generation

    blocking = next((row for row in conditions
                     if str(row.get("type")) in READY_BLOCKING_CONDITION_TYPES
                     and str(row.get("status")) == "True"), None)
    declared_false = next((row for row in conditions
                           if str(row.get("type")) in READY_CONDITION_TYPES
                           and str(row.get("status")) != "True"), None)
    preferred = next((row for kind in READY_CONDITION_TYPES for row in conditions
                      if str(row.get("type")) == kind), None)
    # A condition REPORTADA é a que decidiu, não a mais simpática.
    condition = blocking or declared_false or preferred

    if blocking is not None:
        basis, ready = READY_BASIS_NEGATIVE, False
    elif condition is None:
        basis, ready = READY_BASIS_NO_CONDITION, False
    elif str(condition.get("status")) != "True":
        basis, ready = f"CONDITION_{str(condition.get('status') or 'Unknown').upper()}", False
    elif observed is None:
        basis, ready = READY_BASIS_NO_OBSERVED, False
    elif not current:
        basis, ready = READY_BASIS_STALE, False
    else:
        basis, ready = READY_BASIS_TRUE, True
    return {
        "ready": ready,
        "readyBasis": basis,
        "readyCondition": str(condition.get("type")) if condition else None,
        "readyReason": _safe_text(condition.get("reason"), 120) if condition else "",
        "generation": generation,
        "observedGeneration": observed,
        "statusStale": not current,
    }


def _freshness(item: dict[str, Any], ready: dict[str, Any], conditions: list[dict[str, Any]],
               argo_readable: bool, now: int) -> dict[str, Any]:
    """Quão confiável é esta leitura, e por quê. `stale` vazio significa fresca."""
    metadata = item.get("metadata", {}) or {}
    created = _epoch_any(metadata.get("creationTimestamp"))
    ages = [row["ageSeconds"] for row in conditions if row.get("ageSeconds") is not None]
    reasons: list[str] = []
    if ready["statusStale"]:
        reasons.append("GENERATION_LAG" if ready["observedGeneration"] is not None else "OBSERVED_GENERATION_MISSING")
    if not conditions:
        reasons.append("NO_CONDITIONS")
    if not argo_readable:
        reasons.append("ARGO_UNKNOWN")
    age = (now - created) if created is not None else None
    if not ready["ready"] and age is not None and age > INSTANCE_CONVERGE_BUDGET_SECONDS:
        reasons.append("CONVERGE_BUDGET_EXCEEDED")
    return {
        "readAt": now,
        "ageSeconds": age,
        "lastTransitionAgeSeconds": min(ages) if ages else None,
        "stale": bool(reasons),
        "staleReasons": reasons,
        "convergeBudgetSeconds": INSTANCE_CONVERGE_BUDGET_SECONDS,
    }


# ---------------------------------------------------------------------------
# Descoberta: capability -> kind -> plural, tudo lido do cluster.
#
# A identidade da capability é o NOME DO RGD (`static-web-app`), que é o mesmo
# que o `rgdRef` das capability.yaml do catálogo aponta, e o kind é o
# `spec.schema.kind` dele. Nada vem de fixture: se o RGD não está no cluster, a
# capability não aparece. Para ACK, a capability é `<grupo-curto>/<plural>`,
# derivada da discovery do grupo.
# ---------------------------------------------------------------------------


def _source_failed(path: str, code: str, error: BaseException) -> str:
    """Registra a falha de leitura de UMA fonte e devolve o código para o chamador (I-A inalterada).

    Até 26/10/2026 uma fonte falha não deixava rastro: o portal mostrava "cluster discovery unavailable"
    e o log da Lambda só tinha o `cluster_api_request`, então a causa (401 do API server, DNS, timeout)
    era indecidível depois do fato. Uma linha JSON por falha, com a classe e o texto da exceção."""
    print(json.dumps({"event": "source_read_failed", "path": path[:160], "code": code,
                      "error": f"{type(error).__name__}: {str(error)[:200]}"}))
    return code


def _list_source(path: str, limit: int = SOURCE_FETCH_LIMIT) -> tuple[list[dict[str, Any]], bool, str]:
    """Lista uma fonte. Devolve (items, truncated, error). Nunca levanta.

    Invariante I-A: o erro VOLTA como string em vez de virar lista vazia, e quem
    chama precisa decidir o que fazer com ele.
    """
    joiner = "&" if "?" in path else "?"
    try:
        payload = _k8s("GET", f"{path}{joiner}limit={int(limit)}")
    except urllib.error.HTTPError as error:
        return [], False, _source_failed(path, f"http_{error.code}", error)
    except (urllib.error.URLError, TimeoutError) as error:
        return [], False, _source_failed(path, "unreachable", error)
    except (OSError, ValueError, KeyError, TypeError) as error:
        return [], False, _source_failed(path, "unreadable", error)
    items = [item for item in payload.get("items", []) or [] if isinstance(item, dict)]
    truncated = bool((payload.get("metadata", {}) or {}).get("continue"))
    return items, truncated, ""


def _kro_capabilities() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Capabilities kro vivas: um RGD por capability, com o kind e o plural dele."""
    rgds, _, rgd_error = _list_source(f"{KRO_API}/resourcegraphdefinitions")
    sources = [{"source": "kro.run/resourcegraphdefinitions", "ok": not rgd_error, "error": rgd_error}]
    if rgd_error:
        return [], sources
    discovery_error, plurals = "", {}
    try:
        for resource in _k8s("GET", KRO_API).get("resources", []) or []:
            plural = str(resource.get("name") or "")
            kind = str(resource.get("kind") or "")
            if "/" in plural or plural == "resourcegraphdefinitions" or "list" not in (resource.get("verbs") or []):
                continue
            if kind:
                plurals[kind] = plural
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, ValueError, KeyError, TypeError):
        discovery_error = "unreadable"
    sources.append({"source": "kro.run/discovery", "ok": not discovery_error, "error": discovery_error})
    capabilities = []
    for rgd in rgds:
        metadata = rgd.get("metadata", {}) or {}
        schema = ((rgd.get("spec", {}) or {}).get("schema", {}) or {})
        name, kind = str(metadata.get("name") or ""), str(schema.get("kind") or "")
        if not name or not kind:
            continue
        version = str(schema.get("apiVersion") or "v1alpha1")
        capabilities.append({
            "capability": name,
            "engine": "kro",
            "kind": kind,
            "apiVersion": f"kro.run/{version}",
            # Sem o plural da discovery não há como listar o kind. O item fica
            # visível com `listable: false` em vez de desaparecer em silêncio.
            "plural": plurals.get(kind, ""),
            "listable": bool(plurals.get(kind)),
            "basePath": f"/apis/kro.run/{version}/{plurals[kind]}" if plurals.get(kind) else "",
            "state": str((rgd.get("status", {}) or {}).get("state") or "Unknown"),
            "topology": len((rgd.get("spec", {}) or {}).get("resources", []) or []),
        })
    capabilities.sort(key=lambda row: row["capability"])
    return capabilities, sources


def _ack_capabilities() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Capabilities ACK vivas, uma por kind de cada grupo concedido no RBAC.

    Grupo que responde 404 na discovery NÃO é erro: é controller ACK que não está
    instalado neste cluster, o que é resposta definitiva. Tratá-lo como falha
    deixaria `partial` true para sempre e o aviso de degradado viraria ruído, que
    é o oposto do que a issue #8 pede. 403, timeout e corpo ilegível seguem erro.
    """
    capabilities, sources = [], []
    for group in ACK_API_GROUPS:
        error, absent, resources, version = "", False, [], ""
        try:
            versions = _k8s("GET", f"/apis/{urllib.parse.quote(group)}")
            preferred = (versions.get("preferredVersion", {}) or {}).get("version")
            candidates = [str(entry.get("version")) for entry in versions.get("versions", []) or []]
            version = str(preferred or (candidates[0] if candidates else "") or "")
            if version:
                resources = _k8s("GET", f"/apis/{urllib.parse.quote(group)}/{urllib.parse.quote(version)}").get("resources", []) or []
            else:
                error = "no_version"
        except urllib.error.HTTPError as http_error:
            if http_error.code == 404:
                absent = True
            else:
                error = f"http_{http_error.code}"
        except (urllib.error.URLError, TimeoutError):
            error = "unreachable"
        except (OSError, ValueError, KeyError, TypeError):
            error = "unreadable"
        source = {"source": f"{group}/discovery", "ok": not error, "error": error}
        if absent:
            source["absent"] = True
        sources.append(source)
        for resource in resources:
            plural = str(resource.get("name") or "")
            kind = str(resource.get("kind") or "")
            if "/" in plural or not kind or "list" not in (resource.get("verbs") or []):
                continue
            capabilities.append({
                "capability": f"{group.split('.')[0]}/{plural}",
                "engine": "ack",
                "kind": kind,
                "apiVersion": f"{group}/{version}",
                "plural": plural,
                "listable": True,
                "basePath": f"/apis/{group}/{version}/{plural}",
                "state": "Unknown",
                "topology": 0,
            })
    capabilities.sort(key=lambda row: row["capability"])
    return capabilities, sources


def _capability_index(include_ack: bool = True) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    capabilities, sources = _kro_capabilities()
    if include_ack:
        ack, ack_sources = _ack_capabilities()
        capabilities = capabilities + ack
        sources = sources + ack_sources
    return capabilities, sources


def _degraded(sources: list[dict[str, Any]]) -> tuple[bool, bool]:
    """(partial, total_failure). Invariante I-A vive nestes dois bits."""
    if not sources:
        return False, True
    failed = [source for source in sources if not source.get("ok")]
    return bool(failed), len(failed) == len(sources)


def _lookup_blockers(sources: list[dict[str, Any]], wanted: str, wanted_kind: str) -> list[dict[str, Any]]:
    """Fontes cuja falha impede PROVAR que o que foi pedido explicitamente não existe.

    Um pedido nominal que não resolveu só é 404 quando TODA fonte capaz de
    responder por ele foi lida. Com a fonte relevante falhando, "não achei" é
    leitura falha e não ausência, e 404 ali manda a UI afirmar "não existe" sobre
    um cluster que ela não conseguiu ler - o mesmo erro de origem virando resposta
    definitiva que a invariante I-A proíbe, só que com outro código de status.
    Medido em 15/10/2026: RGD do kro em 503 e um grupo ACK ausente respondiam 404.

    Relevância é por engine, porque cada uma só pode ser respondida por uma fonte:
    capability com `/` existe apenas em grupo ACK, capability sem `/` sai apenas de
    RGD do kro. Pedido só por `kind` pode ser de qualquer um dos dois, então aí
    qualquer falha conta. Fonte `absent` (404 na discovery) é resposta definitiva e
    já entra como ok, logo nunca bloqueia.
    """
    failed = [source for source in sources if not source.get("ok")]
    if not failed:
        return []
    if wanted and "/" in wanted:
        group = wanted.split("/", 1)[0]
        return [source for source in failed
                if str(source.get("source", "")).split("/", 1)[0].split(".")[0] == group]
    if wanted:
        return [source for source in failed if str(source.get("source", "")).startswith("kro.run/")]
    return failed


# ---------------------------------------------------------------------------
# Listagem (issue #8) e detalhe (issue #9).
# ---------------------------------------------------------------------------


def _namespace_scope(raw: Any) -> str:
    """Namespace validado. Invariante I-D: o escopo vai para a URL do API server."""
    value = str(raw or ALL_NAMESPACES).strip() or ALL_NAMESPACES
    if value == ALL_NAMESPACES:
        return ALL_NAMESPACES
    if not NAMESPACE_PATTERN.fullmatch(value):
        raise ValueError("invalid namespace")
    return value


def _page_size(raw: Any) -> int:
    try:
        size = int(str(raw or PAGE_SIZE_DEFAULT))
    except ValueError as error:
        raise ValueError("invalid limit") from error
    if size < 1:
        raise ValueError("invalid limit")
    return min(size, PAGE_SIZE_MAX)


def _query_digest(parts: dict[str, str]) -> str:
    """Impressão da consulta. O cursor só vale para a MESMA consulta.

    Sem isto, um cursor de uma busca entraria noutra e a página sairia de um
    conjunto que o usuário não pediu - paginação que mente sobre o universo.
    """
    canonical = "&".join(f"{key}={parts[key]}" for key in sorted(parts))
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


def _encode_cursor(offset: int, digest: str) -> str:
    return base64.urlsafe_b64encode(f"{digest}:{offset}".encode()).decode().rstrip("=")


def _decode_cursor(cursor: str, digest: str) -> int:
    if not cursor:
        return 0
    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode()).decode()
        seen, _, offset = raw.partition(":")
        position = int(offset)
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("invalid cursor") from error
    if seen != digest or position < 0:
        raise ValueError("cursor does not match this query")
    return position


def _safe_labels(metadata: dict[str, Any]) -> dict[str, str]:
    """Labels publicáveis. Nome ou valor com cara de credencial não sai.

    Existe porque _meta() devolve `labels` CRU: na listagem isso furava a
    invariante I-C enquanto o detalhe filtrava, medido em 15/10/2026 com
    `platform.appmod/api-token` saindo inteiro numa linha da lista.
    """
    return {key: str(value)[:253] for key, value in sorted((metadata.get("labels") or {}).items())
            if not _sensitive_key(key) and not _sensitive_value(str(value))}


OWNER_LABEL = "platform.appmod/owner"


def _owner_of(item: dict[str, Any]) -> str:
    """Owner declarado no objeto (backlog ownership-model): o label `platform.appmod/owner`, que
    vale para qualquer kind, ou `spec.owner` quando o schema da composição o declara. Vazio quando
    nenhum existe: a UI mostra "sem owner", nunca inventa o do projeto no lugar."""
    labels = (item.get("metadata", {}) or {}).get("labels") or {}
    spec = item.get("spec") if isinstance(item.get("spec"), dict) else {}
    value = labels.get(OWNER_LABEL) or spec.get("owner") or ""
    return _safe_text(value, 120) if isinstance(value, str) else ""


def _instance_row(item: dict[str, Any], capability: dict[str, Any], now: int,
                  argo_readable: bool) -> dict[str, Any]:
    """Linha da listagem: identidade, estado real, frescor. Sem credencial."""
    metadata = item.get("metadata", {}) or {}
    status = item.get("status", {}) or {}
    ready = _ready_state(item)
    conditions = _condition_rows(status, now)
    # `state` é string livre de controller como message e reason, logo mesma negação.
    state = status.get("state")
    state_text = _safe_text(state, 60) if isinstance(state, str) else ""
    synced = next((row["status"] for row in conditions if row["type"] in READY_CONDITION_TYPES), "Unknown")
    return {
        **_meta(item),
        # Sobrescreve o `labels` cru que _meta() traz (invariante I-C).
        "labels": _safe_labels(metadata),
        "capability": capability["capability"],
        "engine": capability["engine"],
        "owner": _owner_of(item),
        "kind": str(item.get("kind") or capability["kind"]),
        "apiVersion": str(item.get("apiVersion") or capability["apiVersion"]),
        "uid": str(metadata.get("uid") or ""),
        "state": state_text or ready["readyBasis"],
        "synced": synced,
        "ready": ready["ready"],
        "readyBasis": ready["readyBasis"],
        "generation": ready["generation"],
        "observedGeneration": ready["observedGeneration"],
        "statusStale": ready["statusStale"],
        "conditionCount": len(conditions),
        "freshness": _freshness(item, ready, conditions, argo_readable, now),
    }


def _live_instance_rows(namespace: str, selected: list[dict[str, Any]], sources: list[dict[str, Any]],
                        now: int, full_scorecard: bool = False) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], bool]:
    """Lê as instâncias vivas das capabilities selecionadas e monta as linhas, com scorecard.

    Extraído de `_instances_view` em 25/10/2026 para a visão agregada de scorecards ler as mesmas
    linhas pelo mesmo caminho: um loop só, uma fonte de erro só. `sources` recebe uma entrada por
    capability lida (ok/erro/truncada); o terceiro item são as fontes truncadas e o quarto diz se o Argo foi lido. A listagem carrega
    o scorecard compacto (nível e contagem); `full_scorecard` traz também as regras avaliadas.
    """
    _, argo_names, argo_readable = _argo_application(INSTANCES_ARGO_APPLICATION, tracked_kind=None)
    rows: list[dict[str, Any]] = []
    truncated_sources: list[str] = []
    for capability in selected:
        path = _ns_path(capability["basePath"].rsplit("/", 1)[0], namespace, "/" + capability["plural"])
        items, source_truncated, error = _list_source(path)
        source = {"source": f"{capability['capability']}:{capability['kind']}",
                  "ok": not error, "error": error}
        if source_truncated:
            source["truncated"] = True
            truncated_sources.append(source["source"])
        sources.append(source)
        for item in items:
            row = _instance_row(item, capability, now, argo_readable)
            card = _scorecard(item, capability, _gitops_tracked(item, argo_names, argo_readable), argo_readable)
            row["scorecard"] = card if full_scorecard else _scorecard_summary(card)
            rows.append(row)
    return rows, sources, truncated_sources, argo_readable


# ---------------------------------------------------------------------------
# Grafo entre instâncias (backlog cross-instance-graph): quem consome output de quem.
#
# O grafo da composição cobre UMA definição. Este cruza instâncias vivas do escopo e deriva arestas de
# evidência observável, nunca de inferência de nome parcial:
#   consumes       um valor string do spec de A é igual a um output publicado por B (status), ou ao
#                  metadata.name de B. Igualdade de valor inteiro; `spec.name` da própria instância
#                  não conta (self).
#   declared       label `platform.appmod/depends-on` em A (lista separada por vírgula de nomes no
#                  mesmo namespace): dependência que o autor escreveu.
#   promoted-from  annotation `platform.appmod/promoted-from: project/ns/name` (environments-promotion):
#                  a cópia aponta para a origem; origem fora do escopo entra como nó externo.
# Cada aresta leva `evidence` com o caminho exato, para a tabela acessível dizer POR QUE existe.
# externalRef do kro NÃO entra: aponta para objeto por kind/nome e não para instância; fica nomeado.
# ---------------------------------------------------------------------------
DEPENDS_ON_LABEL = "platform.appmod/depends-on"
PROMOTED_FROM_KEY = "platform.appmod/promoted-from"
GRAPH_VALUE_MIN = 4


def _spec_strings(value: Any, path: str = "spec") -> list[tuple[str, str]]:
    """(caminho, string) de cada folha string do spec sanitizado."""
    if isinstance(value, str):
        return [(path, value)]
    if isinstance(value, list):
        return [pair for index, item in enumerate(value) for pair in _spec_strings(item, f"{path}[{index}]")]
    if isinstance(value, dict):
        return [pair for key, item in sorted(value.items()) for pair in _spec_strings(item, f"{path}.{key}")]
    return []


def _instance_graph(items: list[tuple[dict[str, Any], dict[str, Any]]], owner_of: Any) -> dict[str, Any]:
    """Grafo determinístico das instâncias (item, capability) do escopo. Função pura."""
    nodes: dict[str, dict[str, Any]] = {}
    by_name: dict[tuple[str, str], str] = {}
    outputs_by_node: dict[str, dict[str, str]] = {}
    specs: dict[str, list[tuple[str, str]]] = {}
    for item, capability in items:
        metadata = item.get("metadata", {}) or {}
        ns, name = str(metadata.get("namespace") or ""), str(metadata.get("name") or "")
        kind = str(item.get("kind") or capability["kind"])
        node_id = f"{kind}/{ns}/{name}"
        project = owner_of(ns)
        ready = _ready_state(item)
        nodes[node_id] = {"id": node_id, "name": name, "namespace": ns, "kind": kind, "capability": capability["capability"],
                          "engine": capability["engine"], "project": project.id if project else "", "owner": _owner_of(item),
                          "ready": bool(ready["ready"]), "external": False, "dependsOn": []}
        by_name[(ns, name)] = node_id
        outputs_by_node[node_id] = _safe_outputs(item.get("status", {}) or {}) if capability["engine"] == "kro" else {}
        specs[node_id] = _spec_strings(_safe_spec(item.get("spec")) if isinstance(item.get("spec"), dict) else {})
    edges: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    def add(src: str, dst: str, relation: str, evidence: str) -> None:
        key = (src, dst, relation)
        if src == dst or key in seen:
            return
        seen.add(key)
        edges.append({"from": dst, "to": src, "relation": relation, "evidence": evidence[:200]})
        nodes[src]["dependsOn"].append(dst)

    for node_id, pairs in specs.items():
        ns = nodes[node_id]["namespace"]
        for path, text in pairs:
            if len(text) < GRAPH_VALUE_MIN:
                continue
            target = by_name.get((ns, text))
            if target and target != node_id:
                add(node_id, target, "consumes", f"{path} = {nodes[target]['name']} (name)")
            for other, outputs in outputs_by_node.items():
                if other == node_id:
                    continue
                for key, value in outputs.items():
                    if value == text:
                        add(node_id, other, "consumes", f"{path} = {nodes[other]['name']}.outputs.{key}")
    for item, _capability in items:
        metadata = item.get("metadata", {}) or {}
        ns, name = str(metadata.get("namespace") or ""), str(metadata.get("name") or "")
        node_id = by_name[(ns, name)]
        declared = str((metadata.get("labels") or {}).get(DEPENDS_ON_LABEL) or "")
        for dep in [d.strip() for d in declared.split(",") if d.strip()]:
            target = by_name.get((ns, dep))
            if target:
                add(node_id, target, "declared", f"label {DEPENDS_ON_LABEL}={dep}")
        promoted = str((metadata.get("annotations") or {}).get(PROMOTED_FROM_KEY) or "")
        parts = promoted.split("/")
        if len(parts) == 3 and all(parts):
            source_id = by_name.get((parts[1], parts[2]))
            if source_id is None:
                source_id = f"?/{parts[1]}/{parts[2]}"
                nodes.setdefault(source_id, {"id": source_id, "name": parts[2], "namespace": parts[1], "kind": "", "capability": "",
                                             "engine": "", "project": parts[0], "owner": "", "ready": None, "external": True,
                                             "dependsOn": []})
            add(node_id, source_id, "promoted-from", f"annotation {PROMOTED_FROM_KEY}={promoted}")
    for node in nodes.values():
        node["dependsOn"] = sorted(set(node["dependsOn"]))
    layers, cycle = _layer({node_id: set(node["dependsOn"]) for node_id, node in nodes.items()})
    ordered = [nodes[node_id] for node_id in sorted(nodes)]
    return {"nodes": ordered, "edges": sorted(edges, key=lambda e: (e["from"], e["to"], e["relation"])), "layers": layers,
            "cycle": cycle, "relations": {"consumes": sum(1 for e in edges if e["relation"] == "consumes"),
                                          "declared": sum(1 for e in edges if e["relation"] == "declared"),
                                          "promoted-from": sum(1 for e in edges if e["relation"] == "promoted-from")}}


def _instance_graph_view(params: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /cluster/instance-graph: grafo de dependências entre as instâncias do escopo."""
    namespace = _namespace_scope(params.get("ns"))
    capabilities, sources = _capability_index(include_ack=False)
    selected = [row for row in capabilities if row["listable"]]
    registry = platform_scope.load_registry()
    items: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for capability in selected:
        path = _ns_path(capability["basePath"].rsplit("/", 1)[0], namespace, "/" + capability["plural"])
        listed, truncated, error = _list_source(path)
        source = {"source": f"{capability['capability']}:{capability['kind']}", "ok": not error, "error": error}
        if truncated:
            source["truncated"] = True
        sources.append(source)
        items.extend((item, capability) for item in listed
                     if registry.owner_of(str((item.get("metadata", {}) or {}).get("namespace") or "")) is not None)
    partial, total_failure = _degraded(sources)
    if total_failure:
        return 502, {"error": "no live source could be read", "sources": sources, "partial": True}
    graph = _instance_graph(items, registry.owner_of)
    return 200, {**graph, "namespace": namespace, "partial": partial, "sources": sources, "readAt": int(time.time())}


# ---------------------------------------------------------------------------
# Saúde das integrações (backlog integrations-health): uma linha por ferramenta da plataforma, com o
# que foi MEDIDO agora (não um status copiado de catálogo): alcance, contagem, última leitura e dica.
# Argo CD, kro e ACK rodam como EKS Capabilities (fora do cluster), então a saúde deles é a dos
# objetos que publicam: Applications, RGDs e grupos de API; os que rodam no cluster são medidos pelo
# Deployment/StatefulSet. Falha de leitura é `failed` com o erro, nunca "ok" por omissão.
# ---------------------------------------------------------------------------
_INTEGRATION_WORKLOADS = (
    # id, nome, plano, kind, namespace, nome do objeto
    ("argo-workflows", "Argo Workflows", "Execution", "deployments", "argo-workflows", "argo-workflows-workflow-controller"),
    ("kagent", "kagent", "Execution", "deployments", "kagent", "kagent-controller"),
    ("langfuse", "Langfuse", "Data", "deployments", "langfuse", "langfuse-web"),
    ("grafana", "Grafana (VictoriaMetrics)", "Data", "deployments", "monitoring", "victoria-metrics-grafana"),
    ("keycloak", "Keycloak", "Identity", "statefulsets", "keycloak", "keycloak"),
)


def _integration_row(row_id: str, name: str, plane: str, status: str, detail: str, hint: str = "", now: int = 0) -> dict[str, Any]:
    return {"id": row_id, "name": name, "plane": plane, "status": status, "detail": _safe_text(detail, 200),
            "hint": _safe_text(hint, 200), "readAt": now}


def _probe(reader: Any) -> tuple[Any, str]:
    """(valor, erro). Nunca levanta: a página mostra a falha na linha, não um 502 para a página inteira."""
    try:
        return reader(), ""
    except urllib.error.HTTPError as error:
        return None, f"http_{error.code}"
    except Exception as error:  # noqa: BLE001
        return None, str(error)[:120]


def _integrations_view() -> dict[str, Any]:
    now = int(time.time())
    rows: list[dict[str, Any]] = []

    version, error = _probe(lambda: _k8s("GET", "/version"))
    rows.append(_integration_row("kubernetes", "Kubernetes API", "Execution", "failed" if error else "ok",
                                 error or str(version.get("gitVersion") or ""), "Endpoint, SG ou token da Lambda" if error else "", now))

    apps, error = _probe(lambda: _k8s("GET", "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications").get("items", []))
    if error:
        rows.append(_integration_row("argocd", "Argo CD", "Execution", "failed", error, "RBAC da cluster-api em applications.argoproj.io", now))
    else:
        synced = sum(1 for a in apps if (a.get("status", {}).get("sync", {}) or {}).get("status") == "Synced")
        healthy = sum(1 for a in apps if (a.get("status", {}).get("health", {}) or {}).get("status") == "Healthy")
        status = "ok" if apps and synced == healthy == len(apps) else "degraded" if apps else "unknown"
        rows.append(_integration_row("argocd", "Argo CD", "Execution", status,
                                     f"{len(apps)} applications, {synced} synced, {healthy} healthy",
                                     "" if status == "ok" else "Abrir o Argo CD e ver a Application fora de Synced/Healthy", now))

    rgds, error = _probe(lambda: _k8s("GET", "/apis/kro.run/v1alpha1/resourcegraphdefinitions").get("items", []))
    if error:
        rows.append(_integration_row("kro", "kro", "Execution", "failed", error, "CRD kro.run ou RBAC da cluster-api", now))
    else:
        active = sum(1 for r in rgds if (r.get("status", {}) or {}).get("state") == "Active")
        rows.append(_integration_row("kro", "kro", "Execution", "ok" if rgds and active == len(rgds) else "degraded" if rgds else "unknown",
                                     f"{len(rgds)} definições, {active} Active", "" if active == len(rgds) else "Composições: definição fora de Active", now))

    reachable, failed_groups = [], []
    for group in ACK_API_GROUPS:
        _, error = _probe(lambda g=group: _k8s("GET", f"/apis/{g}"))
        (failed_groups if error else reachable).append(group.split(".", 1)[0])
    rows.append(_integration_row("ack", "ACK controllers", "Execution", "ok" if not failed_groups else "degraded" if reachable else "failed",
                                 f"{len(reachable)}/{len(ACK_API_GROUPS)} grupos de API publicados" + (f"; sem: {', '.join(failed_groups)}" if failed_groups else ""),
                                 "Capability ACK do grupo ausente não está instalada no cluster" if failed_groups else "", now))

    _, error = _probe(lambda: _k8s("GET", "/apis/metrics.k8s.io/v1beta1"))
    rows.append(_integration_row("metrics-server", "metrics-server", "Execution", "failed" if error else "ok",
                                 error or "metrics.k8s.io/v1beta1 publicado", "Sem ele a Home e o cluster não mostram CPU/memória" if error else "", now))

    for row_id, name, plane, kind, namespace, obj in _INTEGRATION_WORKLOADS:
        item, error = _probe(lambda k=kind, ns=namespace, o=obj: _k8s("GET", f"/apis/apps/v1/namespaces/{ns}/{k}/{o}"))
        if error:
            rows.append(_integration_row(row_id, name, plane, "failed" if error != "http_404" else "unknown",
                                         "não instalado" if error == "http_404" else error, f"{kind}/{obj} em {namespace}", now))
            continue
        spec_replicas = int((item.get("spec", {}) or {}).get("replicas") or 0)
        ready = int((item.get("status", {}) or {}).get("readyReplicas") or 0)
        rows.append(_integration_row(row_id, name, plane, "ok" if spec_replicas and ready == spec_replicas else "degraded",
                                     f"{ready}/{spec_replicas} réplicas prontas", "" if ready == spec_replicas else f"kubectl -n {namespace} describe {kind[:-1]} {obj}", now))

    store = _events()
    if not store.enabled:
        rows.append(_integration_row("events", "Trilha de eventos (DynamoDB)", "Data", "unknown", "EVENTS_TABLE não configurada", "", now))
    else:
        states, error = _probe(store.ready_states)
        rows.append(_integration_row("events", "Trilha de eventos (DynamoDB)", "Data", "failed" if error else "ok",
                                     error or f"{len(states)} instâncias com estado de Ready", "IAM PlatformReadyStateRead da cluster-api" if error else "", now))

    summary = {status: sum(1 for r in rows if r["status"] == status) for status in ("ok", "degraded", "failed", "unknown")}
    return {"items": rows, "summary": summary, "readAt": now}


def _matches(row: dict[str, Any], search: str, state: str, synced: str, ready: str) -> bool:
    if search:
        haystack = " ".join(str(row.get(field) or "") for field in ("name", "namespace", "kind", "capability", "owner")).lower()
        if search not in haystack:
            return False
    if state and str(row.get("state", "")).lower() != state:
        return False
    if synced and str(row.get("synced", "")).lower() != synced:
        return False
    if ready in ("true", "false") and row.get("ready") is not (ready == "true"):
        return False
    return True


_SORT_KEYS = {
    "name": lambda row: (str(row.get("name") or ""),),
    "namespace": lambda row: (str(row.get("namespace") or ""), str(row.get("name") or "")),
    "kind": lambda row: (str(row.get("kind") or ""), str(row.get("name") or "")),
    "capability": lambda row: (str(row.get("capability") or ""), str(row.get("name") or "")),
    "state": lambda row: (str(row.get("state") or ""), str(row.get("name") or "")),
    "created": lambda row: (str(row.get("created") or ""), str(row.get("name") or "")),
    "ready": lambda row: (not row.get("ready"), str(row.get("name") or "")),
}


def _instances_view(params: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /cluster/instances: listagem live, filtrada e paginada no servidor."""
    namespace = _namespace_scope(params.get("ns"))
    wanted = str(params.get("capability") or "").strip()
    if wanted and not CAPABILITY_PATTERN.fullmatch(wanted.replace("/", "-")):
        raise ValueError("invalid capability")
    wanted_kind = str(params.get("kind") or "").strip()
    if wanted_kind and not KIND_PATTERN.fullmatch(wanted_kind):
        raise ValueError("invalid kind")
    search = str(params.get("q") or "").strip().lower()[:120]
    state = str(params.get("state") or "").strip().lower()[:60]
    synced = str(params.get("synced") or "").strip().lower()[:30]
    ready = str(params.get("ready") or "").strip().lower()[:5]
    sort = str(params.get("sort") or "name").strip().lower()
    if sort not in _SORT_KEYS:
        raise ValueError("invalid sort")
    descending = str(params.get("order") or "asc").strip().lower() == "desc"
    size = _page_size(params.get("limit"))

    # ACK só é varrido quando a consulta pede: uma listagem sem capability nem
    # kind pagaria a discovery de todos os grupos a cada request.
    include_ack = bool(wanted or wanted_kind) or str(params.get("engine") or "").lower() == "ack"
    capabilities, sources = _capability_index(include_ack=include_ack)
    selected = [row for row in capabilities
                if (not wanted or row["capability"] == wanted)
                and (not wanted_kind or row["kind"] == wanted_kind)
                and row["listable"]]
    if (wanted or wanted_kind) and not selected:
        _, total_failure = _degraded(sources)
        if total_failure:
            return 502, {"error": "cluster discovery unavailable", "sources": sources, "partial": True}
        blockers = _lookup_blockers(sources, wanted, wanted_kind)
        if blockers:
            # A fonte que responderia por este pedido falhou: isto é erro de
            # leitura, não ausência. 404 aqui seria a UI afirmando "não existe".
            return 502, {"error": "the live source for the requested capability could not be read",
                         "sources": sources, "partial": True, "blockedBy": blockers}
        return 404, {"error": "capability or kind not found in the live cluster", "sources": sources}

    now = int(time.time())
    rows, sources, truncated_sources, _ = _live_instance_rows(namespace, selected, sources, now)
    rows = [row for row in rows if _matches(row, search, state, synced, ready)]
    truncated = bool(truncated_sources)

    partial, total_failure = _degraded(sources)
    if total_failure:
        # Invariante I-A: nenhuma fonte respondeu, então isto é erro, não "vazio".
        return 502, {"error": "no live source could be read", "sources": sources, "partial": True}
    # NÃO existe 502 aqui para "a capability pedida falhou mas a discovery leu".
    # Esse caso é 200 com `partial` true e o erro NOMEADO em `sources`, que é o
    # contrato que test_source_error_is_reported_and_never_an_empty_list fixa: a UI
    # mostra o aviso de degradado em vez de um empty state de sucesso, e não afirma
    # ausência. O 502 fica para "nenhuma fonte respondeu" e para o pedido nominal que
    # não pôde ser RESOLVIDO (acima), onde não há nem o que listar.

    rows.sort(key=_SORT_KEYS[sort], reverse=descending)
    digest = _query_digest({"ns": namespace, "capability": wanted, "kind": wanted_kind, "q": search,
                            "state": state, "synced": synced, "ready": ready,
                            "sort": sort, "order": "desc" if descending else "asc"})
    offset = _decode_cursor(str(params.get("cursor") or ""), digest)
    page = rows[offset:offset + size]
    next_offset = offset + len(page)
    return 200, {
        "items": page,
        "total": len(rows),
        "namespace": namespace,
        "capabilities": [{"capability": row["capability"], "kind": row["kind"], "engine": row["engine"]}
                         for row in selected],
        "kinds": sorted({row["kind"] for row in selected}),
        "page": {"limit": size, "offset": offset, "returned": len(page),
                 "nextCursor": _encode_cursor(next_offset, digest) if next_offset < len(rows) else None},
        # `partial` e `sources` são o contrato de "erro de origem não é lista vazia":
        # com partial true a UI mostra o aviso e não um empty state de sucesso.
        #
        # Fonte truncada entra em `partial` pelo MESMO motivo: a busca e os filtros
        # rodam sobre o pedaço que veio, logo `total` é piso e zero resultado NÃO é
        # conclusão. Sem isto, uma busca atrás do corte de SOURCE_FETCH_LIMIT saía
        # como 200 limpo com total 0, que a UI lê como "não existe".
        "partial": partial or truncated,
        "truncated": truncated,
        "truncatedSources": truncated_sources,
        "sources": sources,
        "readAt": now,
    }


def _capabilities_view(params: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /cluster/capabilities: o que existe vivo, com contagem por kind."""
    namespace = _namespace_scope(params.get("ns"))
    include_ack = str(params.get("engine") or "").lower() in ("", "all", "ack")
    with_counts = str(params.get("counts") or "false").lower() == "true"
    capabilities, sources = _capability_index(include_ack=include_ack)
    truncated = False
    if with_counts:
        for capability in capabilities:
            if not capability["listable"]:
                capability["instances"] = None
                capability["instancesTruncated"] = False
                continue
            path = _ns_path(capability["basePath"].rsplit("/", 1)[0], namespace, "/" + capability["plural"])
            items, count_truncated, error = _list_source(path)
            source = {"source": f"{capability['capability']}:count", "ok": not error, "error": error}
            if count_truncated:
                source["truncated"] = True
            sources.append(source)
            capability["instances"] = None if error else len(items)
            # Contagem atrás do corte é PISO, não total. Sem este bit a UI mostra
            # "500" como exato enquanto o cluster tem mais.
            capability["instancesTruncated"] = bool(count_truncated)
            truncated = truncated or count_truncated
    partial, total_failure = _degraded(sources)
    if total_failure:
        return 502, {"error": "cluster discovery unavailable", "sources": sources, "partial": True}
    return 200, {"capabilities": capabilities, "namespace": namespace,
                 "partial": partial or truncated, "truncated": truncated,
                 "sources": sources, "readAt": int(time.time())}


def _instance_trail(item: dict[str, Any], capability: dict[str, Any]) -> dict[str, Any]:
    """Trail pedido -> MR -> Argo -> recurso. Só o que o objeto realmente carrega.

    Issue #9: "quando os dados existirem". Nada é inventado aqui: annotation
    ausente vira None, e o estado do Argo só aparece se a Application foi lida.
    """
    metadata = item.get("metadata", {}) or {}
    annotations = metadata.get("annotations", {}) or {}
    labels = metadata.get("labels", {}) or {}
    tracking = str(annotations.get(_ARGO_TRACKING_ANNOTATION) or "")
    candidate = tracking.split(":", 1)[0] if ":" in tracking else str(labels.get(_ARGO_INSTANCE_LABEL) or "")
    # O alvo é texto de TERCEIRO (annotation ou label do objeto) e vai para dentro de
    # uma URL do API server. Sem validar aqui, `../../../../api/v1/...` escapava do
    # /applications/ e a Lambda fazia a chamada com o token dela (medido 15/10/2026).
    # Valor fora da forma volta para a Application padrão, que é constante do servidor.
    application_name = (candidate if ARGO_APPLICATION_PATTERN.fullmatch(candidate)
                        else INSTANCES_ARGO_APPLICATION)
    argo, argo_names, readable = _argo_application(application_name, tracked_kind=str(item.get("kind") or ""))
    name = str(metadata.get("name") or "")
    # Rastreio contra a Application que FOI lida, e não contra a do Agent Builder: a versão
    # anterior comparava a marca do Argo com `ARGO_APPLICATION` e passava a lista de recursos
    # vazia, então toda instância de `agent-platform-instances` aparecia "não rastreada" mesmo
    # com sync/health lidos da mesma Application (finding live de 22/10/2026).
    tracked = _argo_tracked(metadata, name, argo_names, readable, application=application_name)
    request_id = str(annotations.get("platform.appmod/request-id") or "")
    mr_url = _safe_mr_url(annotations.get("platform.appmod/mr-url"))
    return {
        "request": {
            "requestId": request_id if _REQUEST_ID_PATTERN.fullmatch(request_id) else None,
            "requester": _safe_text(labels.get("platform.appmod/requester"), 253) or None,
        },
        # Proveniência do Platform Assistant: os labels que o planner grava no manifest. Só o
        # par validado sai; o plano em si (passos, MR, autor) continua atrás da autorização da
        # API do Assistant, que confere membership no projeto antes de abrir.
        "plan": _plan_provenance(labels),
        # Arquivo de origem no GitOps, só quando o próprio Argo prova que o objeto veio da
        # Application das instâncias, que aplica `platform/instances`. É o alvo do "editar no
        # GitLab": sem essa prova a UI não oferece edição, em vez de chutar um arquivo.
        "gitopsPath": (f"{INSTANCES_GITOPS_DIRECTORY}/{name}.yaml"
                       if tracked and application_name == INSTANCES_ARGO_APPLICATION
                       and OBJECT_NAME_PATTERN.fullmatch(name) else None),
        # URL de MR só sai se for do GitLab interno E sem query: annotation é texto de
        # terceiro, link arbitrário no detalhe é vetor de phishing na UI, e a query é
        # onde cabe `?private_token=`.
        "mergeRequest": {"url": mr_url} if mr_url else None,
        "argo": {**argo, "readable": readable,
                 "trackedBy": application_name,
                 "tracked": tracked},
        "resource": {
            "apiVersion": str(item.get("apiVersion") or capability["apiVersion"]),
            "kind": str(item.get("kind") or capability["kind"]),
            "namespace": str(metadata.get("namespace") or ""),
            "name": str(metadata.get("name") or ""),
            "uid": str(metadata.get("uid") or ""),
            "resourceVersion": str(metadata.get("resourceVersion") or ""),
            "capability": capability["capability"],
        },
    }


def _safe_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Metadata publicável. Annotation é filtrada: lá mora last-applied-configuration."""
    annotations = {key: str(value)[:OUTPUT_VALUE_MAX]
                   for key, value in sorted((metadata.get("annotations") or {}).items())
                   if key.startswith("platform.appmod/") and not _sensitive_key(key)
                   and not _sensitive_value(str(value))}
    return {
        "name": str(metadata.get("name") or ""),
        "namespace": str(metadata.get("namespace") or ""),
        "uid": str(metadata.get("uid") or ""),
        "resourceVersion": str(metadata.get("resourceVersion") or ""),
        "created": metadata.get("creationTimestamp"),
        "labels": _safe_labels(metadata),
        "annotations": annotations,
        "finalizers": [str(entry) for entry in (metadata.get("finalizers") or []) if isinstance(entry, str)][:10],
        "deleting": bool(metadata.get("deletionTimestamp")),
    }


def _instance_detail(params: dict[str, Any], is_admin: bool) -> tuple[int, dict[str, Any]]:
    """GET /cluster/instance: detalhe de UMA instância (issue #9)."""
    namespace = _namespace_scope(params.get("ns"))
    if namespace == ALL_NAMESPACES:
        raise ValueError("ns is required for a single instance")
    name = str(params.get("name") or "").strip()
    if not OBJECT_NAME_PATTERN.fullmatch(name):
        raise ValueError("invalid instance name")
    wanted_kind = str(params.get("kind") or "").strip()
    wanted = str(params.get("capability") or "").strip()
    if not wanted_kind and not wanted:
        raise ValueError("kind or capability is required")
    if wanted_kind and not KIND_PATTERN.fullmatch(wanted_kind):
        raise ValueError("invalid kind")

    capabilities, sources = _capability_index(include_ack=True)
    selected = next((row for row in capabilities if row["listable"]
                     and (not wanted or row["capability"] == wanted)
                     and (not wanted_kind or row["kind"] == wanted_kind)), None)
    if selected is None:
        _, total_failure = _degraded(sources)
        if total_failure:
            return 502, {"error": "cluster discovery unavailable", "sources": sources, "partial": True}
        blockers = _lookup_blockers(sources, wanted, wanted_kind)
        if blockers:
            # Mesma regra da listagem: sem ler a fonte relevante, "não achei" é
            # falha de leitura. 404 aqui faria a UI dizer que o recurso não existe.
            return 502, {"error": "the live source for the requested capability could not be read",
                         "sources": sources, "partial": True, "blockedBy": blockers}
        return 404, {"error": "capability or kind not found in the live cluster", "sources": sources}

    # `safe=""` nos dois: namespace e name já passaram pelo regex, e o default do
    # quote não escapa `/`, então deixar o default seria confiar só na validação.
    path = (f"{selected['basePath'].rsplit('/', 1)[0]}/namespaces/{urllib.parse.quote(namespace, safe='')}"
            f"/{selected['plural']}/{urllib.parse.quote(name, safe='')}")
    try:
        item = _k8s("GET", path)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return 404, {"error": "instance not found"}
        # 403 do API server é erro de leitura, nunca "não existe": a issue #9 exige
        # que falha de leitura apareça como erro e não como Ready ou vazio.
        return 502, {"error": f"kubernetes api returned {error.code}",
                     "sources": sources + [{"source": f"{selected['capability']}:get",
                                             "ok": False, "error": f"http_{error.code}"}],
                     "partial": True}

    now = int(time.time())
    status = item.get("status", {}) or {}
    ready = _ready_state(item)
    conditions = _condition_rows(status, now)
    trail = _instance_trail(item, selected)
    # Scorecard do detalhe: o rastreio do Argo vem do trail, que já escolheu a Application certa.
    tracked = True if trail["argo"]["tracked"] else (False if trail["argo"]["readable"] else None)
    scorecard = _scorecard(item, selected, tracked, trail["argo"]["readable"])
    # Grafo da composição, nativo: só existe para kro. Falha de leitura da RGD
    # vira uma fonte com erro, nunca um grafo vazio que pareça "sem recursos".
    composition, composition_source = _composition_for(selected)
    if composition_source is not None:
        sources = sources + [composition_source]
    # Filhos e revisão da definição: só kro, e só com grafo lido. Filho sem hash é "desconhecido".
    children: list[dict[str, Any]] | None = None
    revision: dict[str, Any] | None = None
    if composition is not None:
        revisions_by_rgd, revisions_source = _graph_revisions()
        sources = sources + [revisions_source]
        summary = _revision_summary({"status": {}}, revisions_by_rgd.get(selected["capability"], []), revisions_source["error"])
        latest = summary["latest"]
        uid = str((item.get("metadata", {}) or {}).get("uid") or "")
        children = _children_for(composition, f"{INSTANCE_ID_LABEL}={uid}", namespace,
                                 latest["hash"] if latest else None, sources) if uid else []
        for child in children:
            child.pop("_instanceId", None)
        revision = {**_rollout(children, latest), "latest": latest, "pending": summary["pending"], "error": summary["error"]}
    partial, _ = _degraded(sources)
    return 200, {
        "capability": selected["capability"],
        "engine": selected["engine"],
        "owner": _owner_of(item),
        "scorecard": scorecard,
        "composition": composition,
        "children": children,
        "revision": revision,
        # Só instância kro (engine do catálogo): é o insumo da promoção entre ambientes. ACK fica fora.
        "spec": _safe_spec(item.get("spec")) if selected["engine"] == "kro" and isinstance(item.get("spec"), dict) else None,
        "kind": str(item.get("kind") or selected["kind"]),
        "apiVersion": str(item.get("apiVersion") or selected["apiVersion"]),
        "metadata": _safe_metadata(item.get("metadata", {}) or {}),
        "ready": ready["ready"],
        "readyBasis": ready["readyBasis"],
        "readyCondition": ready["readyCondition"],
        "readyReason": ready["readyReason"],
        "generation": ready["generation"],
        "observedGeneration": ready["observedGeneration"],
        "statusStale": ready["statusStale"],
        "state": _safe_text(status.get("state"), 60) if isinstance(status.get("state"), str) else ready["readyBasis"],
        "conditions": conditions,
        "outputs": _safe_outputs(status),
        "freshness": _freshness(item, ready, conditions, trail["argo"]["readable"], now),
        "trail": trail,
        # Apenas a LEITURA do gate. A imposição continua nos handlers POST
        # governados: nenhuma autorização vive só no botão (issue #9).
        "actions": {"day2Enforcement": "POST /cluster/{scale,restart,delete-pod}",
                    "callerIsAdmin": is_admin,
                    "writePathForThisObject": "git-merge-request"},
        "partial": partial,
        "sources": sources,
        "readAt": now,
    }


# ---------------------------------------------------------------------------
# Grafo da composição kro, nativo no portal.
#
# O kro-ui mostra a RGD como grafo; aqui o portal lê a MESMA ResourceGraphDefinition
# e deriva o grafo do próprio spec, sem depender do status do controller:
#
# - um nó por `spec.resources[].id`;
# - uma aresta `from -> to` quando o template, `readyWhen` ou `includeWhen` de `to`
#   referencia `${from...}` e `from` é outro recurso da RGD. `schema` é a
#   instância (o que o usuário pediu), não um nó: vira a contagem `usesSchema`;
# - camadas por ordenação topológica (Kahn) com desempate alfabético, para o
#   mesmo spec produzir SEMPRE o mesmo desenho. Nó que sobra está num ciclo e
#   é listado em `cycle`, em vez de sumir.
#
# `status.topologicalOrder`, quando o controller publicou, entra como
# `controllerOrder` para o leitor comparar; não é usado para desenhar.
# ---------------------------------------------------------------------------

_CEL_REFERENCE = re.compile(r"\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\b")


def _strings_in(value: Any):
    """Toda string folha de uma estrutura YAML/JSON, em ordem determinística."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key in sorted(value):
            yield from _strings_in(value[key])
    elif isinstance(value, list):
        for entry in value:
            yield from _strings_in(entry)


def _references(value: Any) -> set[str]:
    return {match for text in _strings_in(value) for match in _CEL_REFERENCE.findall(text)}


def _layer(depends_on: dict[str, set[str]]) -> tuple[list[list[str]], list[str]]:
    """Kahn por camadas: camada N contém todo nó cujas dependências estão em camadas < N. O que
    sobra é ciclo, REPORTADO (nunca descartado). Compartilhado pelo grafo da RGD e pelo grafo entre
    instâncias (cross-instance-graph): o mesmo desenho determinístico nos dois."""
    placed: set[str] = set()
    layers: list[list[str]] = []
    pending = {node_id: set(deps) for node_id, deps in depends_on.items()}
    while pending:
        ready_now = sorted(node_id for node_id, deps in pending.items() if deps <= placed)
        if not ready_now:
            break
        layers.append(ready_now)
        placed.update(ready_now)
        for node_id in ready_now:
            del pending[node_id]
    return layers, sorted(pending)


def _rgd_graph(rgd: dict[str, Any]) -> dict[str, Any]:
    """Grafo determinístico de uma ResourceGraphDefinition (ver cabeçalho da seção)."""
    spec = rgd.get("spec", {}) or {}
    resources = [r for r in (spec.get("resources", []) or []) if isinstance(r, dict) and r.get("id")]
    ids = [str(r["id"]) for r in resources]
    known = set(ids)
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, str]] = []
    for resource in resources:
        node_id = str(resource["id"])
        template = resource.get("template") if isinstance(resource.get("template"), dict) else {}
        external = resource.get("externalRef") if isinstance(resource.get("externalRef"), dict) else None
        refs = _references(template) | _references(resource.get("readyWhen")) | _references(resource.get("includeWhen"))
        if external:
            refs |= _references(external)
        depends_on = sorted(ref for ref in refs if ref in known and ref != node_id)
        edges.extend({"from": dep, "to": node_id} for dep in depends_on)
        source = external or template
        nodes.append({
            "id": node_id,
            "kind": _safe_text((source or {}).get("kind"), 80),
            "apiVersion": _safe_text((source or {}).get("apiVersion"), 120),
            "external": external is not None,
            "dependsOn": depends_on,
            "usesSchema": "schema" in refs,
            "readyWhen": len(resource.get("readyWhen") or []) if isinstance(resource.get("readyWhen"), list) else 0,
            "includeWhen": len(resource.get("includeWhen") or []) if isinstance(resource.get("includeWhen"), list) else 0,
        })

    layers, cycle = _layer({node["id"]: set(node["dependsOn"]) for node in nodes})

    schema = spec.get("schema", {}) or {}
    outputs = [{"name": str(key), "from": sorted(ref for ref in _references(value) if ref in known)}
               for key, value in sorted(((schema.get("status") or {}) if isinstance(schema.get("status"), dict) else {}).items())]
    controller_order = (rgd.get("status", {}) or {}).get("topologicalOrder")
    return {
        "name": _safe_text((rgd.get("metadata", {}) or {}).get("name"), 253),
        "kind": _safe_text(schema.get("kind"), 80),
        "state": _safe_text((rgd.get("status", {}) or {}).get("state"), 60) or "Unknown",
        "nodes": nodes,
        "edges": edges,
        "layers": layers,
        "cycle": cycle,
        "outputs": outputs,
        "controllerOrder": [str(x) for x in controller_order] if isinstance(controller_order, list) else [],
    }


def _composition_for(capability: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """(grafo, fonte) da RGD de uma capability kro; (None, None) para outros engines."""
    if capability.get("engine") != "kro":
        return None, None
    source = f"kro.run/resourcegraphdefinitions/{capability['capability']}"
    try:
        rgd = _k8s("GET", f"{KRO_API}/resourcegraphdefinitions/{urllib.parse.quote(str(capability['capability']), safe='')}")
    except urllib.error.HTTPError as error:
        return None, {"source": source, "ok": False, "error": f"http_{error.code}"}
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError):
        return None, {"source": source, "ok": False, "error": "unreadable"}
    return _rgd_graph(rgd), {"source": source, "ok": True, "error": ""}


def _rgd_graph_view(params: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /cluster/rgd-graph?name=: grafo de UMA RGD. Cluster-scoped, sem dado de projeto."""
    name = str(params.get("name") or "").strip()
    if not OBJECT_NAME_PATTERN.fullmatch(name):
        raise ValueError("invalid resource graph definition name")
    graph, source = _composition_for({"engine": "kro", "capability": name})
    if graph is None:
        assert source is not None
        if source["error"] == "http_404":
            return 404, {"error": "resource graph definition not found", "sources": [source]}
        return 502, {"error": "the resource graph definition could not be read", "sources": [source], "partial": True}
    return 200, {**graph, "sources": [source], "partial": False, "readAt": int(time.time())}


# ---------------------------------------------------------------------------
# Página de Composições (backlog kro-native-compositions, fatia 2).
#
# `spec.schema.spec` de uma RGD é simpleschema do kro: cada folha é uma string
# `tipo | marcador=valor marcador=valor` (`string | required=true default="x"`),
# e cada dict é um objeto aninhado. O parser abaixo achata para
# `caminho.ponto` e separa tipo, required, default e description. Marcador que
# não conhece volta em `markers`, nunca é descartado: a doc gerada tem que
# mostrar o que o autor escreveu, não o que o portal entendeu.
# ---------------------------------------------------------------------------

_SCHEMA_MARKER = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|\S+)')
_SCHEMA_FIELD_LIMIT = 200


def _schema_fields(spec: Any, prefix: str = "", depth: int = 0) -> list[dict[str, Any]]:
    """Campos de um simpleschema, achatados e em ordem alfabética por nível."""
    if not isinstance(spec, dict) or depth > 8:
        return []
    fields: list[dict[str, Any]] = []
    for key in sorted(spec):
        path = f"{prefix}.{key}" if prefix else str(key)
        value = spec[key]
        if isinstance(value, dict):
            fields.append({"path": _safe_text(path, 200), "type": "object", "required": False,
                           "default": None, "description": "", "markers": {}})
            fields.extend(_schema_fields(value, path, depth + 1))
            continue
        text = str(value) if value is not None else ""
        kind, _, tail = text.partition("|")
        markers = {name: raw.strip("\"'") for name, raw in _SCHEMA_MARKER.findall(tail)}
        fields.append({
            "path": _safe_text(path, 200),
            "type": _safe_text(kind.strip() or "string", 80),
            "required": str(markers.pop("required", "false")).lower() == "true",
            "default": _safe_text(markers.pop("default"), 200) if "default" in markers else None,
            "description": _safe_text(markers.pop("description", ""), 400),
            "markers": {str(k): _safe_text(v, 120) for k, v in sorted(markers.items())},
        })
        if len(fields) >= _SCHEMA_FIELD_LIMIT:
            break
    return fields[:_SCHEMA_FIELD_LIMIT]


# ---------------------------------------------------------------------------
# Revisões de composição (backlog composition-revisions). Medido no cluster em
# 26/10/2026, kro v0.9.4:
#
# - Toda mudança de spec da RGD vira um GraphRevision (internal.kro.run/v1alpha1,
#   cluster-scoped, nome `<rgd>-r0000N`), com `spec.revision`, `spec.snapshot.generation`
#   e a label `kro.run/graph-revision-hash`. A RGD guarda `status.lastIssuedRevision`.
# - A instância NÃO fixa revisão: o controller reconcilia sempre contra a revisão
#   ATIVA mais recente. Logo "instância atrás da definição" não é um campo da
#   instância; a única evidência possível é o FILHO levar `kro.run/graph-revision-hash`.
#   Medido no fonte da v0.9.4 (pkg/metadata/labels.go define a label; só
#   controller_reconcile.go da RGD a aplica, no próprio GraphRevision): esta versão
#   NÃO carimba o hash nos filhos, então todo rollout sai "unknown" por construção.
#   O código compara quando o hash existir (versão futura do kro); filho sem a
#   label é "desconhecido", nunca "atrás".
# - Filhos se encontram pela label `kro.run/instance-id=<uid da instância>`, e por
#   kind da RGD (`kro.run/instance-kind`) para a visão por definição.
# - O "MR de upgrade" do backlog não se aplica a este kro: o upgrade É o merge da
#   RGD, e o rollout para as instâncias é automático. O que o portal mostra é o
#   rollout: quais instâncias já têm filhos na revisão atual.
# ---------------------------------------------------------------------------

KRO_INTERNAL_API = "/apis/internal.kro.run/v1alpha1"
GRAPH_REVISION_HASH_LABEL = "kro.run/graph-revision-hash"
INSTANCE_ID_LABEL = "kro.run/instance-id"
INSTANCE_KIND_LABEL = "kro.run/instance-kind"
INSTANCE_NAME_LABEL = "kro.run/instance-name"
NODE_ID_LABEL = "kro.run/node-id"
ACK_DELETION_POLICY_ANNOTATION = "services.k8s.aws/deletion-policy"


def _graph_revisions() -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    """GraphRevisions agrupadas por RGD, mais recente primeiro. (por_rgd, fonte)."""
    rows, truncated, error = _list_source(f"{KRO_INTERNAL_API}/graphrevisions")
    # 404 é kro sem o CRD GraphRevision (< 0.9): resposta definitiva, não falha (mesma regra da
    # discovery ACK). 403, timeout e corpo ilegível seguem erro.
    absent = error == "http_404"
    source: dict[str, Any] = {"source": "internal.kro.run/graphrevisions", "ok": absent or not error, "error": "" if absent else error}
    if absent:
        source["absent"] = True
    if truncated:
        source["truncated"] = True
    by_rgd: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        spec = row.get("spec", {}) or {}
        snapshot = spec.get("snapshot", {}) or {}
        metadata = row.get("metadata", {}) or {}
        name = str(snapshot.get("name") or "")
        if not OBJECT_NAME_PATTERN.fullmatch(name):
            continue
        conditions = [c for c in ((row.get("status", {}) or {}).get("conditions") or []) if isinstance(c, dict)]
        ready = any(str(c.get("type")) == "Ready" and str(c.get("status")) == "True" for c in conditions)
        by_rgd.setdefault(name, []).append({
            "revision": _int_or_none(spec.get("revision")),
            "generation": _int_or_none(snapshot.get("generation")),
            "ready": ready,
            "hash": _safe_text((metadata.get("labels") or {}).get(GRAPH_REVISION_HASH_LABEL), 80) or None,
            "created": _safe_text(metadata.get("creationTimestamp"), 40) or None,
            "resources": len((row.get("status", {}) or {}).get("resources") or []),
        })
    for entries in by_rgd.values():
        entries.sort(key=lambda entry: -(entry["revision"] or 0))
    return by_rgd, source


def _revision_summary(rgd: dict[str, Any], revisions: list[dict[str, Any]], error: str) -> dict[str, Any]:
    """Resumo por RGD: lista, a ativa mais recente, a emitida mais recente, e o que a RGD declara."""
    latest = next((entry for entry in revisions if entry["ready"]), None)
    issued = revisions[0] if revisions else None
    return {
        "items": revisions,
        "latest": latest,
        "pending": issued if issued and (latest is None or issued["revision"] != latest["revision"]) else None,
        "lastIssued": _int_or_none((rgd.get("status", {}) or {}).get("lastIssuedRevision")),
        "error": error,
    }


_PLURALS: dict[str, dict[str, str]] = {}


def _plural_for(api_version: str, kind: str) -> tuple[str, str]:
    """(plural, erro) de um kind por discovery do grupo/versão, com cache por invocação.

    plural vazio e erro vazio = grupo ou kind ausente (resposta definitiva). Erro preenchido =
    discovery falhou (403, timeout, corpo ilegível) e NÃO é cacheado.
    """
    if api_version not in _PLURALS:
        table: dict[str, str] = {}
        try:
            for resource in _k8s("GET", f"/apis/{urllib.parse.quote(api_version, safe='/')}").get("resources", []) or []:
                plural = str(resource.get("name") or "")
                if "/" in plural or "list" not in (resource.get("verbs") or []):
                    continue
                table[str(resource.get("kind") or "")] = plural
        except urllib.error.HTTPError as error:
            if error.code != 404:
                return "", f"http_{error.code}"
        except (urllib.error.URLError, TimeoutError):
            return "", "unreachable"
        except (OSError, ValueError, KeyError, TypeError):
            return "", "unreadable"
        _PLURALS[api_version] = table
    return _PLURALS[api_version].get(kind, ""), ""


def _child_row(child: dict[str, Any], latest_hash: str | None) -> dict[str, Any]:
    metadata = child.get("metadata", {}) or {}
    labels = metadata.get("labels") or {}
    annotations = metadata.get("annotations") or {}
    spec = child.get("spec", {}) or {}
    ready = _ready_state(child)
    child_hash = _safe_text(labels.get(GRAPH_REVISION_HASH_LABEL), 80) or None
    policy = annotations.get(ACK_DELETION_POLICY_ANNOTATION) or spec.get("deletionPolicy")
    return {
        "node": _safe_text(labels.get(NODE_ID_LABEL), 63) or None,
        "kind": str(child.get("kind") or ""),
        "apiVersion": str(child.get("apiVersion") or ""),
        "name": str(metadata.get("name") or ""),
        "namespace": str(metadata.get("namespace") or ""),
        "ready": ready["ready"],
        "readyBasis": ready["readyBasis"],
        "deletionPolicy": _safe_text(policy, 20) if isinstance(policy, str) else None,
        "revisionHash": child_hash,
        # None = sem label (desconhecido); True/False = comparado com a revisão ativa.
        "onLatest": None if child_hash is None or latest_hash is None else child_hash == latest_hash,
        "created": _safe_text(metadata.get("creationTimestamp"), 40) or None,
        # Só para agrupar por instância na visão por RGD; removido antes da resposta.
        "_instanceId": str(labels.get(INSTANCE_ID_LABEL) or ""),
    }


def _children_for(graph: dict[str, Any], selector: str, namespace: str, latest_hash: str | None,
                  sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Filhos (um list por kind do grafo, com labelSelector). Falha de kind vira fonte, não vazio."""
    seen: set[tuple[str, str]] = set()
    children: list[dict[str, Any]] = []
    for node in graph.get("nodes", []) or []:
        if node.get("external"):
            continue
        api_version, kind = str(node.get("apiVersion") or ""), str(node.get("kind") or "")
        if not api_version or not kind or (api_version, kind) in seen:
            continue
        seen.add((api_version, kind))
        plural, discovery_error = _plural_for(api_version, kind)
        label = f"children:{api_version}/{kind}"
        if discovery_error:
            sources.append({"source": label, "ok": False, "error": discovery_error})
            continue
        if not plural:
            # Grupo/kind que a discovery não conhece: controller não instalado, resposta definitiva.
            sources.append({"source": label, "ok": True, "error": "", "absent": True})
            continue
        path = _ns_path(f"/apis/{api_version}", namespace, f"/{plural}") + f"?labelSelector={urllib.parse.quote(selector, safe='=,')}"
        rows, truncated, error = _list_source(path)
        source: dict[str, Any] = {"source": label, "ok": not error, "error": error}
        if truncated:
            source["truncated"] = True
        sources.append(source)
        children.extend(_child_row(child, latest_hash) for child in rows)
    children.sort(key=lambda row: (row["node"] or "", row["kind"], row["name"]))
    return children


def _rollout(children: list[dict[str, Any]], latest: dict[str, Any] | None) -> dict[str, Any]:
    """Quantos filhos estão na revisão ativa. `status`: current | behind | unknown | no-children."""
    total = len(children)
    with_hash = sum(1 for child in children if child["revisionHash"] is not None)
    on_latest = sum(1 for child in children if child["onLatest"] is True)
    if total == 0:
        status = "no-children"
    elif latest is None or with_hash == 0:
        status = "unknown"
    elif on_latest == with_hash and with_hash == total:
        status = "current"
    elif on_latest < with_hash:
        status = "behind"
    else:
        status = "unknown"
    return {"status": status, "children": total, "withHash": with_hash, "onLatest": on_latest,
            "latestRevision": latest["revision"] if latest else None}


def _rgds_view(params: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /cluster/rgds?ns=: toda ResourceGraphDefinition com grafo, schema e saúde das instâncias.

    Uma linha por RGD, independente de a discovery ter o plural: definição sem plural
    aparece com `listable: false` e `instances: null`, nunca some. A contagem de
    instâncias segue a invariante I-A: erro de fonte é `error` nomeado, não zero.
    """
    namespace = _namespace_scope(params.get("ns"))
    capabilities, sources = _kro_capabilities()
    rgds, _, rgd_error = _list_source(f"{KRO_API}/resourcegraphdefinitions")
    if rgd_error:
        return 502, {"error": "the resource graph definitions could not be read", "sources": sources, "partial": True}
    by_name = {capability["capability"]: capability for capability in capabilities}
    revisions_by_rgd, revisions_source = _graph_revisions()
    sources.append(revisions_source)
    now = int(time.time())
    items: list[dict[str, Any]] = []
    truncated = False
    for rgd in sorted(rgds, key=lambda row: str((row.get("metadata", {}) or {}).get("name") or "")):
        metadata = rgd.get("metadata", {}) or {}
        name = str(metadata.get("name") or "")
        if not OBJECT_NAME_PATTERN.fullmatch(name):
            continue
        graph = _rgd_graph(rgd)
        schema = ((rgd.get("spec", {}) or {}).get("schema", {}) or {})
        capability = by_name.get(name, {})
        revisions = _revision_summary(rgd, revisions_by_rgd.get(name, []), revisions_source["error"])
        latest = revisions["latest"]
        instances: dict[str, Any] | None = None
        rollout: list[dict[str, Any]] = []
        if capability.get("listable"):
            path = _ns_path(capability["basePath"].rsplit("/", 1)[0], namespace, "/" + capability["plural"])
            objects, source_truncated, error = _list_source(path)
            source = {"source": f"{name}:instances", "ok": not error, "error": error}
            if source_truncated:
                source["truncated"] = True
            sources.append(source)
            truncated = truncated or source_truncated
            ready = sum(1 for item in objects if _ready_state(item)["ready"])
            instances = {"total": None if error else len(objects), "ready": None if error else ready,
                         "notReady": None if error else len(objects) - ready,
                         "truncated": bool(source_truncated), "error": error}
            if not error and objects:
                # Rollout da revisão: um list por kind do grafo, filtrado pelo kind da instância,
                # agrupado pela instância dona. Filho sem hash é "desconhecido", nunca "atrás".
                children = _children_for(graph, f"{INSTANCE_KIND_LABEL}={graph['kind']}", namespace,
                                         latest["hash"] if latest else None, sources)
                for item in objects:
                    item_meta = item.get("metadata", {}) or {}
                    uid = str(item_meta.get("uid") or "")
                    own = [child for child in children if child.get("_instanceId") == uid]
                    rollout.append({"name": str(item_meta.get("name") or ""), "namespace": str(item_meta.get("namespace") or ""),
                                    "rollout": _rollout(own, latest)})
                for child in children:
                    child.pop("_instanceId", None)
        items.append({
            "name": graph["name"], "kind": graph["kind"],
            "apiVersion": f"kro.run/{_safe_text(schema.get('apiVersion'), 40) or 'v1alpha1'}",
            "state": graph["state"],
            "created": _safe_text(metadata.get("creationTimestamp"), 40) or None,
            "generation": _int_or_none(metadata.get("generation")),
            "observedGeneration": _int_or_none((rgd.get("status", {}) or {}).get("observedGeneration")),
            "conditions": _condition_rows(rgd.get("status", {}) or {}, now),
            "plural": str(capability.get("plural") or ""),
            "listable": bool(capability.get("listable")),
            "graph": graph,
            "schema": {"spec": _schema_fields(schema.get("spec")),
                       "status": sorted(str(key) for key in (schema.get("status") or {}) if isinstance(schema.get("status"), dict))},
            "instances": instances,
            "revisions": revisions,
            "rollout": rollout,
            "source": f"platform/compositions/{name}-rgd.yaml",
        })
    partial, total_failure = _degraded(sources)
    if total_failure:
        return 502, {"error": "cluster discovery unavailable", "sources": sources, "partial": True}
    return 200, {"items": items, "total": len(items), "namespace": namespace,
                 "partial": partial or truncated, "truncated": truncated, "sources": sources, "readAt": now}


# ---------------------------------------------------------------------------
# Scorecards (backlog scorecards-standards).
#
# As regras vivem em Git (platform/scorecards/standards.json) e viajam no bundle,
# como o tool_catalog.json. O servidor implementa um VOCABULÁRIO fixo de checks e
# avalia cada regra a partir do objeto VIVO, sem leitura extra: Ready, owner,
# rastreio do Argo (já lido para o inventário), generation, campo do spec, label,
# annotation e proveniência. Nível é cumulativo: ouro exige prata e bronze inteiros.
#
# Fail-closed: arquivo inválido (check desconhecido, nível fora da lista, id
# duplicado) desliga os scorecards com erro NOMEADO; nunca vira "tudo passou".
# ---------------------------------------------------------------------------

SCORECARD_LEVELS = ("bronze", "silver", "gold")
_SCORECARD_CHECKS = frozenset({"ready", "owner", "gitops-tracked", "status-current",
                               "spec-field", "label", "annotation", "provenance"})
_RULE_ID_PATTERN = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
_META_KEY_PATTERN = re.compile(r"([a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?/)?[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?")
_SPEC_PATH_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,62}(\.[A-Za-z_][A-Za-z0-9_]{0,62}){0,5}")
_PROVENANCE_ANNOTATIONS = ("platform.appmod/request-id", "platform.appmod/mr-url")
_PROVENANCE_LABELS = ("platform.appmod/plan-id", "platform.appmod/requester")


def _validate_standards(document: Any) -> str:
    """Vazio quando válido; senão o motivo, que vai para o log e para a resposta."""
    if not isinstance(document, dict):
        return "standards must be an object"
    if document.get("version") != 1:
        return "unsupported standards version"
    if list(document.get("levels") or []) != list(SCORECARD_LEVELS):
        return f"levels must be exactly {list(SCORECARD_LEVELS)}"
    rules = document.get("rules")
    if not isinstance(rules, list) or not rules:
        return "rules must be a non-empty list"
    seen: set[str] = set()
    for index, rule in enumerate(rules):
        where = f"rules[{index}]"
        if not isinstance(rule, dict):
            return f"{where} must be an object"
        rule_id = rule.get("id")
        if not isinstance(rule_id, str) or not _RULE_ID_PATTERN.fullmatch(rule_id):
            return f"{where}.id is not a valid rule id"
        if rule_id in seen:
            return f"duplicate rule id {rule_id}"
        seen.add(rule_id)
        if rule.get("level") not in SCORECARD_LEVELS:
            return f"{rule_id}: level must be one of {list(SCORECARD_LEVELS)}"
        check = rule.get("check")
        if not isinstance(check, str) or check not in _SCORECARD_CHECKS:
            return f"{rule_id}: unknown check {check!r}"
        if check == "spec-field" and not (isinstance(rule.get("path"), str) and _SPEC_PATH_PATTERN.fullmatch(rule["path"])):
            return f"{rule_id}: spec-field needs a dotted `path`"
        if check in ("label", "annotation") and not (isinstance(rule.get("key"), str) and _META_KEY_PATTERN.fullmatch(rule["key"])):
            return f"{rule_id}: {check} needs a valid `key`"
        engines = rule.get("engines")
        if engines is not None and (not isinstance(engines, list) or not engines
                                    or any(engine not in ("kro", "ack") for engine in engines)):
            return f"{rule_id}: engines must be a non-empty subset of [kro, ack]"
        for field in ("title", "titlePt", "description", "descriptionPt"):
            if not isinstance(rule.get(field), str) or not rule[field].strip():
                return f"{rule_id}: {field} is required"
    for level in SCORECARD_LEVELS:
        # Nível sem regra seria concedido de graça (all() de lista vazia). Toda engine precisa de
        # ao menos uma regra em cada nível: ou uma sem filtro, ou uma por engine.
        for engine in ("kro", "ack"):
            if not any(rule["level"] == level and (not rule.get("engines") or engine in rule["engines"]) for rule in rules):
                return f"level {level} has no rule that applies to engine {engine}"
    return ""


def _load_standards() -> tuple[dict[str, Any] | None, str]:
    here = os.path.dirname(os.path.abspath(__file__))
    # Bundle (build.sh copia para a raiz), override por env, e o arquivo em Git para rodar do checkout.
    candidates = [os.path.join(here, "standards.json"),
                  os.environ.get("SCORECARD_STANDARDS_PATH", ""),
                  os.path.join(here, "..", "..", "platform", "scorecards", "standards.json")]
    for candidate in candidates:
        if not candidate or not os.path.exists(candidate):
            continue
        try:
            with open(candidate, encoding="utf-8") as handle:
                document = json.load(handle)
            problem = _validate_standards(document)
        except (OSError, ValueError, TypeError, AttributeError) as error:
            # Também o validador fica dentro do try: um arquivo mal formado desliga os scorecards,
            # nunca derruba o import da Lambda e com ele todas as outras rotas.
            print(json.dumps({"event": "standards_unreadable", "path": candidate[:200], "error": str(error)[:200]}))
            return None, f"standards unreadable: {type(error).__name__}"
        if problem:
            print(json.dumps({"event": "standards_invalid", "path": candidate[:200], "error": problem}))
            return None, f"standards invalid: {problem}"
        return document, ""
    return None, "standards file missing from the bundle"


STANDARDS, STANDARDS_ERROR = _load_standards()


def _argo_resource_key(kind: str, namespace: str, name: str) -> str:
    """Chave do plano B: Kind/namespace/name. Sem o namespace, `site` em team-b herdaria o rastreio
    do `site` de appmod (achado do fariseu-qa, 25/10/2026)."""
    return f"{kind}/{namespace}/{name}"


def _gitops_tracked(item: dict[str, Any], argo_names: set[str], argo_readable: bool) -> bool | None:
    """True/False quando dá para afirmar; None quando o Argo não foi lido e o objeto não traz marca.

    A marca só vale quando aponta para uma Application DA PLATAFORMA (`<app>:` no tracking-id ou
    o label de instância igual ao nome): `app.kubernetes.io/instance` é label padrão do Helm, e
    aceitar qualquer valor deixava manifest escrito à mão passar como GitOps. É a mesma regra do
    `_argo_tracked` do detalhe, para listagem e detalhe darem o mesmo nível ao mesmo objeto. O
    plano B, a lista de recursos da Application das instâncias, só serve quando ela foi lida.
    """
    metadata = item.get("metadata", {}) or {}
    labels = metadata.get("labels", {}) or {}
    annotations = metadata.get("annotations", {}) or {}
    tracking = annotations.get(_ARGO_TRACKING_ANNOTATION)
    known = _known_argo_applications()
    marked = (isinstance(tracking, str) and tracking.split(":", 1)[0] in known) \
        or labels.get(_ARGO_INSTANCE_LABEL) in known
    if marked:
        return True
    if not argo_readable:
        return None
    return _argo_resource_key(str(item.get("kind") or ""), str(metadata.get("namespace") or ""),
                              str(metadata.get("name") or "")) in argo_names


def _known_argo_applications() -> frozenset[str]:
    """Applications que a plataforma gerencia: instâncias (`platform/instances`) e agents do Builder."""
    return frozenset(name for name in (INSTANCES_ARGO_APPLICATION, ARGO_APPLICATION) if name)


def _spec_field(item: dict[str, Any], path: str) -> Any:
    node: Any = item.get("spec")
    for part in path.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    return node


def _evaluate_rule(rule: dict[str, Any], item: dict[str, Any], ready: dict[str, Any],
                   tracked: bool | None) -> tuple[bool, str]:
    """(passou, evidência). A evidência é texto curto e seguro para a UI, nunca o valor cru."""
    metadata = item.get("metadata", {}) or {}
    labels = metadata.get("labels", {}) or {}
    annotations = metadata.get("annotations", {}) or {}
    check = rule["check"]
    if check == "ready":
        return bool(ready["ready"]), f"{ready['readyCondition'] or ready['readyBasis']}={'True' if ready['ready'] else 'False'}"
    if check == "owner":
        owner = _owner_of(item)
        return bool(owner), (f"owner={owner}" if owner else "no owner label or spec.owner")
    if check == "gitops-tracked":
        if tracked is None:
            return False, "not verifiable: Argo CD unreadable and no tracking mark on the object"
        return tracked, ("tracked by Argo CD" if tracked else "not tracked by Argo CD")
    if check == "status-current":
        if ready["observedGeneration"] is None:
            return False, "status.observedGeneration missing"
        return (not ready["statusStale"]), f"generation={ready['generation']} observed={ready['observedGeneration']}"
    if check == "spec-field":
        value = _spec_field(item, rule["path"])
        present = value not in (None, "", [], {})
        return present, (f"spec.{rule['path']} set" if present else f"spec.{rule['path']} missing")
    if check == "label":
        present = bool(labels.get(rule["key"]))
        return present, (f"label {rule['key']} set" if present else f"label {rule['key']} missing")
    if check == "annotation":
        present = bool(annotations.get(rule["key"]))
        return present, (f"annotation {rule['key']} set" if present else f"annotation {rule['key']} missing")
    if check == "provenance":
        found = [key for key in _PROVENANCE_ANNOTATIONS if annotations.get(key)] \
            + [key for key in _PROVENANCE_LABELS if labels.get(key)]
        return bool(found), (", ".join(found) if found else "no request-id, mr-url, plan-id or requester")
    return False, f"unknown check {check}"  # inalcançável: o loader recusa o arquivo


def _scorecard(item: dict[str, Any], capability: dict[str, Any], tracked: bool | None,
               argo_readable: bool) -> dict[str, Any] | None:
    """Scorecard de UMA instância. None quando as regras não puderam ser carregadas."""
    if STANDARDS is None:
        return None
    ready = _ready_state(item)
    engine = capability["engine"]
    rows: list[dict[str, Any]] = []
    for rule in STANDARDS["rules"]:
        if rule.get("engines") and engine not in rule["engines"]:
            continue
        passed, evidence = _evaluate_rule(rule, item, ready, tracked)
        rows.append({"id": rule["id"], "level": rule["level"], "passed": passed, "evidence": _safe_text(evidence, 160),
                     # Título bilíngue junto da regra: o detalhe da instância não carrega o arquivo de
                     # padrões, e mostrar o id cru ("environment-declared") no lugar do nome é defeito
                     # medido live em 25/10/2026.
                     "title": rule["title"], "titlePt": rule["titlePt"]})
    level = "none"
    for candidate in SCORECARD_LEVELS:
        at_level = [row for row in rows if row["level"] == candidate]
        # Sem regra aplicável no nível não há o que ter passado: o nível não é concedido.
        if at_level and all(row["passed"] for row in at_level):
            level = candidate
        else:
            break
    return {"level": level, "passed": sum(1 for row in rows if row["passed"]), "total": len(rows),
            "rules": rows, "argoReadable": argo_readable}


def _scorecard_summary(card: dict[str, Any] | None) -> dict[str, Any] | None:
    """Forma compacta para a listagem: nível e contagem, sem a lista de regras."""
    if card is None:
        return None
    return {"level": card["level"], "passed": card["passed"], "total": card["total"]}


def _standards_public() -> dict[str, Any]:
    """As regras como a UI as mostra: texto bilíngue, nível, check e a que engines se aplica."""
    assert STANDARDS is not None
    return {"version": STANDARDS["version"], "levels": list(SCORECARD_LEVELS),
            "rules": [{"id": rule["id"], "level": rule["level"], "check": rule["check"],
                       "engines": rule.get("engines"), "title": rule["title"], "titlePt": rule["titlePt"],
                       "description": rule["description"], "descriptionPt": rule["descriptionPt"]}
                      for rule in STANDARDS["rules"]]}


def _scorecards_view(params: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /cluster/scorecards?ns=: toda instância do escopo pontuada contra os padrões, com agregado.

    Mesmas fontes e mesmo loop do inventário (`_live_instance_rows`), então falha de fonte aparece
    aqui com o mesmo nome e `partial`. ACK entra só com `engine=ack`, como no inventário.
    """
    if STANDARDS is None:
        return 503, {"error": STANDARDS_ERROR}
    namespace = _namespace_scope(params.get("ns"))
    include_ack = str(params.get("engine") or "").lower() == "ack"
    capabilities, sources = _capability_index(include_ack=include_ack)
    selected = [row for row in capabilities if row["listable"]]
    now = int(time.time())
    rows, sources, truncated_sources, argo_readable = _live_instance_rows(namespace, selected, sources, now, full_scorecard=True)
    partial, total_failure = _degraded(sources)
    if total_failure:
        return 502, {"error": "no live source could be read", "sources": sources, "partial": True}

    by_level = {level: 0 for level in ("none", *SCORECARD_LEVELS)}
    rule_counts = {rule["id"]: {"applicable": 0, "passed": 0} for rule in STANDARDS["rules"]}
    items: list[dict[str, Any]] = []
    for row in rows:
        card = row["scorecard"]
        by_level[card["level"]] += 1
        for rule_row in card["rules"]:
            rule_counts[rule_row["id"]]["applicable"] += 1
            rule_counts[rule_row["id"]]["passed"] += int(rule_row["passed"])
        items.append({"name": row["name"], "namespace": row["namespace"], "kind": row["kind"],
                      "capability": row["capability"], "engine": row["engine"], "owner": row["owner"],
                      "ready": row["ready"], "scorecard": card})
    rank = {level: index for index, level in enumerate(("none", *SCORECARD_LEVELS))}
    items.sort(key=lambda entry: (rank[entry["scorecard"]["level"]], entry["namespace"], entry["name"]))
    return 200, {
        "namespace": namespace,
        "standards": _standards_public(),
        "summary": {"total": len(items), "byLevel": by_level},
        "rules": [{"id": rule_id, **counts} for rule_id, counts in rule_counts.items()],
        "items": items,
        "argoReadable": argo_readable,
        "partial": partial or bool(truncated_sources),
        "truncatedSources": truncated_sources,
        "sources": sources,
        "readAt": now,
    }
# Contrato: docs/agent-platform/design-agent-builder.md, seções 5.6 a 5.9.
#
# Esta Lambda NUNCA recebe verbo de escrita sobre agents.kagent.dev. É a
# invariante I5 do design e a pré-condição P4: o único caminho de escrita é o
# Git, pelo MR. Tudo aqui lê o cluster ou repassa uma chamada A2A.
# ---------------------------------------------------------------------------

AGENT_BUILDER_ENABLED = os.environ.get("AGENT_BUILDER_ENABLED", "false").strip().lower() == "true"
# O dryRun=All do API server exige o verbo create em agents.kagent.dev, que o
# cluster-rbac.yaml DELIBERADAMENTE não concede. Por isso o default é false: com
# a flag ligada e sem o RBAC, o resultado volta como "não realizado" em vez de
# virar um "válido" que ninguém conferiu.
AGENT_DRYRUN_APPLY = os.environ.get("AGENT_BUILDER_DRYRUN_APPLY", "false").strip().lower() == "true"
# Plano B da seção 12 do design: se o controller 0.9.9 recusar blocking=false,
# basta ligar esta env para a chamada bloquear dentro do limite de 20 s.
AGENT_A2A_BLOCKING = os.environ.get("AGENT_BUILDER_A2A_BLOCKING", "false").strip().lower() == "true"

AGENT_NAMESPACE = "kagent"
AGENT_API = "/apis/kagent.dev/v1alpha2"
AGENT_APIVERSION = "kagent.dev/v1alpha2"
AGENT_CRD = "agents.kagent.dev"
BUILDER_MANAGED_BY = "agent-builder"
BUILDER_PART_OF = "appmod-agent-platform"
BUILDER_COMPILER = "agent-builder/v1"
BUILDER_TOOL_SERVER = "builder-readonly-tool-server"
BUILDER_MODEL_CONFIG = "default-model-config"
ARGO_APPLICATION = os.environ.get("ARGO_APPLICATION", "agent-platform-agents")
ARGO_NAMESPACE = os.environ.get("ARGO_NAMESPACE", "argocd")
A2A_SERVICE = "kagent-controller:8083"
A2A_TIMEOUT = 20
A2A_METHODS = frozenset({"message/send", "tasks/get"})
MAX_BODY = 32768

AGENT_NAME_PATTERN = re.compile(r"ab-[a-z0-9](?:[a-z0-9-]{0,35}[a-z0-9])?")
FIXTURE_PREFIX = "ab-fx-"
TASK_ID_PATTERN = re.compile(r"[A-Za-z0-9-]{1,64}")
_HEX64_PATTERN = re.compile(r"[0-9a-f]{64}")
_REQUEST_ID_PATTERN = re.compile(r"[0-9a-f]{32}|preview")
# Mesmas formas que o Platform Assistant aceita (service.PLAN_ID_PATTERN e planner.REF_PATTERN).
_PLAN_ID_PATTERN = re.compile(r"[0-9a-f]{32}")
_PLAN_STEP_PATTERN = re.compile(r"[a-z][a-z0-9]{0,15}")


def _plan_provenance(labels: dict[str, Any]) -> dict[str, str] | None:
    """Plano e passo do Assistant que criaram o objeto, ou None.

    Label é texto de terceiro: só sai o par inteiro e na forma do servidor. Metade do par
    (plan-id sem plan-step) não prova nada sobre qual passo gerou o objeto, então também é None.
    """
    plan_id = str(labels.get("platform.appmod/plan-id") or "")
    step = str(labels.get("platform.appmod/plan-step") or "")
    if _PLAN_ID_PATTERN.fullmatch(plan_id) and _PLAN_STEP_PATTERN.fullmatch(step):
        return {"planId": plan_id, "step": step}
    return None
_ARGO_TRACKING_ANNOTATION = "argocd.argoproj.io/tracking-id"
_ARGO_INSTANCE_LABEL = "app.kubernetes.io/instance"

# Pré-condição P2: nenhum nome de tool descoberta pode carregar verbo de escrita.
# Os oito primeiros tokens são os do design; os demais são endurecimento, e
# nenhum deles aparece como substring dos nomes do catálogo.
WRITE_TOOL_TOKENS = ("apply", "delete", "patch", "create", "exec", "scale", "rollout", "label",
                     "annotate", "replace", "update", "evict", "cordon", "drain", "restart")

# O pacote da Lambda é um arquivo único, então o catálogo vem embutido. O
# build.sh empacota platform/agent-builder/tool-catalog.json ao lado do módulo
# quando ele existe, e tests/test_cluster_api_agents.py compara esta tupla com o
# arquivo do contrato: esse teste é o guarda contra deriva.
_CATALOG_FALLBACK: tuple[str, ...] = (
    "k8s_get_resources", "k8s_get_resource_yaml", "k8s_describe_resource",
    "k8s_get_events", "k8s_get_pod_logs",
)

# Campos que o manifest do builder nunca carrega. A allowlist da seção 4 já os
# recusaria como unknown_field; nomeá-los dá um código mais claro no erro.
_FORBIDDEN_KEYS = frozenset({
    "byo", "sandbox", "memory", "context", "executeCodeBlocks", "requireApproval",
    "promptTemplate", "systemMessageFrom", "allowedNamespaces", "env", "envFrom",
    "volumes", "volumeMounts", "serviceAccountName", "imagePullSecrets", "image",
    "nodeSelector", "tolerations", "affinity", "hostNetwork", "hostPID",
    "securityContext", "command", "args", "initContainers", "sidecars",
})

_A2A_PROBE = {
    "pt-BR": "Em uma frase, diga quem você é e quais tools pode usar.",
    "en-US": "In one sentence, say who you are and which tools you can use.",
    "es": "En una frase, di quién eres y qué tools puedes usar.",
}
_LANGUAGE_BY_MARKER = {"Brazilian Portuguese": "pt-BR", "English": "en-US", "Spanish": "es"}


class _A2AError(Exception):
    """Erro que o controller devolveu dentro do próprio envelope JSON-RPC."""


def _load_tool_catalog() -> tuple[str, ...]:
    candidates = [os.path.join(os.path.dirname(os.path.abspath(__file__)), "tool_catalog.json"),
                  os.environ.get("TOOL_CATALOG_PATH", "")]
    for candidate in candidates:
        if not candidate or not os.path.exists(candidate):
            continue
        try:
            with open(candidate, encoding="utf-8") as handle:
                names = tuple(tool["name"] for tool in json.load(handle)["tools"])
            if names:
                return names
        except (OSError, ValueError, KeyError, TypeError):
            print(json.dumps({"event": "tool_catalog_unreadable", "path": candidate[:200]}))
    return _CATALOG_FALLBACK


TOOL_CATALOG = _load_tool_catalog()


def _ptr(*parts: Any) -> str:
    """JSON Pointer com escape, porque chave de label carrega barra."""
    return "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def _issue(path: str, code: str, message: str, message_pt: str) -> dict[str, Any]:
    return {"path": path, "code": code, "message": message, "messagePt": message_pt}


def _check_keys(errors: list[dict[str, Any]], path: str, obj: Any,
                allowed: set[str], required: tuple[str, ...] = ()) -> bool:
    if not isinstance(obj, dict):
        errors.append(_issue(path or "/", "type", "Expected an object.", "Esperava um objeto."))
        return False
    for key in sorted(obj):
        if key in allowed:
            continue
        code = "forbidden_field" if key in _FORBIDDEN_KEYS else "unknown_field"
        errors.append(_issue(path + _ptr(key), code,
                             "Field is not part of the agent-builder manifest shape.",
                             "O campo não faz parte da forma do manifest do agent-builder."))
    for key in required:
        if key not in obj:
            errors.append(_issue(path + _ptr(key), "required",
                                 "Field is required.", "O campo é obrigatório."))
    return True


def _check_const(errors: list[dict[str, Any]], path: str, value: Any, expected: Any) -> None:
    same = value is expected if isinstance(expected, bool) else value == expected
    if not same:
        errors.append(_issue(path, "constant_mismatch",
                             f"Expected the fixed value {expected!r}.",
                             f"Esperava o valor fixo {expected!r}."))


def _check_text(errors: list[dict[str, Any]], path: str, value: Any, low: int, high: int) -> None:
    if not isinstance(value, str):
        errors.append(_issue(path, "type", "Expected a string.", "Esperava uma string."))
        return
    if value != value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value):
        errors.append(_issue(path, "not_single_line", "Expected a single trimmed line.",
                             "Esperava uma linha única e sem espaço nas pontas."))
        return
    if len(value) < low:
        errors.append(_issue(path, "too_short", f"Expected at least {low} characters.",
                             f"Esperava ao menos {low} caracteres."))
    elif len(value) > high:
        errors.append(_issue(path, "too_long", f"Expected at most {high} characters.",
                             f"Esperava no máximo {high} caracteres."))


def _validate_labels(errors: list[dict[str, Any]], labels: Any, name: str) -> None:
    base = "/metadata/labels"
    allowed = {"app.kubernetes.io/managed-by", "app.kubernetes.io/part-of",
               "platform.appmod/requester", "platform.appmod/fixture", "platform.appmod/state"}
    required = ("app.kubernetes.io/managed-by", "app.kubernetes.io/part-of", "platform.appmod/requester")
    if not _check_keys(errors, base, labels, allowed, required):
        return
    _check_const(errors, base + _ptr("app.kubernetes.io/managed-by"),
                 labels.get("app.kubernetes.io/managed-by"), BUILDER_MANAGED_BY)
    _check_const(errors, base + _ptr("app.kubernetes.io/part-of"),
                 labels.get("app.kubernetes.io/part-of"), BUILDER_PART_OF)
    requester = labels.get("platform.appmod/requester")
    if not isinstance(requester, str) or not ALIAS_PATTERN.fullmatch(requester):
        errors.append(_issue(base + _ptr("platform.appmod/requester"), "pattern",
                             "Requester must be a the corporate SSO alias.",
                             "O requester precisa ser um alias the corporate SSO."))
    fixture, is_fixture = labels.get("platform.appmod/fixture"), name.startswith(FIXTURE_PREFIX)
    if fixture is not None and fixture != "true":
        errors.append(_issue(base + _ptr("platform.appmod/fixture"), "enum",
                             'The only accepted value is "true".',
                             'O único valor aceito é "true".'))
    elif is_fixture and fixture != "true":
        errors.append(_issue(base + _ptr("platform.appmod/fixture"), "required",
                             "A fixture name requires the fixture label.",
                             "Nome de fixture exige o label de fixture."))
    elif fixture is not None and not is_fixture:
        errors.append(_issue(base + _ptr("platform.appmod/fixture"), "reserved_name",
                             "The fixture label requires the ab-fx- name prefix.",
                             "O label de fixture exige o prefixo de nome ab-fx-."))
    state = labels.get("platform.appmod/state")
    if state is not None and state != "disabled":
        errors.append(_issue(base + _ptr("platform.appmod/state"), "enum",
                             'The only accepted value is "disabled".',
                             'O único valor aceito é "disabled".'))


def _validate_annotations(errors: list[dict[str, Any]], annotations: Any) -> None:
    base = "/metadata/annotations"
    allowed = {"platform.appmod/compiler", "platform.appmod/display-name",
               "platform.appmod/draft-sha256", "platform.appmod/request-id"}
    if not _check_keys(errors, base, annotations, allowed, tuple(sorted(allowed))):
        return
    _check_const(errors, base + _ptr("platform.appmod/compiler"),
                 annotations.get("platform.appmod/compiler"), BUILDER_COMPILER)
    _check_text(errors, base + _ptr("platform.appmod/display-name"),
                annotations.get("platform.appmod/display-name"), 3, 60)
    digest = annotations.get("platform.appmod/draft-sha256")
    if not isinstance(digest, str) or not _HEX64_PATTERN.fullmatch(digest):
        errors.append(_issue(base + _ptr("platform.appmod/draft-sha256"), "pattern",
                             "Expected 64 lowercase hex characters.",
                             "Esperava 64 caracteres hex em minúscula."))
    request_id = annotations.get("platform.appmod/request-id")
    if not isinstance(request_id, str) or not _REQUEST_ID_PATTERN.fullmatch(request_id):
        errors.append(_issue(base + _ptr("platform.appmod/request-id"), "pattern",
                             'Expected 32 hex characters or "preview".',
                             'Esperava 32 caracteres hex ou "preview".'))


def _validate_deployment(errors: list[dict[str, Any]], base: str, deployment: Any, disabled: bool) -> None:
    if not _check_keys(errors, base, deployment, {"labels", "resources", "replicas"}, ("labels", "resources")):
        return
    pod_labels = deployment.get("labels")
    if _check_keys(errors, base + "/labels", pod_labels, {"platform.appmod/managed-by"},
                   ("platform.appmod/managed-by",)):
        _check_const(errors, base + "/labels" + _ptr("platform.appmod/managed-by"),
                     pod_labels.get("platform.appmod/managed-by"), BUILDER_MANAGED_BY)
    resources = deployment.get("resources")
    if _check_keys(errors, base + "/resources", resources, {"requests", "limits"}, ("requests", "limits")):
        requests = resources.get("requests")
        if _check_keys(errors, base + "/resources/requests", requests, {"cpu", "memory"}, ("cpu", "memory")):
            _check_const(errors, base + "/resources/requests/cpu", requests.get("cpu"), "100m")
            _check_const(errors, base + "/resources/requests/memory", requests.get("memory"), "384Mi")
        limits = resources.get("limits")
        if _check_keys(errors, base + "/resources/limits", limits, {"memory"}, ("memory",)):
            _check_const(errors, base + "/resources/limits/memory", limits.get("memory"), "1Gi")
    # Seção 5.11, item 5. 1 ativo, 0 desativado, sempre explícito: o kagent 0.9.9 ignora replicas ausente, e o Revert do
    # disable deixava o agent sem pod (A10, 13/10/2026).
    if "replicas" in deployment:
        replicas = deployment.get("replicas")
        expected = 0 if disabled else 1
        if isinstance(replicas, bool) or replicas not in (0, 1):
            errors.append(_issue(base + "/replicas", "replicas",
                                 "Only 1 (enabled) or 0 (disabled) is allowed.",
                                 "Só 1 (ativo) ou 0 (desativado) é permitido."))
        elif replicas != expected:
            errors.append(_issue(base + "/replicas", "replicas",
                                 "replicas: 0 goes with the disabled state label, and 1 without it.",
                                 "replicas: 0 vai com o label de estado desativado, e 1 sem ele."))
    else:
        errors.append(_issue(base + "/replicas", "required",
                             "replicas is required: 1 enabled, 0 disabled.",
                             "replicas é obrigatório: 1 ativo, 0 desativado."))


def _validate_tools(errors: list[dict[str, Any]], base: str, tools: Any, catalog: tuple[str, ...]) -> None:
    if not isinstance(tools, list):
        errors.append(_issue(base, "type", "Expected an array.", "Esperava um array."))
        return
    if not tools:
        errors.append(_issue(base, "too_few", "An empty tools key must be omitted.",
                             "A chave tools vazia precisa ser omitida."))
        return
    if len(tools) > 1:
        errors.append(_issue(base, "too_many", "Exactly one McpServer entry is allowed.",
                             "Só uma entrada McpServer é permitida."))
    entry, entry_base = tools[0], base + "/0"
    if not _check_keys(errors, entry_base, entry, {"type", "mcpServer"}, ("type", "mcpServer")):
        return
    _check_const(errors, entry_base + "/type", entry.get("type"), "McpServer")
    server, server_base = entry.get("mcpServer"), entry_base + "/mcpServer"
    fields = {"apiGroup", "kind", "name", "toolNames"}
    if not _check_keys(errors, server_base, server, fields, tuple(sorted(fields))):
        return
    _check_const(errors, server_base + "/apiGroup", server.get("apiGroup"), "kagent.dev")
    _check_const(errors, server_base + "/kind", server.get("kind"), "RemoteMCPServer")
    _check_const(errors, server_base + "/name", server.get("name"), BUILDER_TOOL_SERVER)
    names = server.get("toolNames")
    if not isinstance(names, list) or not names:
        errors.append(_issue(server_base + "/toolNames", "too_few",
                             "At least one tool name is required.",
                             "É preciso ao menos um nome de tool."))
        return
    if len(names) > len(catalog):
        errors.append(_issue(server_base + "/toolNames", "too_many",
                             f"Expected at most {len(catalog)} tool names.",
                             f"Esperava no máximo {len(catalog)} nomes de tool."))
    seen: set[str] = set()
    for index, tool in enumerate(names):
        tool_path = f"{server_base}/toolNames/{index}"
        if not isinstance(tool, str):
            errors.append(_issue(tool_path, "type", "Expected a string.", "Esperava uma string."))
            continue
        if tool not in catalog:
            errors.append(_issue(tool_path, "tool_not_allowed",
                                 "Tool is not in the read-only catalog.",
                                 "A tool não está no catálogo read-only."))
        elif tool in seen:
            errors.append(_issue(tool_path, "duplicate", "Tool is repeated.", "A tool está repetida."))
        seen.add(tool)
    known = [tool for tool in names if isinstance(tool, str) and tool in catalog]
    if known != [tool for tool in catalog if tool in seen]:
        errors.append(_issue(server_base + "/toolNames", "order",
                             "toolNames must follow the catalog order.",
                             "toolNames precisa seguir a ordem do catálogo."))


def _validate_a2a_config(errors: list[dict[str, Any]], base: str, config: Any) -> None:
    if not _check_keys(errors, base, config, {"skills"}, ("skills",)):
        return
    skills = config.get("skills")
    if not isinstance(skills, list):
        errors.append(_issue(base + "/skills", "type", "Expected an array.", "Esperava um array."))
        return
    if not skills:
        errors.append(_issue(base + "/skills", "too_few", "At least one skill is required.",
                             "É preciso ao menos uma skill."))
    elif len(skills) > 3:
        errors.append(_issue(base + "/skills", "too_many", "At most three skills are allowed.",
                             "No máximo três skills são permitidas."))
    seen: set[Any] = set()
    for index, skill in enumerate(skills):
        skill_base = f"{base}/skills/{index}"
        fields = {"id", "name", "description", "tags", "examples"}
        if not _check_keys(errors, skill_base, skill, fields, ("id", "name", "description", "tags")):
            continue
        _check_text(errors, skill_base + "/id", skill.get("id"), 1, 64)
        if skill.get("id") in seen:
            errors.append(_issue(skill_base + "/id", "duplicate",
                                 "Skill id is repeated.", "O id da skill está repetido."))
        seen.add(skill.get("id"))
        _check_text(errors, skill_base + "/name", skill.get("name"), 1, 60)
        _check_text(errors, skill_base + "/description", skill.get("description"), 1, 240)
        if skill.get("tags") != ["agent-builder"]:
            _check_const(errors, skill_base + "/tags", skill.get("tags"), ["agent-builder"])
        if "examples" not in skill:
            continue
        examples = skill.get("examples")
        if not isinstance(examples, list):
            errors.append(_issue(skill_base + "/examples", "type", "Expected an array.", "Esperava um array."))
        elif not examples:
            errors.append(_issue(skill_base + "/examples", "too_few",
                                 "An empty examples list must be omitted.",
                                 "A lista examples vazia precisa ser omitida."))
        elif len(examples) > 3:
            errors.append(_issue(skill_base + "/examples", "too_many",
                                 "At most three examples are allowed.",
                                 "No máximo três exemplos são permitidos."))
        else:
            for position, example in enumerate(examples):
                _check_text(errors, f"{skill_base}/examples/{position}", example, 1, 400)


def _validate_agent_manifest(manifest: Any, catalog: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
    """Allowlist determinística da seção 4, aplicada a um manifest COMPILADO.

    Não serve para objeto vivo: o Argo acrescenta a marca de tracking, que esta
    allowlist recusaria com razão. Segundo ponto de imposição das invariantes
    I3, I4 e I9, independente do validador do CI.
    """
    catalog = TOOL_CATALOG if catalog is None else catalog
    errors: list[dict[str, Any]] = []
    top = {"apiVersion", "kind", "metadata", "spec"}
    if not _check_keys(errors, "", manifest, top, tuple(sorted(top))):
        return errors
    _check_const(errors, "/apiVersion", manifest.get("apiVersion"), AGENT_APIVERSION)
    _check_const(errors, "/kind", manifest.get("kind"), "Agent")

    metadata, name, disabled = manifest.get("metadata"), "", False
    meta_fields = {"name", "namespace", "labels", "annotations"}
    if _check_keys(errors, "/metadata", metadata, meta_fields, tuple(sorted(meta_fields))):
        raw_name = metadata.get("name")
        name = raw_name if isinstance(raw_name, str) else ""
        if not AGENT_NAME_PATTERN.fullmatch(name):
            errors.append(_issue("/metadata/name", "pattern",
                                 "Name must match the ab- builder pattern.",
                                 "O nome precisa casar com o padrão ab- do builder."))
        _check_const(errors, "/metadata/namespace", metadata.get("namespace"), AGENT_NAMESPACE)
        labels = metadata.get("labels")
        disabled = isinstance(labels, dict) and labels.get("platform.appmod/state") == "disabled"
        _validate_labels(errors, labels, name)
        _validate_annotations(errors, metadata.get("annotations"))

    spec = manifest.get("spec")
    spec_fields = {"type", "description", "declarative"}
    if not _check_keys(errors, "/spec", spec, spec_fields, tuple(sorted(spec_fields))):
        return errors
    _check_const(errors, "/spec/type", spec.get("type"), "Declarative")
    _check_text(errors, "/spec/description", spec.get("description"), 20, 240)
    declarative, base = spec.get("declarative"), "/spec/declarative"
    allowed = {"modelConfig", "stream", "systemMessage", "deployment", "tools", "a2aConfig"}
    required = ("a2aConfig", "deployment", "modelConfig", "stream", "systemMessage")
    if not _check_keys(errors, base, declarative, allowed, required):
        return errors
    _check_const(errors, base + "/modelConfig", declarative.get("modelConfig"), BUILDER_MODEL_CONFIG)
    _check_const(errors, base + "/stream", declarative.get("stream"), False)
    system_message = declarative.get("systemMessage")
    if not isinstance(system_message, str):
        errors.append(_issue(base + "/systemMessage", "type", "Expected a string.", "Esperava uma string."))
    elif len(system_message) > 8000:
        errors.append(_issue(base + "/systemMessage", "too_long",
                             "Expected at most 8000 characters.",
                             "Esperava no máximo 8000 caracteres."))
    _validate_deployment(errors, base + "/deployment", declarative.get("deployment"), disabled)
    if "tools" in declarative:
        _validate_tools(errors, base + "/tools", declarative.get("tools"), catalog)
    _validate_a2a_config(errors, base + "/a2aConfig", declarative.get("a2aConfig"))
    return errors


def _epoch(stamp: Any) -> int | None:
    if not isinstance(stamp, str) or not stamp:
        return None
    try:
        parsed = datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None
    return int(parsed.replace(tzinfo=datetime.timezone.utc).timestamp())


def _agent_condition(status: dict[str, Any], kind: str) -> dict[str, str]:
    """Condição real do controller. Ausente volta Unknown, nunca omitida."""
    for condition in status.get("conditions", []) or []:
        if condition.get("type") == kind:
            return {"status": str(condition.get("status", "Unknown")),
                    "reason": str(condition.get("reason", ""))[:120],
                    "message": str(condition.get("message", ""))[:300]}
    return {"status": "Unknown", "reason": "", "message": ""}


def _argo_tracked(metadata: dict[str, Any], name: str, argo_names: set[str], argo_readable: bool,
                  *, application: str = "") -> bool:
    """False é o sinal da ameaça T3: agent com o label do builder criado fora do Git.

    O Argo marca o objeto por annotation (tracking-id) ou por label (instance),
    e qual dos dois depende do resourceTrackingMethod do install, que a seção 12
    do design deixou sem medir. Por isso aceita os dois, e o plano B, a lista de
    recursos da Application, entra quando ela é legível.

    `application` é a Application contra a qual se confere; vazio é a do Agent Builder,
    que é o chamador original. O inventário passa a das instâncias.
    """
    target = application or ARGO_APPLICATION
    labels = metadata.get("labels", {}) or {}
    annotations = metadata.get("annotations", {}) or {}
    tracking = annotations.get(_ARGO_TRACKING_ANNOTATION, "")
    marked = (isinstance(tracking, str) and tracking.startswith(target + ":")) \
        or labels.get(_ARGO_INSTANCE_LABEL) == target
    return bool(marked or (argo_readable and name in argo_names))


def _argo_application(application_name: str, tracked_kind: str | None = "Agent") -> tuple[dict[str, str], set[str], bool]:
    """Estado de UMA Application do Argo. O terceiro item é "deu para ler", não "está sincronizada".

    Generalizado em 15/10/2026 para o inventário live (issues #8 e #9) poder ler a
    Application das instâncias (`agent-platform-instances`) sem duplicar a chamada.
    `_argo_state()` continua existindo com a assinatura antiga porque é o que o
    Agent Builder usa; só o alvo passou a ser parâmetro.

    `tracked_kind=None` (scorecards, 25/10/2026) devolve `Kind/name` de TODO recurso da
    Application, para uma listagem multi-kind conferir o rastreio com uma leitura só.

    O nome é validado AQUI, e não só em quem chama: o alvo pode vir de annotation
    do objeto, e a guarda tem de valer para qualquer chamador futuro. Nome fora da
    forma não vira request e não é ecoado de volta no payload - devolver o texto do
    terceiro seria renderizá-lo na UI. `safe=""` no quote fecha o resto: por default
    o quote NÃO escapa `/`, que é exatamente o caractere do escape de path.
    """
    if not ARGO_APPLICATION_PATTERN.fullmatch(application_name or ""):
        return {"application": "", "sync": "Unknown", "health": "Unknown", "revision": ""}, set(), False
    path = (f"/apis/argoproj.io/v1alpha1/namespaces/{urllib.parse.quote(ARGO_NAMESPACE, safe='')}"
            f"/applications/{urllib.parse.quote(application_name, safe='')}")
    unknown = {"application": application_name, "sync": "Unknown", "health": "Unknown", "revision": ""}
    try:
        application = _k8s("GET", path)
    except (OSError, ValueError, KeyError, TypeError):
        return unknown, set(), False
    status = application.get("status", {}) or {}
    sync = status.get("sync", {}) or {}
    resources = [resource for resource in (status.get("resources", []) or []) if isinstance(resource, dict)]
    if tracked_kind is None:
        names = {_argo_resource_key(str(resource["kind"]), str(resource.get("namespace") or ""), str(resource["name"]))
                 for resource in resources if resource.get("kind") and resource.get("name")}
    else:
        names = {resource.get("name") for resource in resources
                 if resource.get("kind") == tracked_kind and resource.get("name")}
    return ({"application": application_name,
             "sync": str((status.get("sync", {}) or {}).get("status") or "Unknown"),
             "health": str((status.get("health", {}) or {}).get("status") or "Unknown"),
             "revision": str(sync.get("revision") or "")}, names, True)


def _argo_state() -> tuple[dict[str, str], set[str], bool]:
    return _argo_application(ARGO_APPLICATION)


def _agent_pods() -> dict[str, int] | None:
    """Pods não terminados do Deployment de cada agent, pelo nome. None quando não deu para ler.

    O controller do kagent 0.9.9 cria o Deployment com o MESMO nome do Agent, no mesmo namespace,
    e copia `spec.declarative.deployment.replicas` para ele (translator/agent/manifest_builder.go).
    `status.replicas` some quando é 0 (omitempty), então ausente com o objeto lido é zero.
    Existe para a fase DISABLED olhar o que aconteceu, não o que foi pedido (review de 13/10/2026,
    rodada 3, R3-1). Só `list` em deployments, que a cluster-api já tinha.
    """
    try:
        listing = _k8s("GET", f"/apis/apps/v1/namespaces/{AGENT_NAMESPACE}/deployments")
    except (OSError, ValueError, KeyError, TypeError):
        return None
    pods: dict[str, int] = {}
    for item in listing.get("items", []) or []:
        name = ((item or {}).get("metadata", {}) or {}).get("name")
        count = ((item or {}).get("status", {}) or {}).get("replicas", 0)
        if isinstance(name, str) and isinstance(count, int) and not isinstance(count, bool):
            pods[name] = count
    return pods


def _agent_row(item: dict[str, Any], argo_names: set[str], argo_readable: bool,
               pods: dict[str, int] | None = None) -> dict[str, Any]:
    metadata = item.get("metadata", {}) or {}
    labels = metadata.get("labels", {}) or {}
    annotations = metadata.get("annotations", {}) or {}
    status = item.get("status", {}) or {}
    declarative = (item.get("spec", {}) or {}).get("declarative", {}) or {}
    deployment = declarative.get("deployment", {}) or {}
    name = str(metadata.get("name") or "")
    generation, observed = metadata.get("generation"), status.get("observedGeneration")
    replicas = deployment.get("replicas")
    replicas = replicas if isinstance(replicas, int) and not isinstance(replicas, bool) else None
    tools: list[str] = []
    for entry in declarative.get("tools", []) or []:
        server = (entry or {}).get("mcpServer", {}) or {}
        tools.extend(tool for tool in server.get("toolNames", []) or [] if isinstance(tool, str))
    return {
        "name": name,
        "displayName": str(annotations.get("platform.appmod/display-name") or name),
        "requester": str(labels.get("platform.appmod/requester") or ""),
        "requestId": str(annotations.get("platform.appmod/request-id") or ""),
        "draftSha256": str(annotations.get("platform.appmod/draft-sha256") or ""),
        "fixture": labels.get("platform.appmod/fixture") == "true",
        "createdAt": _epoch(metadata.get("creationTimestamp")),
        "generation": generation if isinstance(generation, int) else None,
        "observedGeneration": observed if isinstance(observed, int) else None,
        # Status velho: o controller ainda não observou o spec corrente, então
        # as condições falam do spec ANTERIOR e não podem ser lidas como atuais.
        "statusStale": not (isinstance(observed, int) and isinstance(generation, int)
                            and observed >= generation),
        "resourceVersion": str(metadata.get("resourceVersion") or ""),
        "replicas": replicas,
        # Pods de verdade. None quando o Deployment não foi lido ou ainda não existe: a UI só
        # declara DISABLED com 0 aqui, nunca pelo spec sozinho (fail closed).
        "podReplicas": (pods or {}).get(name) if pods is not None else None,
        "disabled": replicas == 0 or labels.get("platform.appmod/state") == "disabled",
        "argoTracked": _argo_tracked(metadata, name, argo_names, argo_readable),
        "tools": tools,
        "accepted": _agent_condition(status, "Accepted"),
        "ready": _agent_condition(status, "Ready"),
    }


def _agent_object(name: str) -> dict[str, Any] | None:
    """Objeto vivo do agent, ou None quando não é agent do builder."""
    if not AGENT_NAME_PATTERN.fullmatch(name or ""):
        return None
    try:
        item = _k8s("GET", f"{AGENT_API}/namespaces/{AGENT_NAMESPACE}/agents/{urllib.parse.quote(name)}")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    labels = (item.get("metadata", {}) or {}).get("labels", {}) or {}
    return item if labels.get("app.kubernetes.io/managed-by") == BUILDER_MANAGED_BY else None


def _builder_agents() -> dict[str, Any]:
    selector = urllib.parse.quote(f"app.kubernetes.io/managed-by={BUILDER_MANAGED_BY}", safe="")
    listing = _k8s("GET", f"{AGENT_API}/namespaces/{AGENT_NAMESPACE}/agents?labelSelector={selector}")
    argo, argo_names, readable = _argo_state()
    pods = _agent_pods()
    rows = sorted((_agent_row(item, argo_names, readable, pods) for item in listing.get("items", [])),
                  key=lambda row: row["name"])
    return {"namespace": AGENT_NAMESPACE, "argo": argo, "agents": rows}


def _builder_agent(name: str) -> dict[str, Any] | None:
    item = _agent_object(name)
    if item is None:
        return None
    argo, argo_names, readable = _argo_state()
    row = _agent_row(item, argo_names, readable, _agent_pods())
    field = urllib.parse.quote(f"involvedObject.name={name}")
    try:
        events = _k8s("GET", f"/api/v1/namespaces/{AGENT_NAMESPACE}/events?fieldSelector={field}").get("items", [])
    except (OSError, ValueError, KeyError, TypeError):
        events = []
    row["argo"] = argo
    row["events"] = [{"reason": event.get("reason"), "type": event.get("type"),
                      "message": (event.get("message") or "")[:300],
                      "count": event.get("count"), "last": event.get("lastTimestamp")}
                     for event in events[-10:]]
    return row


# ------------------------------------------------------- sinal agent_observed
# Contrato: tests/fixtures/agent-builder-e2e/observability-spec.json, evento
# `agent_builder_agent_observed`. Emitido SÓ pela rota de detalhe
# (GET /cluster/agents/{name}), que é a única que lê os Events: sem eles a causa
# sairia sem classificação, e um `cause` que não foi medido é pior que nenhum.
# A rota de lista não emite, de propósito (ver a seção "Os dez eventos" de
# docs/agent-platform/e2e/observability.md).
#
# A fase aqui é o SUBCONJUNTO que o cluster vê. O estado do pedido (MR) e o
# resultado do A2A vivem fora desta Lambda, então REQUESTED, IN_REVIEW, FAILED,
# CLOSED, SYNCING, SYNC_STALLED, VERIFIED e TEST_FAILED nunca saem daqui. A fase
# completa continua sendo a de src/platform/agentBuilderPhase.ts, que tem as três
# fontes. As regras abaixo são as mesmas da seção 6.2 do design, na mesma ordem.
_OBSERVE_BUDGET_SECONDS = 900
_EVENT_WINDOW_SECONDS = 900
_EVENT_REASON_ALLOWLIST = frozenset({
    "BackOff", "Created", "Evicted", "FailedCreate", "FailedMount", "FailedScheduling",
    "Failed", "Killing", "OOMKilling", "Pulling", "Pulled", "Scheduled", "Started",
    "SuccessfulCreate", "Unhealthy",
})
# `reason` de condição é, por convenção do Kubernetes, um token CamelCase. Qualquer coisa
# fora disso é mensagem vazando para o campo de motivo, então o campo é DESCARTADO em vez
# de logado: é a regra 2 da redação (medida, não conteúdo) aplicada fail closed.
_CONDITION_REASON = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")


def _observed_phase(row: dict[str, Any], now: int) -> str:
    created = row.get("createdAt")
    within = created is not None and (now - int(created)) < _OBSERVE_BUDGET_SECONDS
    if (row.get("accepted") or {}).get("status") == "False":
        return "REJECTED"
    same_generation = (row.get("observedGeneration") is not None
                       and row.get("observedGeneration") == row.get("generation"))
    # R3-1: desativado é o que aconteceu (zero pod), não o que foi pedido.
    if row.get("replicas") == 0 and same_generation and row.get("podReplicas") == 0:
        return "DISABLED"
    if (row.get("ready") or {}).get("status") == "True" and same_generation:
        return "READY"
    return "STARTING" if within else "STALLED"


def _fresh_warnings(row: dict[str, Any], now: int) -> list[dict[str, Any]]:
    """Events Warning dentro da janela. Event velho não classifica causa."""
    picked = []
    for item in row.get("events") or []:
        if str(item.get("type")) != "Warning":
            continue
        last = _epoch(item.get("last"))
        if last is None or (now - last) > _EVENT_WINDOW_SECONDS:
            continue
        picked.append(item)
    return picked


def _observed_cause(row: dict[str, Any], warnings: list[dict[str, Any]]) -> str:
    """Classifica a causa provável. A MENSAGEM do event é lida aqui e não sai no log."""
    if row.get("argoTracked") is False:
        return "NOT_TRACKED_BY_ARGO"
    accepted = row.get("accepted") or {}
    if accepted.get("status") == "False":
        detail = f"{accepted.get('reason', '')} {accepted.get('message', '')}".lower()
        if "modelconfig" in detail.replace(" ", "") or "model config" in detail:
            return "MODEL_CONFIG_MISSING"
        return "CONTROLLER_REJECTED"

    def hit(reasons: set[str], needles: tuple[str, ...]) -> bool:
        for event in warnings:
            if str(event.get("reason")) in reasons:
                return True
            text = f"{event.get('reason', '')} {event.get('message', '')}".lower()
            if any(needle in text for needle in needles):
                return True
        return False

    if hit({"OOMKilling"}, ("oomkill", "out of memory", "oomkilled")):
        return "OOM_KILLED"
    if hit({"ErrImagePull", "ImagePullBackOff"},
           ("failed to pull image", "errimagepull", "imagepullbackoff", "pull access denied",
            "manifest unknown", "back-off pulling image")):
        return "IMAGE_PULL"
    if hit(set(), ("createcontainerconfigerror",)) or any(
        "configmap" in f"{event.get('message', '')}".lower()
        and "not found" in f"{event.get('message', '')}".lower() for event in warnings
    ):
        return "CONFIG_MISSING"
    if hit({"FailedScheduling"}, ("insufficient", "untolerated taint")):
        return "UNSCHEDULABLE"
    if hit(set(), ("exceeded quota",)):
        return "QUOTA"
    if hit(set(), ("crashloopbackoff", "restarting failed container")):
        return "CRASH_LOOP"
    return "UNKNOWN" if warnings else "NONE"


def _stale_reasons(row: dict[str, Any]) -> list[str]:
    """Por que a leitura não é confiável. Vazia significa fresca.

    STALE_READ não aparece aqui: o sinal é emitido no mesmo request que leu o cluster.
    """
    reasons = []
    if row.get("observedGeneration") != row.get("generation"):
        reasons.append("GENERATION_LAG")
    if (row.get("argo") or {}).get("sync") in (None, "Unknown"):
        reasons.append("ARGO_UNKNOWN")
    return reasons


def _condition_reason(condition: Any) -> str | None:
    reason = (condition or {}).get("reason") if isinstance(condition, dict) else None
    return reason if isinstance(reason, str) and _CONDITION_REASON.match(reason) else None


def _agent_observed_signal(row: dict[str, Any], alias: str, now: int) -> dict[str, Any]:
    """Monta o evento do contrato. Só medida e enum: nada de prompt, manifest ou mensagem."""
    warnings = _fresh_warnings(row, now)
    reasons = [str(item.get("reason")) for item in warnings]
    kept = sorted({item for item in reasons if item in _EVENT_REASON_ALLOWLIST})
    other = len([item for item in reasons if item not in _EVENT_REASON_ALLOWLIST])
    stale = _stale_reasons(row)
    created = row.get("createdAt")
    signal: dict[str, Any] = {
        "event": "agent_builder_agent_observed",
        "name": str(row.get("name") or "")[:63],
        "caller_alias": alias[:80],
        "phase": _observed_phase(row, now),
        "cause": _observed_cause(row, warnings),
        "generation": row.get("generation"),
        "observed_generation": row.get("observedGeneration"),
        "argo_tracked": bool(row.get("argoTracked")),
        "age_seconds": now - int(created) if created is not None else 0,
        "fresh": not stale,
    }
    if row.get("replicas") is not None:
        signal["replicas"] = row.get("replicas")
    for field, condition in (("accepted", row.get("accepted")), ("ready", row.get("ready"))):
        if isinstance(condition, dict):
            signal[f"{field}_status"] = str(condition.get("status") or "Unknown")
            reason = _condition_reason(condition)
            if reason:
                signal[f"{field}_reason"] = reason
    if kept:
        signal["event_reasons"] = kept
    if other:
        signal["event_reasons_other_count"] = other
    if stale:
        signal["stale_reasons"] = stale
    return signal


def _emit_agent_observed(row: dict[str, Any], alias: str) -> None:
    """Uma linha por leitura de detalhe. Nunca derruba a resposta da rota."""
    try:
        print(json.dumps(_agent_observed_signal(row, alias, int(time.time()))))
    except (TypeError, ValueError, KeyError):
        print(json.dumps({"event": "cluster_api_signal_error", "signal": "agent_observed"}))


def _agent_name_state(name: str) -> dict[str, Any]:
    """Unicidade de nome no namespace. Fail closed: só um 404 explícito libera."""
    try:
        item = _k8s("GET", f"{AGENT_API}/namespaces/{AGENT_NAMESPACE}/agents/{urllib.parse.quote(name)}")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return {"name": name, "available": True, "state": "free",
                    "builderManaged": None, "requester": "", "reason": ""}
        return {"name": name, "available": False, "state": "unknown", "builderManaged": None,
                "requester": "", "reason": f"cluster read returned http {error.code}"}
    except (OSError, ValueError, KeyError, TypeError):
        return {"name": name, "available": False, "state": "unknown", "builderManaged": None,
                "requester": "", "reason": "cluster read failed"}
    labels = (item.get("metadata", {}) or {}).get("labels", {}) or {}
    return {"name": name, "available": False, "state": "taken",
            "builderManaged": labels.get("app.kubernetes.io/managed-by") == BUILDER_MANAGED_BY,
            "requester": str(labels.get("platform.appmod/requester") or ""),
            "reason": "an agent with this name already exists in the namespace"}


def _tool_inventory() -> dict[str, Any]:
    """Tools vivas do tool server do builder, conferidas contra o catálogo (P2).

    Descoberta degradada nunca vira "tudo certo": na dúvida o inventário volta
    degraded, com o motivo, e sem apresentar tool nenhuma como disponível.
    """
    catalog = list(TOOL_CATALOG)
    report: dict[str, Any] = {
        "server": {"name": BUILDER_TOOL_SERVER, "namespace": AGENT_NAMESPACE,
                   "accepted": {"status": "Unknown", "reason": "", "message": ""}},
        "catalog": catalog, "discovered": [], "missing": catalog, "unexpected": [],
        "writeCapable": [], "degraded": True, "reason": "",
    }
    path = (f"{AGENT_API}/namespaces/{AGENT_NAMESPACE}/remotemcpservers/"
            f"{urllib.parse.quote(BUILDER_TOOL_SERVER)}")
    try:
        server = _k8s("GET", path)
    except urllib.error.HTTPError as error:
        report["reason"] = f"tool server unreadable: http {error.code}"
        return report
    except (OSError, ValueError, KeyError, TypeError):
        report["reason"] = "tool server unreadable"
        return report
    status = server.get("status", {}) or {}
    discovered = sorted({tool.get("name") for tool in status.get("discoveredTools", []) or []
                         if isinstance(tool, dict) and isinstance(tool.get("name"), str)})
    missing = [tool for tool in catalog if tool not in discovered]
    unexpected = [tool for tool in discovered if tool not in catalog]
    write_capable = sorted(tool for tool in discovered
                           if any(token in tool.lower() for token in WRITE_TOOL_TOKENS))
    reasons = []
    if not discovered:
        reasons.append("no tool was discovered")
    if missing:
        reasons.append("catalog tools missing from discovery: " + ", ".join(missing[:10]))
    if unexpected:
        reasons.append("tools discovered outside the catalog: " + ", ".join(unexpected[:10]))
    if write_capable:
        reasons.append("write-capable tool names discovered: " + ", ".join(write_capable[:10]))
    report.update({"discovered": discovered, "missing": missing, "unexpected": unexpected,
                   "writeCapable": write_capable, "degraded": bool(reasons),
                   "reason": "; ".join(reasons)})
    report["server"]["accepted"] = _agent_condition(status, "Accepted")
    return report


def _against_openapi(value: Any, schema: Any, path: str, depth: int = 0) -> list[dict[str, Any]]:
    """Conferência estrutural contra o openAPIV3Schema do CRD vivo.

    Só leitura: precisa de get em customresourcedefinitions e de nenhum verbo de
    escrita. Pega deriva de CRD (campo que saiu, enum que mudou) antes do MR.
    """
    errors: list[dict[str, Any]] = []
    if not isinstance(schema, dict) or depth > 12 or schema.get("x-kubernetes-preserve-unknown-fields"):
        return errors
    expected = schema.get("type")
    mismatch = (
        (expected == "object" and not isinstance(value, dict))
        or (expected == "array" and not isinstance(value, list))
        or (expected == "string" and not isinstance(value, str))
        or (expected == "boolean" and not isinstance(value, bool))
        or (expected in ("integer", "number") and (isinstance(value, bool) or not isinstance(value, (int, float))))
    )
    if mismatch:
        return [_issue(path or "/", "type", f"The cluster CRD expects type {expected}.",
                       f"O CRD do cluster espera o tipo {expected}.")]
    enum = schema.get("enum")
    if isinstance(enum, list) and enum and value not in enum:
        errors.append(_issue(path or "/", "enum", "Value is outside the CRD enum.",
                             "O valor está fora do enum do CRD."))
    if isinstance(value, dict):
        properties = schema.get("properties") or {}
        extra = schema.get("additionalProperties")
        for key in schema.get("required") or []:
            if key not in value:
                errors.append(_issue(path + _ptr(key), "required",
                                     "The cluster CRD requires this field.",
                                     "O CRD do cluster exige este campo."))
        for key in sorted(value):
            if key in properties:
                errors.extend(_against_openapi(value[key], properties[key], path + _ptr(key), depth + 1))
            elif extra is False:
                errors.append(_issue(path + _ptr(key), "unknown_field",
                                     "The cluster CRD does not accept this field.",
                                     "O CRD do cluster não aceita este campo."))
            elif isinstance(extra, dict):
                errors.extend(_against_openapi(value[key], extra, path + _ptr(key), depth + 1))
    elif isinstance(value, list) and isinstance(schema.get("items"), dict):
        for index, item in enumerate(value):
            errors.extend(_against_openapi(item, schema["items"], f"{path}/{index}", depth + 1))
    return errors


def _crd_check(manifest: dict[str, Any]) -> dict[str, Any]:
    report: dict[str, Any] = {"checked": False, "servedVersion": "", "reason": "", "errors": []}
    try:
        crd = _k8s("GET", f"/apis/apiextensions.k8s.io/v1/customresourcedefinitions/{AGENT_CRD}")
    except urllib.error.HTTPError as error:
        report["reason"] = f"crd unreadable: http {error.code}"
        return report
    except (OSError, ValueError, KeyError, TypeError):
        report["reason"] = "crd unreadable"
        return report
    wanted = AGENT_APIVERSION.split("/", 1)[1]
    served = next((version for version in (crd.get("spec", {}) or {}).get("versions", []) or []
                   if version.get("name") == wanted and version.get("served")), None)
    if served is None:
        report["reason"] = f"the cluster CRD does not serve {wanted}"
        report["errors"] = [_issue("/apiVersion", "enum",
                                   f"The cluster CRD does not serve {wanted}.",
                                   f"O CRD do cluster não serve {wanted}.")]
        return report
    report["checked"], report["servedVersion"] = True, wanted
    schema = (served.get("schema", {}) or {}).get("openAPIV3Schema", {}) or {}
    report["errors"] = _against_openapi(manifest, schema, "")[:25]
    return report


def _server_dry_run(manifest: dict[str, Any]) -> dict[str, Any]:
    """Adaptador do dryRun=All do API server, desligado por default.

    O dryRun não persiste, mas o verbo exigido é create em agents.kagent.dev, e
    conceder esse verbo à cluster-api quebraria a invariante I5 e a P4. Então o
    RBAC não concede, a flag nasce false e, ligada sem o RBAC, o 403 volta como
    performed: false. Nenhum caminho aqui transforma "não conferido" em válido.
    """
    if not AGENT_DRYRUN_APPLY:
        return {"performed": False, "sent": False,
                "reason": "server dry-run is disabled: the cluster-api holds no create verb on "
                          "agents.kagent.dev (invariant I5, precondition P4)"}
    path = (f"{AGENT_API}/namespaces/{AGENT_NAMESPACE}/agents"
            "?dryRun=All&fieldValidation=Strict")
    try:
        _k8s("POST", path, body=manifest)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:300]
        return {"performed": False, "sent": True,
                "reason": f"api server returned http {error.code}", "detail": detail}
    except (OSError, ValueError, KeyError, TypeError):
        return {"performed": False, "sent": True, "reason": "api server unreachable"}
    return {"performed": True, "sent": True, "reason": ""}


def _dry_run(manifest: Any, catalog: tuple[str, ...] | None = None) -> dict[str, Any]:
    shape = _validate_agent_manifest(manifest, catalog)
    if shape:
        crd = {"checked": False, "servedVersion": "", "errors": [],
               "reason": "skipped: the manifest shape is invalid"}
    else:
        crd = _crd_check(manifest)
    if shape or crd["errors"]:
        server = {"performed": False, "sent": False, "reason": "skipped: validation failed earlier"}
    else:
        server = _server_dry_run(manifest)
    errors = shape + list(crd["errors"])
    return {
        "valid": not errors,
        "errors": errors[:50],
        "shape": {"checked": True, "errorCount": len(shape)},
        "crd": {key: value for key, value in crd.items() if key != "errors"},
        "serverDryRun": server,
        # valid diz que as conferências determinísticas passaram. Só
        # serverConfirmed diz que o API server concordou, e advisory avisa que
        # ninguém no cluster confirmou nada.
        "serverConfirmed": bool(server.get("performed")),
        "advisory": not server.get("performed"),
    }


def _compile_draft(draft: Any, requester: str, is_admin: bool = False) -> dict[str, Any] | None:
    """Valida e compila pelo núcleo do W1 quando ele está empacotado; None quando não está.

    Draft inválido devolve {"__invalid__": [...erros...]}: o validador é o mesmo do preview e do
    CI, então a cluster-api não decide sozinha o que é um draft válido.
    """
    try:
        from agent_builder import compile_manifest, normalize_draft, validate_draft  # type: ignore[import-not-found]
    except ImportError:
        return None
    validation = validate_draft(draft, caller_is_admin=is_admin)
    if not validation.valid:
        return {"__invalid__": [issue.as_dict() for issue in validation.errors]}
    try:
        compiled = compile_manifest(normalize_draft(draft), requester, "preview")
        return json.loads(compiled.decode("utf-8"))
    except Exception as error:  # noqa: BLE001 - catálogo ausente no bundle: degrada, não derruba
        print(json.dumps({"event": "agent_draft_compile_failed", "error": str(error)[:200]}))
        return None


def _agent_language(item: dict[str, Any]) -> str:
    message = ((item.get("spec", {}) or {}).get("declarative", {}) or {}).get("systemMessage") or ""
    for marker, code in _LANGUAGE_BY_MARKER.items():
        if f"Answer in {marker}." in message:
            return code
    return "pt-BR"


def _a2a_call(name: str, method: str, params: dict[str, Any], alias: str) -> dict[str, Any]:
    """Único caminho para o controller. Allowlist de método e corpo montado aqui.

    Invariantes I7 e I14: o método tem de estar na allowlist, o path é derivado
    de um nome já validado e o cliente não contribui com nada além do texto.
    """
    if method not in A2A_METHODS:
        raise ValueError("a2a method not allowed")
    if not AGENT_NAME_PATTERN.fullmatch(name or ""):
        raise ValueError("invalid agent name")
    service = urllib.parse.quote(A2A_SERVICE, safe=":")
    path = (f"/api/v1/namespaces/{AGENT_NAMESPACE}/services/{service}/proxy"
            f"/api/a2a/{AGENT_NAMESPACE}/{name}/")
    body = {"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method, "params": params}
    request = urllib.request.Request(
        CLUSTER_ENDPOINT + path, method="POST", data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {_k8s_token()}", "Content-Type": "application/json",
                 "Accept": "application/json", "X-User-Id": alias},
    )
    with urllib.request.urlopen(request, context=_ssl_context(), timeout=A2A_TIMEOUT) as response:
        payload = json.loads(response.read() or b"{}")
    if isinstance(payload, dict) and payload.get("error"):
        error = payload["error"]
        detail = error.get("message") if isinstance(error, dict) else error
        raise _A2AError(str(detail)[:300])
    return payload if isinstance(payload, dict) else {}


def _a2a_text(result: dict[str, Any]) -> str:
    chunks: list[str] = []

    def collect(message: Any) -> None:
        for part in (message or {}).get("parts", []) or []:
            text = part.get("text") if isinstance(part, dict) else None
            if isinstance(text, str) and text.strip():
                chunks.append(text.strip())

    collect((result.get("status", {}) or {}).get("message"))
    for artifact in result.get("artifacts", []) or []:
        collect(artifact)
    if not chunks:
        for message in reversed(result.get("history", []) or []):
            if isinstance(message, dict) and message.get("role") == "agent":
                collect(message)
                if chunks:
                    break
    return "\n".join(chunks).strip()


def _a2a_send(name: str, alias: str, text: str) -> dict[str, Any]:
    params = {
        "message": {"role": "user", "messageId": uuid.uuid4().hex,
                    "parts": [{"kind": "text", "text": text}]},
        "configuration": {"blocking": AGENT_A2A_BLOCKING},
    }
    result = _a2a_call(name, "message/send", params, alias).get("result") or {}
    task_id = result.get("id") or result.get("taskId") or ""
    state = (result.get("status", {}) or {}).get("state") or result.get("state") or "submitted"
    return {"taskId": str(task_id), "contextId": str(result.get("contextId") or ""), "state": str(state)}


def _a2a_poll(name: str, alias: str, task_id: str) -> dict[str, Any]:
    result = _a2a_call(name, "tasks/get", {"id": task_id, "historyLength": 10}, alias).get("result") or {}
    text = _a2a_text(result)
    state = (result.get("status", {}) or {}).get("state") or "unknown"
    return {"taskId": task_id, "state": str(state), "text": text[:2000], "hasText": bool(text)}


def _agent_route(path: str) -> tuple[str | None, list[str]]:
    """Separa /cluster/agents/{name}[/a2a-test[/{taskId}]]."""
    marker = "/cluster/agents/"
    index = path.find(marker)
    if index < 0:
        return None, []
    rest = path[index + len(marker):].strip("/")
    if not rest:
        return None, []
    parts = rest.split("/")
    return parts[0], parts[1:]


def _builder_body(raw: Any, allowed: set[str]) -> dict[str, Any]:
    if isinstance(raw, str) and len(raw.encode()) > MAX_BODY:
        raise ValueError("body too large")
    body = json.loads(raw) if isinstance(raw, str) else (raw or {})
    if not isinstance(body, dict):
        raise ValueError("body must be a json object")
    extra = sorted(set(body) - allowed)
    if extra:
        raise ValueError("unexpected fields in body: " + ", ".join(extra[:10]))
    return body


def _a2a_test_route_inner(name: str, alias: str, is_admin: bool, raw: Any) -> tuple[int, dict[str, Any]]:
    body = _builder_body(raw, {"text"})
    item = _agent_object(name)
    if item is None:
        return 404, {"error": "not a builder agent"}
    labels = (item.get("metadata", {}) or {}).get("labels", {}) or {}
    requester = str(labels.get("platform.appmod/requester") or "")
    if not is_admin and alias != requester:
        return 403, {"error": "only the requester or a platform admin can test this agent"}
    row = _agent_row(item, set(), False)
    if row["ready"]["status"] != "True" or row["replicas"] == 0:
        return 409, {"error": "agent not ready",
                     "ready": row["ready"], "replicas": row["replicas"],
                     "statusStale": row["statusStale"]}
    text = body.get("text")
    if text is None:
        text = _A2A_PROBE.get(_agent_language(item), _A2A_PROBE["pt-BR"])
    elif not isinstance(text, str) or text != text.strip() or not 1 <= len(text) <= 500:
        return 400, {"error": "text must be a trimmed string of 1 to 500 characters"}
    return 202, _a2a_send(name, alias, text)


def _a2a_poll_route_inner(name: str, alias: str, is_admin: bool, task_id: str) -> tuple[int, dict[str, Any]]:
    if not TASK_ID_PATTERN.fullmatch(task_id or ""):
        return 400, {"error": "invalid task id"}
    item = _agent_object(name)
    if item is None:
        return 404, {"error": "not a builder agent"}
    labels = (item.get("metadata", {}) or {}).get("labels", {}) or {}
    if not is_admin and alias != str(labels.get("platform.appmod/requester") or ""):
        return 403, {"error": "only the requester or a platform admin can test this agent"}
    return 200, _a2a_poll(name, alias, task_id)


_A2A_STATES = {"submitted", "working", "input-required", "completed", "failed", "canceled", "rejected"}
_A2A_DENIAL = {404: "not_builder_agent", 403: "not_owner"}


def _a2a_signal(name: str, alias: str, status: int, body: dict[str, Any], started: float) -> None:
    """Sinal estruturado do contrato (tests/fixtures/agent-builder-e2e/observability-spec.json).
    Só medidas: o texto da pergunta e da resposta nunca entram no log."""
    if status in (200, 202):
        state = str(body.get("state") or "")
        signal: dict[str, Any] = {
            "event": "agent_builder_a2a_test", "name": name, "caller_alias": alias,
            "task_id": str(body.get("taskId") or "")[:64], "state": state if state in _A2A_STATES else "unknown",
            "has_text": bool(body.get("hasText")), "duration_ms": int((time.time() - started) * 1000),
            "http_status": status,
        }
        if isinstance(body.get("text"), str):
            signal["text_chars"] = len(body["text"])
        print(json.dumps(signal))
        return
    reason = _A2A_DENIAL.get(status)
    if status == 409:
        reason = "agent_disabled" if body.get("replicas") == 0 else "agent_not_ready"
    if reason:
        print(json.dumps({"event": "agent_builder_a2a_denied", "name": name, "caller_alias": alias,
                          "reason_code": reason, "http_status": status}))


def _a2a_test_route(name: str, alias: str, is_admin: bool, raw: Any) -> tuple[int, dict[str, Any]]:
    started = time.time()
    status, body = _a2a_test_route_inner(name, alias, is_admin, raw)
    _a2a_signal(name, alias, status, body, started)
    return status, body


def _a2a_poll_route(name: str, alias: str, is_admin: bool, task_id: str) -> tuple[int, dict[str, Any]]:
    started = time.time()
    status, body = _a2a_poll_route_inner(name, alias, is_admin, task_id)
    _a2a_signal(name, alias, status, {"taskId": task_id, **body}, started)
    return status, body


def _dry_run_route(alias: str, is_admin: bool, raw: Any) -> tuple[int, dict[str, Any]]:
    body = _builder_body(raw, {"manifest", "draft"})
    if ("manifest" in body) == ("draft" in body):
        return 400, {"error": "send exactly one of manifest or draft"}
    if "manifest" in body:
        # I2: o caminho normal compila aqui dentro. Manifest cru do cliente é
        # conferência de admin, sempre rotulada na resposta, e não cria nada.
        if not is_admin:
            return 403, {"error": "a raw manifest can only be checked by a platform admin; send draft instead"}
        manifest, source = body["manifest"], "client-manifest"
    else:
        compiled = _compile_draft(body["draft"], alias, is_admin)
        if compiled is None:
            return 501, {"error": "draft compilation is unavailable in this deployment",
                         "hint": "use the platform-api preview, or send manifest as a platform admin"}
        if "__invalid__" in compiled:
            return 200, {"valid": False, "errors": compiled["__invalid__"], "source": "draft-validation",
                         "serverConfirmed": False, "advisory": True}
        manifest, source = compiled, "compiled-from-draft"
    result = _dry_run(manifest)
    result["source"] = source
    return 200, result


def _scale(namespace: str, kind: str, name: str, replicas: int) -> dict[str, Any]:
    plural = {"deployment": "deployments", "statefulset": "statefulsets"}[kind]
    result = _k8s("PATCH", f"/apis/apps/v1/namespaces/{namespace}/{plural}/{name}/scale",
                  body={"spec": {"replicas": replicas}}, content_type="application/merge-patch+json")
    return {"scaled": True, "replicas": result.get("spec", {}).get("replicas")}


def _restart(namespace: str, kind: str, name: str) -> dict[str, Any]:
    import datetime
    plural = {"deployment": "deployments", "statefulset": "statefulsets", "daemonset": "daemonsets"}[kind]
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    _k8s("PATCH", f"/apis/apps/v1/namespaces/{namespace}/{plural}/{name}",
         body={"spec": {"template": {"metadata": {"annotations": {"kubectl.kubernetes.io/restartedAt": stamp}}}}},
         content_type="application/merge-patch+json")
    return {"restarted": True, "at": stamp}


# ---------------------------------------------------------------------------
# Escopo de projeto (issue #10). A decisão é do platform_scope; aqui só se diz
# qual namespace cada rota toca e qual ação ela é.
# ---------------------------------------------------------------------------
_SCOPED_NAMESPACED = ("/cluster/workloads", "/cluster/pods", "/cluster/pod", "/cluster/logs",
                      "/cluster/services", "/cluster/config", "/cluster/events",
                      "/cluster/capabilities", "/cluster/instances", "/cluster/instance",
                      "/cluster/pod-metrics", "/cluster/scorecards", "/cluster/instance-graph")
_SCOPED_FILTERED = ("/cluster/overview", "/cluster/platform")
_SCOPED_OPERATE = ("/cluster/scale", "/cluster/restart", "/cluster/delete-pod")
# Diretório GitOps em que o Platform Assistant escreve (backend/platform_assistant/planner.INSTANCE_PATH).
ASSISTANT_GITOPS_PATH = "platform/instances"


def _request_scope(method: str, path: str, params: dict[str, Any], body: dict[str, Any] | None,
                   alias: str, is_admin: bool, builder_route: bool) -> platform_scope.Scope | None:
    """Escopo resolvido no servidor, ou None para rota sem dado de projeto (nodes, 404)."""
    project = params.get("project")
    ends = lambda suffixes: any(path.endswith(suffix) for suffix in suffixes)  # noqa: E731
    if builder_route:
        # Todo o Agent Builder vive no namespace kagent (ADR-0008): o escopo tem de contê-lo.
        action = platform_scope.ACTION_READ if method == "GET" else platform_scope.ACTION_PROPOSE
        target = AGENT_NAMESPACE
    elif method == "GET" and ends(_SCOPED_NAMESPACED + _SCOPED_FILTERED):
        action, target = platform_scope.ACTION_READ, params.get("ns")
    elif method == "POST" and ends(_SCOPED_OPERATE):
        action, target = platform_scope.ACTION_OPERATE, (body or {}).get("ns")
    else:
        return None
    registry = platform_scope.load_registry()
    return platform_scope.resolve(registry, alias, is_admin, project, target, action)


def _response(status: int, body: dict[str, Any], origin: str = "") -> dict[str, Any]:
    headers = {"Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    if origin:
        headers.update({"Access-Control-Allow-Origin": origin,
                        "Access-Control-Allow-Headers": "authorization,content-type,x-amz-date,x-amz-security-token,x-amz-content-sha256",
                        "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Vary": "Origin"})
    return {"statusCode": status, "headers": headers, "body": json.dumps(body)}


def _caller_alias(event: dict[str, Any]) -> str:
    """Alias do caller pelo adapter de identidade (backend/platform_identity): IAM/the internal gateway no modo
    interno, authorizer JWT (Cognito/OIDC) no sample público. Vazio = 403 abaixo."""
    return platform_identity.caller_alias(event)


def _platform_observe(event: dict[str, Any]) -> dict[str, Any]:
    """Leitura interna do Platform Assistant (issue #12): `{"platformObserve": {ns, kind, name}}`.

    Só chega por lambda:Invoke direto, nunca pelo API Gateway, que sempre monta `httpMethod` e
    `requestContext` e não deixa o browser escolher chaves de topo do evento. Quem pode invocar é
    decidido pelo IAM (só a role da platform-api tem lambda:InvokeFunction nesta função). É a mesma
    leitura do GET /cluster/instance, sem flag de admin, e só em namespace que algum projeto do
    registry possui: um namespace fora do registry nunca é lido por este caminho.
    """
    request = event.get("platformObserve")
    # Mesmo kill switch das rotas do Assistant: desligado, o caminho interno também não lê nada.
    if os.environ.get("PLATFORM_ASSISTANT_ENABLED", "false").strip().lower() != "true":
        return {"status": 404, "body": {"error": "platform assistant disabled"}}
    if not isinstance(request, dict) or set(request) != {"ns", "kind", "name"} \
            or not all(isinstance(value, str) for value in request.values()):
        return {"status": 400, "body": {"error": "platformObserve takes exactly ns, kind and name"}}
    if not NAMESPACE_PATTERN.fullmatch(request["ns"]) or not KIND_PATTERN.fullmatch(request["kind"]) \
            or not OBJECT_NAME_PATTERN.fullmatch(request["name"]):
        return {"status": 400, "body": {"error": "invalid ns, kind or name"}}
    try:
        owner = platform_scope.load_registry().owner_of(request["ns"])
        if owner is None:
            return {"status": 403, "body": {"error": "namespace is not owned by any project"}}
        # O Assistant só cria instâncias kro em platform/instances: namespace de projeto com outro
        # diretório GitOps (agent-builder, kagent) nunca é lido por este caminho.
        if owner.gitops_path != ASSISTANT_GITOPS_PATH:
            return {"status": 403, "body": {"error": "namespace belongs to a project outside platform/instances"}}
        status, body = _instance_detail({"ns": request["ns"], "kind": request["kind"], "name": request["name"]}, False)
    except platform_scope.ScopeError as error:
        return {"status": error.status, "body": {"error": error.message, "code": error.code}}
    except (ValueError, KeyError) as error:
        return {"status": 400, "body": {"error": str(error)[:200]}}
    except Exception as error:  # noqa: BLE001 - leitura falha fechada: 502, nunca "não existe"
        print(json.dumps({"event": "platform_observe_error", "error": str(error)[:300]}))
        return {"status": 502, "body": {"error": "cluster backend unavailable"}}
    print(json.dumps({"event": "platform_observe", "ns": request["ns"], "kind": request["kind"], "status": status}))
    return {"status": status, "body": body}


def _platform_ready_sweep(event: dict[str, Any]) -> dict[str, Any]:
    """Varredura interna de Ready: `{"platformReadySweep": {}}`, só por lambda:Invoke (o EventBridge
    Scheduler `appmod-cluster-api-ready-sweep`, a cada 5 min, com role que só invoca esta função; o CI
    nunca invoca Lambda, threat model do GitLabMain). Lê as instâncias vivas de todo namespace que algum
    projeto do registry possui, compara com o último estado gravado (`state#ready` na tabela de
    eventos) e grava `instance.ready` / `instance.not-ready` por transição. O planejamento é a função
    pura `platform_events.plan_ready_sweep`; aqui só leitura do cluster, leitura e escrita do estado.

    Fail-closed em três pontos: store desligado = 503; fonte do cluster parcialmente falha = 502 sem
    gravar nada (uma capability ilegível pareceria 'sumiu', e a varredura inventaria transições);
    estado anterior ilegível = 502 (sem o anterior não há transição para decidir).
    """
    request = event.get("platformReadySweep")
    if not isinstance(request, dict) or request:
        return {"status": 400, "body": {"error": "platformReadySweep takes an empty object"}}
    store = _events()
    if not store.enabled:
        return {"status": 503, "body": {"error": "events store disabled"}}
    now = int(time.time())
    try:
        registry = platform_scope.load_registry()
        capabilities, sources = _capability_index(include_ack=False)
        selected = [row for row in capabilities if row["listable"]]
        rows, sources, _, _ = _live_instance_rows(ALL_NAMESPACES, selected, sources, now)
        partial, total_failure = _degraded(sources)
        if partial or total_failure:
            failed = [source for source in sources if not source.get("ok")]
            print(json.dumps({"event": "ready_sweep_skipped", "reason": "partial", "failed": len(failed)}))
            return {"status": 502, "body": {"error": "a live source could not be read; sweep skipped", "sources": failed}}
        current: dict[str, bool] = {}
        meta: dict[str, dict[str, str]] = {}
        for row in rows:
            project = registry.owner_of(row.get("namespace") or "")
            if project is None:
                continue  # namespace fora do registry: nunca entra na trilha, como no platformObserve
            key = f"{row['kind']}/{row['namespace']}/{row['name']}"
            current[key] = bool(row.get("ready"))
            meta[key] = {"kind": row["kind"], "namespace": row["namespace"], "name": row["name"], "project": project.id,
                         "reason": str(row.get("state") or row.get("readyBasis") or "")[:120]}
        previous = store.ready_states()
        plan = platform_events.plan_ready_sweep(previous, current)
        emitted: list[dict[str, Any]] = []
        for action, keys in (("instance.ready", plan["ready"]), ("instance.not-ready", plan["notReady"])):
            for key in keys:
                m = meta[key]
                # Mesmo link das ações Day 2: eventTarget() na SPA resolve `#view` (sem query string).
                link = "/agent-platform/#cluster"
                recorded = store.record(actor=platform_events.READY_SWEEP_ACTOR, action=action, kind=m["kind"], name=m["name"],
                                        namespace=m["namespace"], project=m["project"],
                                        result="ok" if action == "instance.ready" else "failed",
                                        detail=m["reason"], link=link, source="ready-sweep", now=now)
                if recorded:
                    emitted.append({"action": action, "key": key, "id": recorded["id"]})
        for key in plan["ready"] + plan["notReady"] + plan["seed"]:
            store.write_ready_state(key, current[key], now=now)
        for key in plan["absent"]:
            store.write_ready_state(key, None, now=now)
    except platform_events.EventStoreError as error:
        print(json.dumps({"event": "ready_sweep_error", "error": str(error)[:300]}))
        return {"status": 502, "body": {"error": str(error)[:200]}}
    except Exception as error:  # noqa: BLE001 - leitura falha fechada
        print(json.dumps({"event": "ready_sweep_error", "error": str(error)[:300]}))
        return {"status": 502, "body": {"error": "cluster backend unavailable"}}
    summary = {"instances": len(current), "seeded": len(plan["seed"]), "ready": len(plan["ready"]),
               "notReady": len(plan["notReady"]), "absent": len(plan["absent"]), "events": emitted}
    print(json.dumps({"event": "ready_sweep", **{k: v for k, v in summary.items() if k != "events"}}))
    return {"status": 200, "body": summary}


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    if "platformObserve" in event and "httpMethod" not in event and "requestContext" not in event:
        return _platform_observe(event)
    if "platformReadySweep" in event and "httpMethod" not in event and "requestContext" not in event:
        return _platform_ready_sweep(event)
    headers = {str(k).lower(): v for k, v in (event.get("headers") or {}).items()}
    origin = headers.get("origin", "")
    origin = origin if origin in ALLOWED_ORIGINS else ""

    active: dict[str, Any] = {}

    def respond(status: int, body: dict[str, Any]) -> dict[str, Any]:
        # A resposta com escopo diz qual escopo o SERVIDOR aplicou, não o que o browser pediu.
        scope = active.get("scope")
        if status == 200 and scope is not None and scope.scoped and isinstance(body, dict):
            body = {**body, "scope": scope.public()}
        return _response(status, body, origin)

    method = event.get("httpMethod", "")
    path = event.get("path", "")
    if method == "OPTIONS":
        return _response(403, {"error": "origin not allowed"}) if not origin else respond(204, {})

    alias = _caller_alias(event)
    if not _alias_authorized(alias):
        rc = event.get("requestContext") or {}
        denied_arn = (rc.get("identity") or {}).get("userArn") or ""
        print(json.dumps({"event": "authz_denied", "userArn": denied_arn[:200], "parsedAlias": alias[:80]}))
        return respond(403, {"error": "caller is not an authorized platform session"})
    is_admin = alias in PLATFORM_ADMINS - {"*"}
    params = dict(event.get("queryStringParameters") or {})
    namespace = params.get("ns", "_all")
    print(json.dumps({"event": "cluster_api_request", "method": method, "path": path,
                      "ns": namespace, "project": str(params.get("project") or "")[:63],
                      "alias": alias, "admin": is_admin}))

    # Invariante I13: com a flag desligada, toda rota do builder responde 404.
    # O gate fica aqui, depois da autorização e antes do roteamento, para valer
    # igual no GET e no POST.
    builder_name, builder_tail = _agent_route(path)
    builder_route = builder_name is not None or any(
        path.endswith(suffix) for suffix in
        ("/cluster/agents", "/cluster/agent-tools", "/cluster/agent-name-check", "/cluster/agent-dry-run"))
    if builder_route and not AGENT_BUILDER_ENABLED:
        return respond(404, {"error": "agent builder disabled"})

    try:
        if method == "GET":
            scope = _request_scope(method, path, params, None, alias, is_admin, builder_route)
            active["scope"] = scope
            if scope is not None and scope.scoped and not path.endswith(_SCOPED_FILTERED) and not builder_route:
                # O namespace que segue para o API server é o que o escopo resolveu.
                if path.endswith(("/cluster/pod", "/cluster/logs", "/cluster/instance")):
                    if scope.namespace == platform_scope.ALL_NAMESPACES:
                        raise ValueError("ns is required for a single object")
                    params["ns"] = scope.namespace
                else:
                    params["ns"] = scope.single()
                namespace = params["ns"]
                active["scope"] = scope = scope.narrow(namespace)
            if path.endswith("/cluster/overview"):
                namespaces = [i["metadata"]["name"] for i in _k8s("GET", "/api/v1/namespaces").get("items", [])]
                nodes = _nodes()
                pods = _pods("_all")
                if scope is not None and scope.scoped:
                    namespaces = [name for name in namespaces if scope.allows(name)]
                    pods = [pod for pod in pods if scope.allows(pod.get("namespace"))]
                version = _k8s("GET", "/version")
                return respond(200, {
                    "version": version.get("gitVersion"),
                    "namespaces": namespaces,
                    "nodes": {"total": len(nodes), "ready": sum(1 for n in nodes if n["ready"] == "True"),
                              "spot": sum(1 for n in nodes if n["capacityType"] == "SPOT")},
                    "pods": {"total": len(pods),
                             "running": sum(1 for p in pods if p["phase"] == "Running"),
                             "pending": sum(1 for p in pods if p["phase"] == "Pending"),
                             "failed": sum(1 for p in pods if p["phase"] == "Failed")},
                })
            if path.endswith("/cluster/workloads"):
                return respond(200, _workloads(namespace))
            if path.endswith("/cluster/pods"):
                return respond(200, {"pods": _pods(namespace)})
            if path.endswith("/cluster/pod"):
                return respond(200, _pod_detail(namespace, params.get("name", "")))
            if path.endswith("/cluster/logs"):
                tail = min(int(params.get("tail", "200")), 500)
                container = params.get("container", "")
                query = f"?tailLines={tail}" + (f"&container={urllib.parse.quote(container)}" if container else "")
                logs = _k8s("GET", f"/api/v1/namespaces/{urllib.parse.quote(namespace)}/pods/{urllib.parse.quote(params.get('name', ''))}/log{query}", raw=True)
                return respond(200, {"logs": logs[-60000:]})
            if path.endswith("/cluster/services"):
                return respond(200, _services(namespace))
            if path.endswith("/cluster/config"):
                return respond(200, _config(namespace))
            if path.endswith("/cluster/nodes"):
                return respond(200, {"nodes": _nodes()})
            # Métricas (backlog cluster-metrics). Pod passa pelo escopo como /cluster/pods; node
            # fica fora dele como /cluster/nodes, porque é infraestrutura sem dado de projeto.
            if path.endswith("/cluster/pod-metrics"):
                return respond(*_pod_metrics_view(params))
            if path.endswith("/cluster/node-metrics"):
                return respond(*_node_metrics_view())
            if path.endswith("/cluster/events"):
                items = _k8s("GET", _ns_path("/api/v1", namespace, "/events")).get("items", [])
                items.sort(key=lambda e: e.get("lastTimestamp") or e.get("eventTime") or "", reverse=True)
                return respond(200, {"events": [{"namespace": e.get("metadata", {}).get("namespace"),
                                                 "reason": e.get("reason"), "type": e.get("type"),
                                                 "object": f"{e.get('involvedObject', {}).get('kind')}/{e.get('involvedObject', {}).get('name')}",
                                                 "message": (e.get("message") or "")[:300],
                                                 "count": e.get("count"), "last": e.get("lastTimestamp")}
                                                for e in items[:100]]})
            if path.endswith("/cluster/platform"):
                view = _platform_view()
                if scope is not None and scope.scoped:
                    view["instances"] = [row for row in view["instances"] if scope.allows(row.get("namespace"))]
                return respond(200, view)
            # Inventário live por capability (issue #8) e detalhe por instância
            # (issue #9). As três são leitura; o namespace é validado e entra na
            # URL do API server, e o alias já passou pelo gate acima.
            if path.endswith("/cluster/capabilities"):
                return respond(*_capabilities_view(params))
            if path.endswith("/cluster/instances"):
                return respond(*_instances_view(params))
            if path.endswith("/cluster/instance"):
                return respond(*_instance_detail(params, is_admin))
            if path.endswith("/cluster/rgd-graph"):
                return respond(*_rgd_graph_view(params))
            if path.endswith("/cluster/rgds"):
                return respond(*_rgds_view(params))
            if path.endswith("/cluster/scorecards"):
                return respond(*_scorecards_view(params))
            if path.endswith("/cluster/instance-graph"):
                return respond(*_instance_graph_view(params))
            if path.endswith("/cluster/integrations"):
                return respond(200, _integrations_view())
            if path.endswith("/cluster/agents"):
                return respond(200, _builder_agents())
            if path.endswith("/cluster/agent-tools"):
                return respond(200, _tool_inventory())
            if path.endswith("/cluster/agent-name-check"):
                candidate = str(params.get("name", ""))
                if not AGENT_NAME_PATTERN.fullmatch(candidate):
                    return respond(400, {"error": "invalid agent name"})
                return respond(200, _agent_name_state(candidate))
            if builder_name is not None:
                if not builder_tail:
                    agent = _builder_agent(builder_name)
                    if not agent:
                        return respond(404, {"error": "not a builder agent"})
                    _emit_agent_observed(agent, alias)
                    return respond(200, agent)
                if len(builder_tail) == 2 and builder_tail[0] == "a2a-test":
                    return respond(*_a2a_poll_route(builder_name, alias, is_admin, builder_tail[1]))
                return respond(404, {"error": "route not found"})
            return respond(404, {"error": "route not found"})

        if method == "POST":
            raw = event.get("body") or "{}"
            if builder_route:
                active["scope"] = _request_scope(method, path, params, None, alias, is_admin, True)
            # O teste A2A é do requester do agent, não só do admin, então estas
            # duas rotas ficam antes do gate de admin das operações de cluster.
            if builder_name is not None and builder_tail == ["a2a-test"]:
                print(json.dumps({"event": "cluster_api_a2a_test", "alias": alias, "agent": builder_name}))
                return respond(*_a2a_test_route(builder_name, alias, is_admin, raw))
            if builder_name is not None:
                return respond(404, {"error": "route not found"})
            if path.endswith("/cluster/agent-dry-run"):
                return respond(*_dry_run_route(alias, is_admin, raw))
            if not is_admin:
                return respond(403, {"error": "cluster operations require a platform admin"})
            body = json.loads(raw) if isinstance(raw, str) else raw
            if not isinstance(body, dict):
                raise ValueError("request body must be a JSON object")
            ns = str(body.get("ns", ""))
            name = str(body.get("name", ""))
            if not ns or not name:
                raise ValueError("ns and name are required")
            # Operação Day-2 só no namespace do projeto pedido, e só com papel admin nele.
            active["scope"] = _request_scope(method, path, params, body, alias, is_admin, False)
            print(json.dumps({"event": "cluster_api_write", "path": path, "alias": alias, "ns": ns, "name": name}))
            day2 = {"/cluster/scale": ("workload.scaled", str(body.get("kind", "deployment"))),
                    "/cluster/restart": ("workload.restarted", str(body.get("kind", "deployment"))),
                    "/cluster/delete-pod": ("pod.deleted", "Pod")}
            matched = next((entry for suffix, entry in day2.items() if path.endswith(suffix)), None)
            if matched is None:
                return respond(404, {"error": "route not found"})
            action, kind = matched
            project = str(params.get("project") or "")[:63]
            detail = f"replicas={int(body.get('replicas', 1))}" if action == "workload.scaled" else ""
            try:
                if action == "workload.scaled":
                    outcome = _scale(ns, kind, name, int(body.get("replicas", 1)))
                elif action == "workload.restarted":
                    outcome = _restart(ns, kind, name)
                else:
                    _k8s("DELETE", f"/api/v1/namespaces/{urllib.parse.quote(ns)}/pods/{urllib.parse.quote(name)}")
                    outcome = {"deleted": True}
            except urllib.error.HTTPError as error:
                # A ação falhou no API server: fica na trilha como `failed`, e o erro segue para o caller.
                _events().record(actor=alias, action=action, kind=kind, name=name, namespace=ns, project=project,
                                 result="failed", detail=f"{detail} http_{error.code}".strip(), link="/agent-platform/#cluster", source="cluster-api")
                raise
            _events().record(actor=alias, action=action, kind=kind, name=name, namespace=ns, project=project,
                             detail=detail, link="/agent-platform/#cluster", source="cluster-api")
            return respond(200, outcome)

        return respond(405, {"error": "method not allowed"})
    except platform_scope.ScopeError as error:
        print(json.dumps({"event": "scope_denied", "alias": alias, "path": path, "method": method,
                          "project": str(params.get("project") or "")[:63], "code": error.code,
                          "status": error.status}))
        return respond(error.status, {"error": error.message, "code": error.code})
    except (json.JSONDecodeError, ValueError, KeyError) as error:
        return respond(400, {"error": str(error)[:200]})
    except _A2AError as error:
        print(json.dumps({"event": "cluster_api_a2a_error", "detail": str(error)[:300]}))
        return respond(502, {"error": "controller returned an error", "detail": str(error)[:300]})
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:300]
        print(json.dumps({"event": "cluster_api_k8s_error", "status": error.code, "detail": detail}))
        return respond(502, {"error": f"kubernetes api returned {error.code}", "detail": detail})
    except TimeoutError:
        return respond(504, {"error": "agent did not answer in time"})
    except urllib.error.URLError as error:
        if isinstance(error.reason, TimeoutError) or "timed out" in str(error.reason).lower():
            return respond(504, {"error": "agent did not answer in time"})
        print(json.dumps({"event": "cluster_api_transport_error", "reason": str(error.reason)[:200]}))
        return respond(502, {"error": "cluster backend unavailable"})
    except Exception as error:  # noqa: BLE001 - fail closed com log, sem stack pro cliente
        print(json.dumps({"event": "cluster_api_error", "error": str(error)[:300]}))
        return respond(502, {"error": "cluster backend unavailable"})
