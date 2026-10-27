"""Escopo explícito da plataforma: Organization > Project > Environment > Namespace (issue #10).

Workspace lógico v1 = AppProject do Argo CD + namespace(s) + diretório GitOps + owner e policy
(ADR-0009). Este módulo é a ÚNICA implementação da regra, compartilhada pela cluster-api e pela
platform-api do mesmo jeito que `agent_builder`: as duas Lambdas importam este pacote, e nenhuma
reimplementa a decisão.

Três regras que o resto do código assume:

1. A fonte da verdade é `platform/scope/registry.json`, revisado por MR e empacotado na Lambda.
   O browser nunca define projeto, papel nem namespace permitido: ele PEDE um escopo pela query
   (`project`, `ns`) e o servidor decide com o alias que o the internal gateway assinou.
2. Fail closed. Registry ausente ou inválido é `ScopeUnavailable` (503), nunca "sem restrição".
   Projeto que o caller não enxerga responde igual a projeto inexistente (404), para que ids não
   possam ser sondados. Namespace fora do projeto é 403.
3. Um namespace pertence a no máximo UM projeto. Sem isso, "o recurso do Projeto A não aparece no
   Projeto B" deixaria de ser verdade por construção.

Compatibilidade (`SCOPE_ENFORCEMENT`):

- `compat` (default): pedido SEM `project` mantém o comportamento anterior, mas só para quem já
  enxerga todos os projetos ativos com o papel exigido. Quem tem acesso parcial recebe 400 e
  precisa mandar o escopo, então o modo de compatibilidade não vaza nada entre projetos.
- `strict`: `project` é obrigatório em toda rota com escopo.
- Qualquer outro valor vira `strict`.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

ALL_NAMESPACES = "_all"
ENFORCEMENT_COMPAT = "compat"
ENFORCEMENT_STRICT = "strict"

ACTION_READ = "read"
ACTION_PROPOSE = "propose"
ACTION_OPERATE = "operate"
ROLE_RANK = {"viewer": 1, "contributor": 2, "admin": 3}
ACTION_ROLE = {ACTION_READ: "viewer", ACTION_PROPOSE: "contributor", ACTION_OPERATE: "admin"}
LIFECYCLE_STATES = ("active", "read-only", "retired")
# Diretórios que o mirror GitOps leva ao CodeCommit (scripts/sync-gitops-codecommit.py). Um
# gitopsPath fora disto nunca seria aplicado pelo Argo CD, então é recusado na carga.
GITOPS_ROOTS = ("platform/instances", "platform/agents", "platform/compositions")

ID_PATTERN = re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
NAMESPACE_PATTERN = ID_PATTERN
ALIAS_PATTERN = re.compile(r"[a-z][a-z0-9._-]{0,63}")
WILDCARD = "*"

_PACKAGE_DIR = Path(__file__).resolve().parent
# No bundle o registry vai ao lado deste arquivo; no repo ele fica em platform/scope/.
_CANDIDATES = (_PACKAGE_DIR / "registry.json", _PACKAGE_DIR.parents[1] / "platform/scope/registry.json")


class ScopeError(Exception):
    """Decisão negativa com status HTTP. A mensagem vai ao cliente: nunca leva dado de outro projeto."""

    status = 400

    def __init__(self, message: str, code: str, status: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        if status is not None:
            self.status = status


class ScopeUnavailable(ScopeError):
    status = 503

    def __init__(self, message: str) -> None:
        super().__init__(message, "scope_registry_unavailable", 503)


@dataclass(frozen=True)
class Project:
    id: str
    name: str
    description: str
    environment: str
    app_project: str
    namespaces: tuple[str, ...]
    gitops_path: str
    argo_applications: tuple[str, ...]
    owner: dict[str, str]
    members: tuple[tuple[str, str], ...]
    quota: dict[str, Any]
    lifecycle: str
    # environments-promotion: projeto do ambiente seguinte que recebe a cópia promovida (None = terminal).
    promotes_to: str | None = None


@dataclass(frozen=True)
class Team:
    """Time dono (backlog ownership-model): entidade de primeira classe, referenciada por `owner.team`."""

    id: str
    name: str
    description: str
    contacts: tuple[str, ...]
    slack: dict[str, str]
    oncall: str

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "description": self.description,
                "contacts": list(self.contacts), "slack": dict(self.slack), "oncall": self.oncall}


@dataclass(frozen=True)
class Registry:
    organization: dict[str, Any]
    environments: dict[str, dict[str, str]]
    projects: tuple[Project, ...]
    teams: tuple[Team, ...] = ()

    def team(self, team_id: str) -> Team | None:
        return next((t for t in self.teams if t.id == team_id), None)

    def project(self, project_id: str) -> Project | None:
        return next((p for p in self.projects if p.id == project_id), None)

    def owner_of(self, namespace: str) -> Project | None:
        return next((p for p in self.projects if namespace in p.namespaces), None)


@dataclass(frozen=True)
class Scope:
    """Escopo RESOLVIDO pelo servidor. `project` None = pedido sem escopo aceito em compat."""

    project: str | None
    namespace: str
    namespaces: tuple[str, ...]
    role: str
    environment: str | None

    @property
    def scoped(self) -> bool:
        return self.project is not None

    def allows(self, namespace: str | None) -> bool:
        """`True` quando o namespace está dentro do escopo. Sem escopo, tudo o que o caller já via."""
        if not self.scoped:
            return True
        return bool(namespace) and namespace in self.namespaces

    def single(self) -> str:
        """Um namespace concreto do escopo: o pedido, ou o único do projeto.

        `_all` dentro de um projeto com vários namespaces é recusado em vez de varrer o cluster e
        filtrar depois: paginação e contagem sairiam de um universo maior que o escopo.
        """
        if self.namespace != ALL_NAMESPACES or not self.scoped:
            return self.namespace
        if len(self.namespaces) != 1:
            raise ScopeError("namespace is required: the project has several", "namespace_required", 400)
        return self.namespaces[0]

    def narrow(self, namespace: str) -> "Scope":
        """O mesmo escopo fixado num namespace concreto, que tem de estar dentro dele."""
        if self.scoped and namespace not in self.namespaces:
            raise ScopeError("namespace is outside the project scope", "namespace_out_of_scope", 403)
        return replace(self, namespace=namespace)

    def public(self) -> dict[str, Any]:
        return {"project": self.project, "namespace": self.namespace, "namespaces": list(self.namespaces),
                "role": self.role, "environment": self.environment}


# ---------------------------------------------------------------------------- carga e validação
def _text(value: Any, field: str, limit: int = 200) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ScopeUnavailable(f"registry field {field} must be a non-empty string")
    return value.strip()


def _ident(value: Any, field: str) -> str:
    text = _text(value, field, 63)
    if not ID_PATTERN.fullmatch(text):
        raise ScopeUnavailable(f"registry field {field} is not a DNS label")
    return text


def _owner(raw: Any, field: str) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise ScopeUnavailable(f"registry field {field} must be an object")
    contact = _text(raw.get("contact"), f"{field}.contact", 64)
    if not ALIAS_PATTERN.fullmatch(contact):
        raise ScopeUnavailable(f"registry field {field}.contact is not an alias")
    return {"team": _text(raw.get("team"), f"{field}.team", 120), "contact": contact}


_URL_PATTERN = re.compile(r"https://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{1,500}")


def _url(value: Any, field: str) -> str:
    if value in (None, ""):
        return ""
    text = _text(value, field, 500)
    if not _URL_PATTERN.fullmatch(text):
        raise ScopeUnavailable(f"registry field {field} must be an https URL")
    return text


def _team(raw: Any, index: int) -> Team:
    field = f"teams[{index}]"
    if not isinstance(raw, dict):
        raise ScopeUnavailable(f"registry field {field} must be an object")
    contacts_raw = raw.get("contacts")
    if not isinstance(contacts_raw, list) or not contacts_raw:
        raise ScopeUnavailable(f"registry field {field}.contacts must be a non-empty list")
    contacts = []
    for position, contact in enumerate(contacts_raw):
        alias = _text(contact, f"{field}.contacts[{position}]", 64)
        if not ALIAS_PATTERN.fullmatch(alias):
            raise ScopeUnavailable(f"registry field {field}.contacts[{position}] is not an alias")
        contacts.append(alias)
    slack_raw = raw.get("slack") or {}
    if not isinstance(slack_raw, dict):
        raise ScopeUnavailable(f"registry field {field}.slack must be an object")
    slack = {"channel": _text(slack_raw.get("channel"), f"{field}.slack.channel", 80) if slack_raw.get("channel") else "",
             "url": _url(slack_raw.get("url"), f"{field}.slack.url")}
    return Team(id=_text(raw.get("id"), f"{field}.id", 120), name=_text(raw.get("name"), f"{field}.name", 120),
                description=str(raw.get("description") or "")[:400], contacts=tuple(contacts), slack=slack,
                oncall=_url(raw.get("oncall"), f"{field}.oncall"))


def _members(raw: Any, field: str) -> tuple[tuple[str, str], ...]:
    if not isinstance(raw, list) or not raw:
        raise ScopeUnavailable(f"registry field {field} must be a non-empty list")
    members: list[tuple[str, str]] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ScopeUnavailable(f"registry field {field}[{index}] must be an object")
        principal, role = entry.get("principal"), entry.get("role")
        if role not in ROLE_RANK:
            raise ScopeUnavailable(f"registry field {field}[{index}].role is not a known role")
        if principal != WILDCARD and not (isinstance(principal, str) and ALIAS_PATTERN.fullmatch(principal)):
            raise ScopeUnavailable(f"registry field {field}[{index}].principal is not an alias or '*'")
        # Mesmo contrato de PLATFORM_ADMINS: o curinga nunca concede admin.
        if principal == WILDCARD and role == "admin":
            raise ScopeUnavailable(f"registry field {field}[{index}] grants admin to '*'")
        members.append((principal, role))
    return tuple(members)


def _project(raw: Any, index: int, environments: dict[str, dict[str, str]]) -> Project:
    field = f"projects[{index}]"
    if not isinstance(raw, dict):
        raise ScopeUnavailable(f"registry field {field} must be an object")
    environment = _ident(raw.get("environment"), f"{field}.environment")
    if environment not in environments:
        raise ScopeUnavailable(f"registry field {field}.environment references an unknown environment")
    namespaces = raw.get("namespaces")
    if not isinstance(namespaces, list) or not namespaces:
        raise ScopeUnavailable(f"registry field {field}.namespaces must be a non-empty list")
    names = tuple(_ident(ns, f"{field}.namespaces") for ns in namespaces)
    if len(set(names)) != len(names):
        raise ScopeUnavailable(f"registry field {field}.namespaces has duplicates")
    gitops = _text(raw.get("gitopsPath"), f"{field}.gitopsPath")
    if gitops not in GITOPS_ROOTS:
        raise ScopeUnavailable(f"registry field {field}.gitopsPath is not a mirrored GitOps directory")
    apps = raw.get("argoApplications") or []
    if not isinstance(apps, list):
        raise ScopeUnavailable(f"registry field {field}.argoApplications must be a list")
    quota = raw.get("quota") or {}
    if not isinstance(quota, dict) or not (quota.get("maxInstances") is None or (
            isinstance(quota.get("maxInstances"), int) and quota["maxInstances"] > 0)):
        raise ScopeUnavailable(f"registry field {field}.quota.maxInstances must be null or a positive integer")
    lifecycle = (raw.get("lifecycle") or {}).get("state")
    if lifecycle not in LIFECYCLE_STATES:
        raise ScopeUnavailable(f"registry field {field}.lifecycle.state is not a known state")
    promotes_to = raw.get("promotesTo")
    if promotes_to is not None:
        promotes_to = _ident(promotes_to, f"{field}.promotesTo")
    return Project(
        id=_ident(raw.get("id"), f"{field}.id"),
        name=_text(raw.get("name"), f"{field}.name", 120),
        description=str(raw.get("description") or "")[:300],
        environment=environment,
        app_project=_ident(raw.get("appProject"), f"{field}.appProject"),
        namespaces=names,
        gitops_path=gitops,
        argo_applications=tuple(_ident(app, f"{field}.argoApplications") for app in apps),
        owner=_owner(raw.get("owner"), f"{field}.owner"),
        members=_members(raw.get("members"), f"{field}.members"),
        quota={"maxInstances": quota.get("maxInstances"), "enforced": bool(quota.get("enforced", False))},
        lifecycle=lifecycle,
        promotes_to=promotes_to,
    )


def parse_registry(document: Any) -> Registry:
    """Valida o documento inteiro. Qualquer desvio vira ScopeUnavailable: nunca carga parcial."""
    if not isinstance(document, dict) or document.get("version") != 1:
        raise ScopeUnavailable("registry version must be 1")
    org = document.get("organization")
    if not isinstance(org, dict):
        raise ScopeUnavailable("registry field organization must be an object")
    organization = {"id": _ident(org.get("id"), "organization.id"),
                    "name": _text(org.get("name"), "organization.name", 120),
                    "owner": _owner(org.get("owner"), "organization.owner")}
    environments: dict[str, dict[str, str]] = {}
    for index, env in enumerate(document.get("environments") or []):
        if not isinstance(env, dict):
            raise ScopeUnavailable(f"registry field environments[{index}] must be an object")
        env_id = _ident(env.get("id"), f"environments[{index}].id")
        if env_id in environments:
            raise ScopeUnavailable("registry environments have duplicate ids")
        promotes_to = env.get("promotesTo")
        environments[env_id] = {"id": env_id, "name": _text(env.get("name"), f"environments[{index}].name", 120),
                                "cluster": _ident(env.get("cluster"), f"environments[{index}].cluster"),
                                "region": _ident(env.get("region"), f"environments[{index}].region"),
                                "promotesTo": _ident(promotes_to, f"environments[{index}].promotesTo") if promotes_to is not None else None}
    if not environments:
        raise ScopeUnavailable("registry has no environment")
    # environments-promotion: a cadeia (lab -> staging -> prod) é explícita por `promotesTo`, nunca a ordem da
    # lista. Alvo inexistente, auto-referência ou ciclo recusam o registry inteiro.
    for env in environments.values():
        target = env["promotesTo"]
        if target is None:
            continue
        if target not in environments or target == env["id"]:
            raise ScopeUnavailable(f"registry field environments[{env['id']}].promotesTo references an unknown environment")
    for env in environments.values():
        seen, cursor = set(), env["id"]
        while cursor is not None:
            if cursor in seen:
                raise ScopeUnavailable("registry environments promotesTo forms a cycle")
            seen.add(cursor)
            cursor = environments[cursor]["promotesTo"]
    raw_projects = document.get("projects")
    if not isinstance(raw_projects, list) or not raw_projects:
        raise ScopeUnavailable("registry has no project")
    projects = tuple(_project(raw, index, environments) for index, raw in enumerate(raw_projects))
    ids = [p.id for p in projects]
    if len(set(ids)) != len(ids):
        raise ScopeUnavailable("registry projects have duplicate ids")
    owned = [ns for p in projects for ns in p.namespaces]
    if len(set(owned)) != len(owned):
        raise ScopeUnavailable("a namespace belongs to more than one project")
    # O projeto alvo da promoção existe, vive no ambiente seguinte do ambiente deste projeto e aplica o
    # mesmo diretório GitOps (a promoção abre um pedido de infra, que só escreve em platform/instances).
    by_id = {p.id: p for p in projects}
    for p in projects:
        if p.promotes_to is None:
            continue
        target = by_id.get(p.promotes_to)
        if target is None or target.id == p.id:
            raise ScopeUnavailable(f"registry field projects[{p.id}].promotesTo references an unknown project")
        if environments[p.environment]["promotesTo"] != target.environment:
            raise ScopeUnavailable(f"registry field projects[{p.id}].promotesTo must live in environment "
                                   f"{environments[p.environment]['promotesTo']!r}, the one {p.environment!r} promotes to")
        if target.gitops_path != p.gitops_path:
            raise ScopeUnavailable(f"registry field projects[{p.id}].promotesTo must use the same gitopsPath")
    raw_teams = document.get("teams")
    if raw_teams is not None and not isinstance(raw_teams, list):
        raise ScopeUnavailable("registry field teams must be a list")
    teams = tuple(_team(raw, index) for index, raw in enumerate(raw_teams or []))
    team_ids = [t.id for t in teams]
    if len(set(team_ids)) != len(team_ids):
        raise ScopeUnavailable("registry teams have duplicate ids")
    # Com `teams` declarado, todo owner.team tem que apontar para um time: é o que faz o time ser
    # entidade e não texto livre. Sem `teams` (registry antigo) o owner segue sendo só texto.
    if teams:
        for label, owner in [("organization", organization["owner"])] + [(f"projects[{p.id}]", p.owner) for p in projects]:
            if owner["team"] not in team_ids:
                raise ScopeUnavailable(f"registry field {label}.owner.team references an unknown team")
    return Registry(organization=organization, environments=environments, projects=projects, teams=teams)


_cache: dict[str, Registry] = {}


def load_registry(path: str | os.PathLike[str] | None = None) -> Registry:
    """Registry da Lambda. Cache por caminho: o arquivo é imutável dentro do bundle."""
    explicit = path or os.environ.get("SCOPE_REGISTRY_PATH") or ""
    candidates = (Path(explicit),) if explicit else _CANDIDATES
    for candidate in candidates:
        key = str(candidate)
        if key in _cache:
            return _cache[key]
        if candidate.is_file():
            try:
                document = json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ScopeUnavailable(f"registry does not parse: {str(error)[:120]}") from error
            _cache[key] = parse_registry(document)
            return _cache[key]
    raise ScopeUnavailable("scope registry not found in this deployment")


def enforcement() -> str:
    value = os.environ.get("SCOPE_ENFORCEMENT", ENFORCEMENT_COMPAT).strip().lower()
    return value if value in (ENFORCEMENT_COMPAT, ENFORCEMENT_STRICT) else ENFORCEMENT_STRICT


# ---------------------------------------------------------------------------- decisão
def role_for(project: Project, alias: str, is_admin: bool) -> str | None:
    """Papel efetivo do caller no projeto. Admin da plataforma é admin em todo projeto."""
    if project.lifecycle == "retired":
        return None
    if is_admin:
        return "admin"
    granted = [role for principal, role in project.members if principal in (WILDCARD, alias)]
    return max(granted, key=ROLE_RANK.__getitem__) if granted else None


def _sufficient(role: str | None, action: str) -> bool:
    return role is not None and ROLE_RANK[role] >= ROLE_RANK[ACTION_ROLE[action]]


def visible_projects(registry: Registry, alias: str, is_admin: bool) -> list[tuple[Project, str]]:
    return [(p, role) for p in registry.projects if (role := role_for(p, alias, is_admin))]


def resolve(registry: Registry, alias: str, is_admin: bool, project_id: Any, namespace: Any,
            action: str = ACTION_READ, mode: str | None = None) -> Scope:
    """Decide o escopo do request. Levanta ScopeError com o status certo; nunca devolve 'sem filtro'
    para quem não poderia ver tudo."""
    if action not in ACTION_ROLE:
        raise ValueError(f"unknown action {action!r}")
    mode = mode or enforcement()
    wanted_ns = str(namespace or ALL_NAMESPACES).strip() or ALL_NAMESPACES
    if wanted_ns != ALL_NAMESPACES and not NAMESPACE_PATTERN.fullmatch(wanted_ns):
        raise ScopeError("invalid namespace", "invalid_namespace", 400)
    requested = str(project_id or "").strip()

    if not requested:
        if mode == ENFORCEMENT_STRICT:
            raise ScopeError("project scope is required", "scope_required", 400)
        # Compat: só quem já enxerga TODO projeto ativo com o papel pedido pode pular o escopo.
        active = [p for p in registry.projects if p.lifecycle != "retired"]
        covered = all(_sufficient(role_for(p, alias, is_admin), action) for p in active)
        writable = action == ACTION_READ or all(p.lifecycle == "active" for p in active)
        if not covered:
            raise ScopeError("project scope is required for this caller", "scope_required", 400)
        if not writable:
            raise ScopeError("project scope is required: a project is read-only", "scope_required", 400)
        return Scope(project=None, namespace=wanted_ns, namespaces=(), role="unscoped", environment=None)

    if not ID_PATTERN.fullmatch(requested):
        raise ScopeError("invalid project", "invalid_project", 400)
    project = registry.project(requested)
    role = role_for(project, alias, is_admin) if project else None
    if project is None or role is None:
        # Igual a inexistente: ids de projeto alheio não podem ser sondados.
        raise ScopeError("project not found", "project_not_found", 404)
    if action != ACTION_READ and project.lifecycle != "active":
        raise ScopeError("project is read-only", "project_read_only", 403)
    if not _sufficient(role, action):
        raise ScopeError(f"role {role} cannot {action} in this project", "role_insufficient", 403)
    if wanted_ns != ALL_NAMESPACES and wanted_ns not in project.namespaces:
        raise ScopeError("namespace is outside the project scope", "namespace_out_of_scope", 403)
    return Scope(project=project.id, namespace=wanted_ns, namespaces=project.namespaces, role=role,
                 environment=project.environment)


def context(registry: Registry, alias: str, is_admin: bool, mode: str | None = None) -> dict[str, Any]:
    """Contrato de GET /platform/scope: o que o caller enxerga, com papel. Sem membros de terceiros."""
    projects = []
    for project, role in visible_projects(registry, alias, is_admin):
        env = registry.environments[project.environment]
        projects.append({
            "id": project.id, "name": project.name, "description": project.description,
            "role": role, "environment": env, "namespaces": list(project.namespaces),
            "appProject": project.app_project, "gitopsPath": project.gitops_path,
            "argoApplications": list(project.argo_applications), "owner": dict(project.owner),
            "quota": dict(project.quota), "lifecycle": {"state": project.lifecycle},
            "promotesTo": project.promotes_to,
        })
    return {
        "organization": {"id": registry.organization["id"], "name": registry.organization["name"]},
        "alias": alias, "isAdmin": is_admin,
        "enforcement": mode or enforcement(),
        "projects": projects,
        # Cadeia de ambientes (environments-promotion), na ordem do registry, com o alvo de promoção de cada um.
        "environments": list(registry.environments.values()),
        # Times públicos: id, nome, contatos e canais. Sem papel do caller, que é por projeto.
        "teams": [team.public() for team in registry.teams],
        # Pelo ADR-0009 o portal não oferece kubeconfig. Exposto para a UI não inventar o botão.
        "kubeconfig": {"offered": False, "reason": "adr-0009"},
    }
