"""Platform API: live inventory, admin gate, user onboarding and provisioning requests.

Runs OUTSIDE any VPC (public AWS APIs: Resource Groups Tagging, Identity Store, DynamoDB).
Auth mirrors the gateway BFF: API Gateway AWS_IAM + explicit PortalInvokeRole
session-alias allowlist. Admin routes additionally require PLATFORM_ADMINS.

Provisioning requests exist because nothing in AWS can reach the GitLab API: github.com
sits behind the corporate SSO, and a Lambda has no the corporate SSO session (measured 2026-09-28: a token
without the cookie gets 302 to idp.federate, then 401 at midway-auth). The GitLab CI runner
does reach the API. So the portal records the request here, and the CI job
`open-provision-mrs` turns it into a merge request. The MR stays the review gate (ADR-0004).

Project scope (issue #10, ADR-0009): GET /platform/scope returns the organization, projects,
roles and namespaces the caller sees, decided by backend/platform_scope from the alias the internal gateway
signed. A provisioning request may carry `?project=` plus `namespace` in the body; the server
checks membership, role and lifecycle, records both, and the CI job refuses a manifest whose
metadata.namespace differs from the recorded one.

Service Owner Studio (issue #11, SERVICE_STUDIO_ENABLED): POST /platform/service-drafts/preview
validates and compiles a ServiceDraft with no side effect; POST /platform/provision-requests with
`kind: service-capability` records the reviewed draft and its hash. The CI recompiles and opens the
MR. Authorization is the owner team (SERVICE_OWNER_TEAMS), never the browser.

Platform Assistant (issue #12, PLATFORM_ASSISTANT_ENABLED): /platform/assistant/* is the transport
of backend/platform_assistant, with the project contract of #10. The model never runs here (the
gateway is only reachable from the BFF); this Lambda validates a proposed plan, records provision
requests and plan runs, and reads the live object through the cluster-api by lambda:Invoke.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

# Núcleo do Agent Builder (backend/agent_builder). No bundle da Lambda ele fica ao lado deste
# arquivo; no repo, um nível acima. Mesmo código que o CI usa para recompilar, então o preview
# que o usuário aprova e o manifest que vai para o Git não podem divergir (invariante I2).
try:
    import agent_builder
except ImportError:  # pragma: no cover - caminho do repo, exercitado pelos testes
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import agent_builder

# Escopo de projeto (backend/platform_scope): mesmo pacote que a cluster-api importa.
try:
    import platform_scope
except ImportError:  # pragma: no cover - caminho do repo, exercitado pelos testes
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import platform_scope

# Service Owner Studio (issue #11) e Platform Assistant (issue #12): núcleos stdlib, empacotados ao
# lado deste arquivo pelo build.sh. Nenhum dos dois escreve no Git nem no cluster: o que eles gravam
# é um pedido nesta tabela, que o CI `open-provision-mrs` transforma em MR.
try:
    import platform_assistant
    import service_studio
except ImportError:  # pragma: no cover - caminho do repo, exercitado pelos testes
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import platform_assistant
    import service_studio
# Trilha de eventos (notifications-center e audit-log): backend/platform_events, no bundle.
# Identidade do caller (backstage-killer 2b): backend/platform_identity, modos iam e jwt.
try:
    import platform_events
    import platform_identity
except ImportError:  # pragma: no cover - mesmo fallback dos pacotes acima
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import platform_events
    import platform_identity
from botocore.config import Config  # noqa: E402

EXPECTED_ROLE = os.environ.get("EXPECTED_ROLE", "PortalInvokeRole")
EXPECTED_ACCOUNT = os.environ.get("EXPECTED_ACCOUNT", "111122223333")
AUTHORIZED_ALIASES = {a.strip() for a in os.environ.get("AUTHORIZED_ALIASES", "").split(",") if a.strip()}
PLATFORM_ADMINS = {a.strip() for a in os.environ.get("PLATFORM_ADMINS", "").split(",") if a.strip()}
ALLOWED_ORIGINS = {o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()}
IDENTITY_STORE_ID = os.environ.get("IDENTITY_STORE_ID", "")
VIEWER_GROUP_ID = os.environ.get("VIEWER_GROUP_ID", "")
PROVISION_TABLE = os.environ.get("PROVISION_TABLE", "")
# Trilha de eventos (notifications-center e audit-log). Vazio = store desligado: produtores não
# gravam, e as rotas de leitura respondem 503 nomeado, nunca lista vazia.
EVENTS_TABLE = os.environ.get("EVENTS_TABLE", "")
# Agent Builder (docs/agent-platform/design-agent-builder.md, seção 5). Desligado, as rotas novas e
# o kind kagent-agent respondem 404 (invariante I13).
AGENT_BUILDER_ENABLED = os.environ.get("AGENT_BUILDER_ENABLED", "false").strip().lower() == "true"
AGENT_KIND = "kagent-agent"
# Feature flags das issues #11 e #12, no mesmo contrato do Agent Builder: desligado, toda rota nova
# responde 404 e o kind service-capability é recusado antes de gravar qualquer coisa.
SERVICE_STUDIO_ENABLED = os.environ.get("SERVICE_STUDIO_ENABLED", "false").strip().lower() == "true"
PLATFORM_ASSISTANT_ENABLED = os.environ.get("PLATFORM_ASSISTANT_ENABLED", "false").strip().lower() == "true"
COMPOSABLE_DASHBOARD_ENABLED = os.environ.get("COMPOSABLE_DASHBOARD_ENABLED", "false").strip().lower() == "true"
# {"<team>": ["alias", ...]}: quem é Service Owner de qual time. Ilegível ou vazio nega todos menos admin.
SERVICE_OWNER_TEAMS = os.environ.get("SERVICE_OWNER_TEAMS", "")
# A cluster-api roda na VPC do cluster e esta Lambda não. O observer do Assistant a chama por
# lambda:Invoke com um evento interno de leitura (ver backend/cluster_api, `platformObserve`).
CLUSTER_API_FUNCTION = os.environ.get("CLUSTER_API_FUNCTION", "")
MAX_BODY_BYTES = 32_768

_tagging = boto3.client("resourcegroupstaggingapi")
_identity = boto3.client("identitystore")
_dynamodb = boto3.client("dynamodb")
_events = platform_events.EventStore(_dynamodb, EVENTS_TABLE)
# Os buckets do GP-A vivem em sa-east-1; a Lambda também, mas fixar evita redirect 301 se mudar.
_s3 = boto3.client("s3", region_name="sa-east-1")
# Leitura curta e sem retry longo: o handler tem 29 s e o preview observa até seis passos.
_lambda = boto3.client("lambda", config=Config(connect_timeout=3, read_timeout=8, retries={"max_attempts": 1}))
# GenerateMac é uma chamada curta; o rollback sem prova fica `undo_blocked` e o próximo refresh tenta.
_kms = boto3.client("kms", config=Config(connect_timeout=3, read_timeout=5, retries={"max_attempts": 2}))

# A Kubernetes object name (DNS-1123 label). It is the ONLY input that shapes the Git path,
# so the path can never be steered by the manifest body.
NAME_PATTERN = r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
REQUEST_ID_PATTERN = r"[0-9a-f]{32}"
MAX_MANIFEST_BYTES = 32_768
REQUEST_TTL_SECONDS = 30 * 24 * 3600
PROVISION_PATHS = {"infra": "platform/instances/{name}.yaml", "agent": "docs/agent-definitions/{name}.json"}
INFRA_DIRECTORY = PROVISION_PATHS["infra"].rsplit("/", 1)[0]



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

def _response(status: int, body: dict[str, Any], origin: str = "") -> dict[str, Any]:
    headers = {"Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    if origin:
        headers.update({
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Headers": "authorization,content-type,x-amz-date,x-amz-security-token,x-amz-content-sha256",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Vary": "Origin",
        })
    return {"statusCode": status, "headers": headers, "body": json.dumps(body)}


def _origin(event: dict[str, Any]) -> str:
    headers = {str(k).lower(): v for k, v in (event.get("headers") or {}).items()}
    origin = headers.get("origin", "")
    return origin if origin in ALLOWED_ORIGINS else ""


def _caller_alias(event: dict[str, Any]) -> str:
    """Alias do caller pelo adapter de identidade (backend/platform_identity): IAM/the internal gateway no modo
    interno, authorizer JWT (Cognito/OIDC) no sample público. Vazio = 403 abaixo."""
    return platform_identity.caller_alias(event)


MAX_RESOURCE_PAGES = 20  # 2.000 ARNs; the GP-B ECS ackGap alone left ~1.300 TaskDefinition revisions


def _list_platform_resources() -> tuple[list[dict[str, Any]], bool]:
    """Return (resources, truncated). truncated=True means the page cap cut the listing."""
    resources: list[dict[str, Any]] = []
    token = ""
    for _ in range(MAX_RESOURCE_PAGES):
        kwargs: dict[str, Any] = {"TagFilters": [{"Key": "ManagedBy", "Values": ["KRO-ACK"]}], "ResourcesPerPage": 100}
        if token:
            kwargs["PaginationToken"] = token
        page = _tagging.get_resources(**kwargs)
        for item in page.get("ResourceTagMappingList", []):
            arn = item["ResourceARN"]
            tags = {t["Key"]: t["Value"] for t in item.get("Tags", [])}
            service = arn.split(":")[2]
            resources.append({
                "arn": arn,
                "service": service,
                "name": arn.split("/")[-1] if "/" in arn else arn.split(":")[-1],
                "environment": tags.get("Environment", ""),
                "capability": tags.get("platform:capability", ""),
                "retained": tags.get("auto-delete", "") == "no",
            })
        token = page.get("PaginationToken", "")
        if not token:
            break
    resources.sort(key=lambda r: (r["service"], r["name"]))
    return resources, bool(token)


def _onboard(body: dict[str, Any]) -> dict[str, Any]:
    alias = str(body.get("alias", "")).strip().lower()
    given = str(body.get("givenName", "")).strip()
    family = str(body.get("familyName", "")).strip()
    if not re.fullmatch(r"[a-z][a-z0-9]{1,30}", alias):
        raise ValueError("alias must be a lowercase Amazon alias")
    if not given or not family:
        raise ValueError("givenName and familyName are required")
    email = f"{alias}@amazon.com"
    existing = _identity.list_users(
        IdentityStoreId=IDENTITY_STORE_ID,
        Filters=[{"AttributePath": "UserName", "AttributeValue": alias}],
    ).get("Users", [])
    if existing:
        user_id, created = existing[0]["UserId"], False
    else:
        user_id = _identity.create_user(
            IdentityStoreId=IDENTITY_STORE_ID,
            UserName=alias,
            DisplayName=f"{given} {family}",
            Name={"GivenName": given, "FamilyName": family},
            Emails=[{"Value": email, "Type": "work", "Primary": True}],
        )["UserId"]
        created = True
    memberships = _identity.list_group_memberships_for_member(
        IdentityStoreId=IDENTITY_STORE_ID, MemberId={"UserId": user_id},
    ).get("GroupMemberships", [])
    in_group = any(m.get("GroupId") == VIEWER_GROUP_ID for m in memberships)
    if not in_group:
        _identity.create_group_membership(
            IdentityStoreId=IDENTITY_STORE_ID, GroupId=VIEWER_GROUP_ID, MemberId={"UserId": user_id},
        )
    return {"alias": alias, "userId": user_id, "userCreated": created, "addedToViewers": not in_group}


# ------------------------------------------------------------------ template do tour
# Cópia de scripts/tour_template.py (tests/test_tour_template.py prova que as duas geram o mesmo
# texto). A Lambda empacota um arquivo só, por isso a cópia em vez de import.
# O mesmo alias do onboarding. Sem hífen, então nunca um nome terminado em "-". O limite de 31
# caracteres fecha os nomes da AWS: bucket <= 56 (limite 63), OAC <= 60 (64), headers <= 73 (128).
_TOUR_ALIAS = re.compile(r"[a-z][a-z0-9]{1,30}")
_TOUR_TTL_SECONDS = 24 * 3600
_TOUR_ACCOUNT_ID = "111122223333"


def _tour_manifest(alias: str, created_at: int) -> str:
    if not _TOUR_ALIAS.fullmatch(alias or ""):
        raise ValueError("alias does not fit a DNS label for the tour (a-z, 0-9, 2 to 31 chars, starting with a letter)")
    expires = datetime.fromtimestamp(int(created_at) + _TOUR_TTL_SECONDS, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        "apiVersion: kro.run/v1alpha1\n"
        "kind: StaticWebApp\n"
        "metadata:\n"
        f"  name: tour-{alias}\n"
        "  namespace: appmod\n"
        "  labels:\n"
        f"    platform.appmod/owner: {alias}\n"
        '    platform.appmod/tour: "true"\n'
        "spec:\n"
        f"  name: appmod-tour-{alias}-{_TOUR_ACCOUNT_ID}\n"
        "  environment: lab\n"
        f"  owner: {alias}\n"
        "  lifecycle: ephemeral\n"
        "  deletionPolicy: delete\n"
        f'  expiresAt: "{expires}"\n'
    )


def _live_tour(alias: str) -> dict[str, Any] | None:
    """O pedido de tour do alias que ainda não fechou. A tabela é pequena (pedidos expiram em 30
    dias), então Scan basta. A tarefa 7 fecha o pedido quando o reaper remove o site."""
    kwargs: dict[str, Any] = {
        "TableName": PROVISION_TABLE,
        "FilterExpression": "requester = :a AND #n = :n AND NOT (#s IN (:closed, :failed))",
        "ExpressionAttributeNames": {"#n": "name", "#s": "status"},
        "ExpressionAttributeValues": {":a": {"S": alias}, ":n": {"S": f"tour-{alias}"},
                                      ":closed": {"S": "closed"}, ":failed": {"S": "failed"}},
    }
    while True:
        page = _dynamodb.scan(**kwargs)
        if page.get("Items"):
            return page["Items"][0]
        if "LastEvaluatedKey" not in page:
            return None
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _create_tour_request(alias: str) -> tuple[int, dict[str, Any]]:
    """O manifest do tour é gerado aqui, nunca no cliente: o bot só mergeia se o arquivo for byte a
    byte _tour_manifest(requester, createdAt), e só o servidor conhece o createdAt que gravou."""
    if not _TOUR_ALIAS.fullmatch(alias):
        raise ValueError("your alias does not fit a DNS label (letters and digits only, 2 to 31 chars), "
                         "so a tour site cannot be named after it")
    live = _live_tour(alias)
    if live:
        return 200, {"requestId": live["requestId"]["S"], "status": live["status"]["S"],
                     "path": live["path"]["S"], "existing": True}
    request_id, now = uuid.uuid4().hex, int(time.time())
    name, path = f"tour-{alias}", PROVISION_PATHS["infra"].format(name=f"tour-{alias}")
    _dynamodb.put_item(
        TableName=PROVISION_TABLE,
        Item={
            "requestId": {"S": request_id}, "status": {"S": "pending"}, "requester": {"S": alias},
            "kind": {"S": "infra"}, "name": {"S": name}, "capability": {"S": "frontend/static-web-app (tour)"},
            "path": {"S": path}, "manifest": {"S": _tour_manifest(alias, now)}, "tour": {"BOOL": True},
            "createdAt": {"N": str(now)}, "expiresAt": {"N": str(now + REQUEST_TTL_SECONDS)},
        },
        ConditionExpression="attribute_not_exists(requestId)",
    )
    print(json.dumps({"event": "tour_request_created", "requestId": request_id, "alias": alias}))
    _events.record(actor=alias, action="provision.requested", kind="ProvisionRequest", name=name, namespace="appmod",
                   project="agent-platform", detail=f"tour {name}: {path}", link="/agent-platform/#getting-started", source="platform-api")
    return 201, {"requestId": request_id, "status": "pending", "path": path}


def _tour_page(alias: str) -> list[tuple[str, bytes, str]]:
    # Sem inline: a CSP do GP-A é default-src 'self'. Alias já casou _TOUR_ALIAS, não precisa escape.
    html = f"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site de {alias}</title>
<link rel="stylesheet" href="/tour.css">
</head>
<body>
<main>
<h1>Olá, {alias}. Este site é seu.</h1>
<p>Você pediu pelo portal e a plataforma fez o resto: um merge request validado, o mirror GitOps,
o Argo CD, o kro e o ACK criaram um bucket S3 privado e uma distribuição CloudFront com HSTS e CSP.</p>
<p>Ninguém abriu o console da AWS. Amanhã este site é removido pelo mesmo caminho.</p>
</main>
</body>
</html>
"""
    css = ("body{font-family:system-ui,sans-serif;margin:0;background:#0f141a;color:#e9ebed}"
           "main{max-width:40rem;margin:12vh auto;padding:0 1.5rem;line-height:1.6}"
           "h1{color:#ff9900;line-height:1.2}\n")
    return [("index.html", html.encode(), "text/html; charset=utf-8"), ("tour.css", css.encode(), "text/css; charset=utf-8")]


def _publish_tour(alias: str, request_id: str) -> tuple[int, dict[str, Any]]:
    item = _dynamodb.get_item(TableName=PROVISION_TABLE, Key={"requestId": {"S": request_id}}, ConsistentRead=True).get("Item")
    # Só o dono, nem o admin: a página diz o nome dele. De outro, responde como ausente.
    if not item or item["requester"]["S"] != alias:
        return 404, {"error": "provision request not found"}
    if item["name"]["S"] != f"tour-{alias}" or not _TOUR_ALIAS.fullmatch(alias):
        raise ValueError("only a tour request can be published")
    bucket = f"appmod-tour-{alias}-{EXPECTED_ACCOUNT}"  # derivado do alias, nunca de um campo do pedido
    written, existing = [], []
    for key, body, content_type in _tour_page(alias):
        try:
            _s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type, IfNoneMatch="*")
            written.append(key)
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "")
            if code == "PreconditionFailed":
                existing.append(key)
            elif code == "NoSuchBucket":
                return 409, {"error": "your site is not ready yet; try again when CloudFront shows Deployed"}
            else:
                raise
    print(json.dumps({"event": "tour_published", "requestId": request_id, "alias": alias, "written": written}))
    return 200, {"published": bool(written), "written": written, "alreadyPublished": existing}


def _provision_scope(alias: str, is_admin: bool, project: Any, namespace: Any) -> platform_scope.Scope:
    """Scope of a write: contributor in an active project, inside one of its namespaces."""
    registry = platform_scope.load_registry()
    return platform_scope.resolve(registry, alias, is_admin, project, namespace, platform_scope.ACTION_PROPOSE)


PROMOTED_FROM_PATTERN = re.compile(r"^([a-z][a-z0-9-]{0,62})/([a-z][a-z0-9-]{0,62})/([a-z][a-z0-9-]{0,62})$")


def _promotion_source(body: dict[str, Any], scope: platform_scope.Scope | None) -> str:
    """`promotedFrom` = `project/namespace/name` da instância de origem (environments-promotion).

    Só vale num pedido de infra COM escopo, e só quando o projeto do escopo é exatamente o
    `promotesTo` do projeto de origem no registry: a cadeia de ambientes é decidida em Git, nunca pelo
    browser. Origem fora do registry, namespace fora do projeto de origem ou alvo errado recusam o
    pedido antes de gravar qualquer coisa. Sem o campo, pedido comum.
    """
    raw = body.get("promotedFrom")
    if raw is None:
        return ""
    match = PROMOTED_FROM_PATTERN.fullmatch(str(raw))
    if not match:
        raise ValueError("promotedFrom must be project/namespace/name")
    if scope is None or not scope.scoped:
        raise ValueError("promotedFrom requires a project scope")
    source_project, source_ns, _source_name = match.groups()
    registry = platform_scope.load_registry()
    source = registry.project(source_project)
    if source is None or source_ns not in source.namespaces:
        raise platform_scope.ScopeError("promotion source is not a project namespace", "promotion_source_unknown", 403)
    if source.promotes_to != scope.project:
        raise platform_scope.ScopeError(
            f"project {source_project} promotes to {source.promotes_to or 'nothing'}, not {scope.project}",
            "promotion_target_mismatch", 403)
    return match.group(0)


def _create_provision_request(alias: str, body: dict[str, Any],
                              scope: platform_scope.Scope | None = None) -> dict[str, Any]:
    """Record a request for the CI job to open as an MR. Validation here is structural only:
    the Lambda ships without PyYAML, so the CI job parses the manifest before writing to Git."""
    kind = str(body.get("kind", ""))
    if kind not in PROVISION_PATHS:
        raise ValueError("kind must be 'infra' or 'agent'")
    name = str(body.get("name", "")).strip()
    if not re.fullmatch(NAME_PATTERN, name):
        raise ValueError("name must be a lowercase DNS label (a-z, 0-9, '-', up to 63 chars)")
    manifest = body.get("manifest")
    if not isinstance(manifest, str) or not manifest.strip():
        raise ValueError("manifest is required")
    if len(manifest.encode("utf-8")) > MAX_MANIFEST_BYTES:
        raise ValueError(f"manifest exceeds {MAX_MANIFEST_BYTES} bytes")
    capability = str(body.get("capability", "")).strip()[:120]
    request_id = uuid.uuid4().hex
    now = int(time.time())
    path = PROVISION_PATHS[kind].format(name=name)
    item = {
        "requestId": {"S": request_id},
        "status": {"S": "pending"},
        "requester": {"S": alias},
        "kind": {"S": kind},
        "name": {"S": name},
        "capability": {"S": capability or "-"},
        "path": {"S": path},
        "manifest": {"S": manifest},
        "createdAt": {"N": str(now)},
        "expiresAt": {"N": str(now + REQUEST_TTL_SECONDS)},
    }
    scoped = scope is not None and scope.scoped
    if scoped:
        if kind != "infra":
            raise ValueError("project scope applies to infra requests only")
        project = platform_scope.load_registry().project(scope.project or "")
        # Path allowlist, first layer (the CI is the second): an infra request is a kro instance and
        # lands ONLY in platform/instances, the directory the instances Application applies. A
        # project whose GitOps directory is another one (agent-builder writes platform/agents)
        # cannot receive an infra file, so the request is refused before anything is recorded.
        if project is None or project.gitops_path != INFRA_DIRECTORY:
            raise platform_scope.ScopeError(
                f"infra requests write {INFRA_DIRECTORY}; project {scope.project} uses "
                f"{project.gitops_path if project else 'no directory'}", "project_not_supported", 403)
        path = PROVISION_PATHS["infra"].format(name=name)
        item["path"] = {"S": path}
        item["project"] = {"S": scope.project or ""}
        item["namespace"] = {"S": scope.namespace}
    promoted_from = _promotion_source(body, scope)
    if promoted_from:
        item["promotedFrom"] = {"S": promoted_from}
    _dynamodb.put_item(TableName=PROVISION_TABLE, Item=item, ConditionExpression="attribute_not_exists(requestId)")
    print(json.dumps({"event": "provision_request_created", "requestId": request_id, "alias": alias, "kind": kind,
                      "path": path, "project": scope.project if scoped else "", "promotedFrom": promoted_from}))
    if promoted_from:
        # Promoção entre ambientes: a trilha diz de onde veio; o `provision.*` do MR segue vindo do CI.
        _events.record(actor=alias, action="promotion.requested", kind="ProvisionRequest", name=name,
                       namespace=scope.namespace, project=scope.project or "",
                       detail=f"from {promoted_from} to {scope.project}/{scope.namespace}/{name}",
                       link="/agent-platform/#provision", source="platform-api")
    else:
        _events.record(actor=alias, action="provision.requested", kind="ProvisionRequest", name=name,
                       namespace=scope.namespace if scoped else "", project=scope.project if scoped else "",
                       detail=f"{kind} {name}: {path}", link="/agent-platform/#provision", source="platform-api")
    response = {"requestId": request_id, "status": "pending", "path": path}
    if scoped:
        response["scope"] = scope.public()
    return response


def _get_provision_request(alias: str, is_admin: bool, request_id: str) -> dict[str, Any] | None:
    item = _dynamodb.get_item(TableName=PROVISION_TABLE, Key={"requestId": {"S": request_id}}, ConsistentRead=True).get("Item")
    # Someone else's request answers exactly like a missing one, so ids cannot be probed.
    if not item or (item["requester"]["S"] != alias and not is_admin):
        return None
    text = lambda key: item.get(key, {}).get("S", "")
    found = {
        "requestId": request_id, "status": text("status"), "path": text("path"), "kind": text("kind"),
        "name": text("name"), "mrUrl": text("mrUrl"), "error": text("error"),
        "createdAt": int(item["createdAt"]["N"]),
    }
    if text("project"):
        found.update({"project": text("project"), "namespace": text("namespace")})
    # Quando o sweep do CI leu o MR pela última vez. A platform-api não fala com o GitLab, então o
    # status gravado é a última leitura do runner; a idade vem calculada AQUI para o portal não
    # depender do relógio do browser. null = nunca confirmado (pedido antigo ou ainda sem MR).
    checked = item.get("statusCheckedAt", {}).get("N")
    found["statusCheckedAt"] = int(checked) if checked else None
    found["statusAgeSeconds"] = max(0, int(time.time()) - int(checked)) if checked else None
    if found["kind"] == AGENT_KIND:
        merged = item.get("mergedAt", {}).get("N")
        found.update({"op": text("op"), "draftSha256": text("draftSha256") or None,
                      "mergedAt": int(merged) if merged else None})
    elif found["kind"] == service_studio.KIND:
        found.update({"op": text("op"), "draftSha256": text("draftSha256") or None})
    return found


# ------------------------------------------------------------------ Agent Builder (5.2 e 5.3)
def _issues(issues: Any) -> list[dict[str, Any]]:
    return [issue.as_dict() for issue in issues]


def _draft_rejected(request_id: str, alias: str, errors: Any, op: str = "") -> None:
    first = errors[0] if errors else None
    signal = {"event": "agent_builder_draft_rejected", "request_id": request_id, "caller_alias": alias,
              "error_count": len(errors), "first_error_path": first.path if first else "",
              "first_error_code": first.code if first else ""}
    if op:
        signal["op"] = op
    print(json.dumps(signal))


def _preview_agent_draft(alias: str, is_admin: bool, body: dict[str, Any], api_request_id: str = "") -> dict[str, Any]:
    """Valida e compila sem efeito colateral. Mesmo draft e mesmo alias: mesmos bytes."""
    if set(body) != {"draft"}:
        raise ValueError("send exactly one field: draft")
    draft = body["draft"]
    validation = agent_builder.validate_draft(draft, caller_is_admin=is_admin)
    if not validation.valid:
        _draft_rejected(api_request_id, alias, validation.errors)
        return {"valid": False, "errors": _issues(validation.errors), "warnings": [], "manifest": None}
    normalized = agent_builder.normalize_draft(draft)
    manifest = agent_builder.compile_manifest(normalized, alias, agent_builder.PREVIEW_REQUEST_ID)
    constants = agent_builder.fixed()
    print(json.dumps({"event": "agent_builder_preview_rendered", "request_id": api_request_id, "caller_alias": alias,
                      "draft_sha256": agent_builder.draft_sha256(normalized), "manifest_bytes": len(manifest),
                      "tool_count": len(normalized.get("tools") or []), "name": normalized["name"],
                      "language": normalized["language"]}))
    return {
        "valid": True, "errors": [], "warnings": _issues(validation.warnings),
        "manifest": manifest.decode("utf-8"), "path": agent_builder.git_path(normalized["name"]),
        "draftSha256": agent_builder.draft_sha256(normalized), "compiler": agent_builder.COMPILER,
        "summary": {"name": normalized["name"], "namespace": constants["namespace"],
                    "modelConfig": constants["modelConfig"], "language": normalized["language"],
                    "tools": list(normalized.get("tools") or [])},
    }


def _create_agent_request(alias: str, is_admin: bool, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """Pedido kagent-agent. O manifest é calculado aqui e o CI recompila e compara (I2); o requester
    é o alias da sessão (I8). O create-only, os limites e o dono do disable são do CI, que lê a main."""
    if "manifest" in body:
        raise ValueError("manifest is computed by the server for kagent-agent")
    op = body.get("op")
    if op not in agent_builder.OPS:
        raise ValueError("op must be 'create' or 'disable'")
    request_id, now = uuid.uuid4().hex, int(time.time())
    item: dict[str, Any] = {
        "requestId": {"S": request_id}, "status": {"S": "pending"}, "requester": {"S": alias},
        "kind": {"S": AGENT_KIND}, "op": {"S": op}, "compiler": {"S": agent_builder.COMPILER},
        "isAdmin": {"BOOL": is_admin}, "capability": {"S": "agent/kagent-declarative"},
        "createdAt": {"N": str(now)}, "expiresAt": {"N": str(now + REQUEST_TTL_SECONDS)},
    }
    response: dict[str, Any] = {"requestId": request_id, "status": "pending", "kind": AGENT_KIND, "op": op}
    if op == agent_builder.OP_CREATE:
        if set(body) - {"kind", "op", "draft"}:
            raise ValueError("create accepts only kind, op and draft")
        try:
            plan = agent_builder.plan_create(body.get("draft"), alias, request_id, caller_is_admin=is_admin)
        except agent_builder.ScaffoldRefused:
            validation = agent_builder.validate_draft(body.get("draft"), caller_is_admin=is_admin)
            _draft_rejected(request_id, alias, validation.errors, op)
            return 422, {"error": "draft invalid", "errors": _issues(validation.errors)}
        normalized = agent_builder.normalize_draft(body["draft"])
        item.update({
            "name": {"S": plan.name}, "path": {"S": plan.path}, "manifest": {"S": plan.manifest.decode("utf-8")},
            "draft": {"S": agent_builder.canonical_bytes(normalized).decode("utf-8")},
            "draftSha256": {"S": plan.draft_sha256 or ""},
        })
        response.update({"path": plan.path, "draftSha256": plan.draft_sha256})
    else:
        if set(body) - {"kind", "op", "name"}:
            raise ValueError("disable accepts only kind, op and name")
        try:
            name = agent_builder.assert_safe_name(body.get("name"))
        except agent_builder.UnsafeName as error:
            raise ValueError(f"name is not a builder agent name: {error}") from error
        path = agent_builder.git_path(name)
        item.update({"name": {"S": name}, "path": {"S": path}})
        response["path"] = path
    _dynamodb.put_item(TableName=PROVISION_TABLE, Item=item, ConditionExpression="attribute_not_exists(requestId)")
    print(json.dumps({"event": "agent_builder_request_created", "request_id": request_id, "caller_alias": alias,
                      "op": op, "name": item["name"]["S"], "draft_sha256": response.get("draftSha256") or "",
                      "admin": is_admin}))
    return 201, response


def _agent_body(event: dict[str, Any]) -> dict[str, Any]:
    """Corpo das rotas do builder: objeto JSON de até 32 KB (design, seção 5)."""
    raw = event.get("body") or "{}"
    if isinstance(raw, str) and len(raw.encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError(f"request body exceeds {MAX_BODY_BYTES} bytes")
    body = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(body, dict):
        raise ValueError("request body must be a JSON object")
    return body


# ------------------------------------------------------------------ Service Owner Studio (issue #11)
def _studio_preview(alias: str, is_admin: bool, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """Valida, autoriza pelo owner team e compila sem efeito colateral. 200 `invalid` e 403
    `unauthorized` são respostas que a UI mostra, não falhas."""
    status, response = service_studio.preview(body, alias=alias, is_admin=is_admin,
                                              teams=service_studio.parse_teams(SERVICE_OWNER_TEAMS),
                                              compositions=service_studio.load_compositions())
    print(json.dumps({"event": "service_studio_preview", "alias": alias, "status": status,
                      "state": response.get("state"), "draftSha256": response.get("draftSha256") or ""}))
    return status, response


def _studio_request(alias: str, is_admin: bool, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """Grava o pedido `service-capability`. O servidor guarda o draft normalizado e o hash que o
    usuário aprovou; o CI recompila, reconfere o owner na main e abre o MR. Nada é compilado no browser."""
    request_id, now = uuid.uuid4().hex, int(time.time())
    status, response, item = service_studio.request_item(
        body, alias=alias, is_admin=is_admin, teams=service_studio.parse_teams(SERVICE_OWNER_TEAMS),
        compositions=service_studio.load_compositions(), request_id=request_id, now=now)
    if item is not None:
        _dynamodb.put_item(TableName=PROVISION_TABLE, Item=item, ConditionExpression="attribute_not_exists(requestId)")
    print(json.dumps({"event": "service_studio_request", "alias": alias, "status": status, "requestId": request_id if item else "",
                      "op": str(body.get("op", ""))[:16], "path": response.get("path", "")}))
    return status, response


# ------------------------------------------------------------------ Platform Assistant (issue #12)
def _cluster_observe(params: dict[str, str]) -> tuple[int, Any]:
    """Transporte do `ClusterApiObserver`: lambda:Invoke na cluster-api com o evento interno de
    leitura. Qualquer falha de transporte é ObservationUnavailable, nunca "o objeto não existe"."""
    if not CLUSTER_API_FUNCTION:
        raise platform_assistant.ObservationUnavailable("cluster-api function is not configured in this deployment")
    try:
        answer = _lambda.invoke(FunctionName=CLUSTER_API_FUNCTION, InvocationType="RequestResponse",
                                Payload=json.dumps({"platformObserve": params}).encode("utf-8"))
        if answer.get("FunctionError"):
            raise platform_assistant.ObservationUnavailable("cluster-api raised while observing")
        payload = json.loads(answer["Payload"].read() or b"{}")
    except (BotoCoreError, ClientError, json.JSONDecodeError, KeyError) as error:
        raise platform_assistant.ObservationUnavailable(f"cluster-api unreachable: {type(error).__name__}") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("status"), int):
        raise platform_assistant.ObservationUnavailable("cluster-api answered an unexpected shape")
    return payload["status"], payload.get("body")


def _is_admin(alias: str) -> bool:
    return alias in PLATFORM_ADMINS - {"*"}


def _assistant_service() -> platform_assistant.AssistantService:
    """Um serviço por request. O diretório de projetos decide admin por ALIAS (PLATFORM_ADMINS), não
    pela sessão: a reautorização no write olha o requester do plano e quem confirmou o rollback, e
    um caller admin não pode fazer outra pessoa parecer admin. Sem modelo aqui: o gateway só é
    alcançável pelo BFF, que propõe o plano; esta Lambda valida, grava e acompanha."""
    return platform_assistant.AssistantService(
        plans=platform_assistant.DynamoPlanStore(_dynamodb, PROVISION_TABLE),
        requests=platform_assistant.DynamoRequestStore(_dynamodb, PROVISION_TABLE),
        observer=platform_assistant.ClusterApiObserver(_cluster_observe),
        projects=platform_assistant.ScopeProjects(platform_scope.load_registry(), _is_admin, platform_scope.role_for),
        # Chave KMS HMAC_256 da aprovação de rollback (platform/platform-api/main.tf, env
        # ASSISTANT_REMOVAL_KEY_ID). Esta Lambda é a ÚNICA principal com kms:GenerateMac nela; o CI
        # só verifica. Sem a variável, nenhum rollback grava pedido (fica `undo_blocked`).
        approver=platform_assistant.KmsMac(_kms, os.environ.get(platform_assistant.approval.KEY_ENV, "")).generate,
    )


_PLAN_ACTIONS = {"submit": "plan.submitted", "retry": "plan.retried", "compensation_confirm": "plan.compensated"}


def _record_plan_event(alias: str, method: str, path: str, status: int, body: dict[str, Any]) -> None:
    """Evento de plano do Assistant: só nas escritas (submit, retry, compensação), com o resultado
    HTTP. Lê o planId da resposta ou do path; nunca grava o plano em si."""
    if method != "POST":
        return
    operation = ""
    if path.endswith("/plans"):
        operation = "submit"
    elif path.endswith("/retry"):
        operation = "retry"
    elif path.endswith("/compensation"):
        operation = "compensation_confirm"
    action = _PLAN_ACTIONS.get(operation)
    if not action:
        return
    run = body.get("run") if isinstance(body, dict) else None
    run = run if isinstance(run, dict) else {}
    plan_id = str(run.get("planId") or "")
    if not plan_id:
        match = re.search(rf"/plans/({REQUEST_ID_PATTERN})", path)
        plan_id = match.group(1) if match else ""
    result = "ok" if status < 400 else ("denied" if status in (401, 403) else "failed")
    detail = str(run.get("state") or (body.get("error") if isinstance(body, dict) else "") or "")[:120]
    _events.record(actor=alias, action=action, kind="Plan", name=plan_id or "unknown", project=str(run.get("project") or ""),
                   result=result, detail=detail, link=f"/agent-platform/#assistant/{plan_id}" if plan_id else "/agent-platform/#assistant",
                   source="platform-api")


def _visible_project_ids(alias: str, is_admin: bool) -> list[str]:
    registry = platform_scope.load_registry()
    return [project.id for project, _role in platform_scope.visible_projects(registry, alias, is_admin)]


def _events_view(alias: str, is_admin: bool, params: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /platform/events: trilha geral (admin) ou restrita aos projetos visíveis e ao próprio ator.
    Filtros: actor (admin), action, result, object=<kind>/<ns>/<name>, limit."""
    if not _events.enabled:
        return 503, {"error": "events store disabled in this deployment"}
    try:
        limit = max(1, min(int(params.get("limit") or 100), platform_events.LIST_MAX))
    except ValueError as error:
        raise ValueError("invalid limit") from error
    object_ref = str(params.get("object") or "").strip()
    try:
        if object_ref:
            parts = object_ref.split("/")
            if len(parts) != 3:
                raise ValueError("object must be kind/namespace/name")
            items = _events.object_trail(parts[0], parts[1], parts[2], limit=limit)
            if not is_admin:
                visible = set(_visible_project_ids(alias, is_admin))
                items = [row for row in items if row["project"] in visible or row["actor"] == alias]
        else:
            actor = str(params.get("actor") or "").strip()[:64]
            items = _events.list_events(limit=limit, actor=actor if is_admin else alias,
                                        action=str(params.get("action") or "").strip()[:40],
                                        result=str(params.get("result") or "").strip()[:10],
                                        projects=None if is_admin else _visible_project_ids(alias, is_admin))
    except platform_events.EventStoreError as error:
        return 502, {"error": str(error)}
    return 200, {"items": items, "count": len(items), "scope": "all" if is_admin else "mine", "readAt": int(time.time())}


def _notifications_view(alias: str, is_admin: bool) -> tuple[int, dict[str, Any]]:
    if not _events.enabled:
        return 503, {"error": "events store disabled in this deployment"}
    try:
        box = _events.notifications(alias, _visible_project_ids(alias, is_admin))
    except platform_events.EventStoreError as error:
        return 502, {"error": str(error)}
    return 200, box


def _notifications_read(alias: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    if not _events.enabled:
        return 503, {"error": "events store disabled in this deployment"}
    until = body.get("until")
    event_id = str(body.get("eventId") or "")
    if until is not None and (not isinstance(until, int) or isinstance(until, bool)):
        raise ValueError("until must be an integer epoch")
    try:
        _events.mark_read(alias, until=until, event_id=event_id)
    except platform_events.EventStoreError as error:
        return 502, {"error": str(error)}
    return 200, {"ok": True}


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    origin = _origin(event)

    def respond(status: int, body: dict[str, Any]) -> dict[str, Any]:
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
    is_admin = _is_admin(alias)
    print(json.dumps({"event": "platform_api_request", "method": method, "path": path, "alias": alias, "admin": is_admin}))

    try:
        if method == "GET" and path.endswith("/platform/events"):
            return respond(*_events_view(alias, is_admin, event.get("queryStringParameters") or {}))
        if method == "GET" and path.endswith("/platform/notifications"):
            return respond(*_notifications_view(alias, is_admin))
        if method == "POST" and path.endswith("/platform/notifications/read"):
            raw = event.get("body") or "{}"
            body = json.loads(raw) if isinstance(raw, str) else raw
            if not isinstance(body, dict):
                raise ValueError("request body must be a JSON object")
            return respond(*_notifications_read(alias, body))

        if method == "GET" and path.endswith("/platform/me"):
            return respond(200, {"alias": alias, "isAdmin": is_admin, "viewerGroup": "AppModAgentPlatformViewers",
                                 "features": {"agentBuilder": AGENT_BUILDER_ENABLED, "serviceStudio": SERVICE_STUDIO_ENABLED,
                                              "platformAssistant": PLATFORM_ASSISTANT_ENABLED,
                                              "composableDashboard": COMPOSABLE_DASHBOARD_ENABLED}})

        if "/platform/assistant/" in path:
            if not PLATFORM_ASSISTANT_ENABLED:
                return respond(404, {"error": "platform assistant disabled"})
            # A identidade é a sessão que o gate acima autorizou; o corpo nunca carrega requester.
            caller = platform_assistant.Caller(alias, is_admin, "portal")
            status, body = platform_assistant.handle_http(_assistant_service(), method, path, event.get("body"), caller)
            _record_plan_event(alias, method, path, status, body)
            print(json.dumps({"event": "platform_assistant_request", "alias": alias, "method": method, "status": status,
                              "code": body.get("code", "") if isinstance(body, dict) else ""}))
            return respond(status, body)

        if method == "POST" and path.endswith("/platform/service-drafts/preview"):
            if not SERVICE_STUDIO_ENABLED:
                return respond(404, {"error": "service studio disabled"})
            return respond(*_studio_preview(alias, is_admin, _agent_body(event)))

        if method == "GET" and path.endswith("/platform/scope"):
            return respond(200, platform_scope.context(platform_scope.load_registry(), alias, is_admin))

        if method == "POST" and path.endswith("/platform/agent-drafts/preview"):
            if not AGENT_BUILDER_ENABLED:
                return respond(404, {"error": "agent builder disabled"})
            return respond(200, _preview_agent_draft(alias, is_admin, _agent_body(event), str((event.get("requestContext") or {}).get("requestId", ""))[:64]))

        if method == "GET" and path.endswith("/platform/resources"):
            items, truncated = _list_platform_resources()
            return respond(200, {"resources": items, "count": len(items), "truncated": truncated, "source": "aws-tagging-api", "tagFilter": "ManagedBy=KRO-ACK"})

        if method == "POST" and path.endswith("/platform/onboard"):
            if not is_admin:
                return respond(403, {"error": "onboarding requires a platform admin"})
            raw = event.get("body") or "{}"
            body = json.loads(raw) if isinstance(raw, str) else raw
            if not isinstance(body, dict):
                raise ValueError("request body must be a JSON object")
            return respond(200, _onboard(body))

        if method == "POST" and path.endswith("/platform/provision-requests"):
            raw = event.get("body") or "{}"
            body = json.loads(raw) if isinstance(raw, str) else raw
            if not isinstance(body, dict):
                raise ValueError("request body must be a JSON object")
            # O escopo vem da query (`project`) e é decidido aqui, antes de qualquer gravação.
            project = (event.get("queryStringParameters") or {}).get("project")
            if body.get("tour") is True:
                # O tour é gerado pelo servidor no namespace appmod: o escopo tem de contê-lo.
                _provision_scope(alias, is_admin, project, "appmod")
                return respond(*_create_tour_request(alias))
            if body.get("kind") == AGENT_KIND:
                if not AGENT_BUILDER_ENABLED:
                    return respond(404, {"error": "agent builder disabled"})
                _provision_scope(alias, is_admin, project, "kagent")
                return respond(*_create_agent_request(alias, is_admin, _agent_body(event)))
            if body.get("kind") == service_studio.KIND:
                # Capability do catálogo, não instância: a autorização é o owner team (SERVICE_OWNER_TEAMS),
                # e o destino é platform/catalog/, fora de qualquer namespace de projeto.
                if not SERVICE_STUDIO_ENABLED:
                    return respond(404, {"error": "service studio disabled"})
                return respond(*_studio_request(alias, is_admin, _agent_body(event)))
            scope = _provision_scope(alias, is_admin, project, body.get("namespace"))
            if scope.scoped:
                scope = scope.narrow(scope.single())
            return respond(201, _create_provision_request(alias, body, scope))

        publish = re.search(rf"/platform/provision-requests/({REQUEST_ID_PATTERN})/publish$", path)
        if method == "POST" and publish:
            return respond(*_publish_tour(alias, publish.group(1)))

        match = re.search(rf"/platform/provision-requests/({REQUEST_ID_PATTERN})$", path)
        if method == "GET" and match:
            found = _get_provision_request(alias, is_admin, match.group(1))
            return respond(200, found) if found else respond(404, {"error": "provision request not found"})

        return respond(404, {"error": "route not found"})
    except platform_scope.ScopeError as error:
        print(json.dumps({"event": "scope_denied", "alias": alias, "path": path, "method": method,
                          "code": error.code, "status": error.status}))
        return respond(error.status, {"error": error.message, "code": error.code})
    except (json.JSONDecodeError, ValueError) as error:
        return respond(400, {"error": str(error)})
    except agent_builder.CatalogUnavailable as error:
        # Sem catálogo não existe compilação segura: falha fechado, nunca adivinha a lista de tools.
        print(json.dumps({"event": "agent_catalog_unavailable", "error": str(error)[:300]}))
        return respond(503, {"error": "agent builder catalog unavailable in this deployment"})
    except service_studio.StudioUnavailable as error:
        # Sem as compositions no bundle o Studio não sabe a que formulário amarrar: 503, nunca palpite.
        print(json.dumps({"event": "service_studio_unavailable", "error": str(error)[:300]}))
        return respond(503, {"error": "service studio compositions unavailable in this deployment"})
    except (BotoCoreError, ClientError) as error:
        print(json.dumps({"event": "platform_api_error", "error": str(error)[:300]}))
        return respond(502, {"error": "platform backend unavailable"})
