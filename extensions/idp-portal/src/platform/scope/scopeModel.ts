/*
 * Modelo do escopo de projeto (issue #10, ADR-0009): Organization > Project > Environment > Namespace.
 *
 * Três regras que este arquivo carrega:
 *
 * 1. O browser PEDE um escopo, o servidor DECIDE. Nada aqui concede acesso: `resolveSelection` só
 *    escolhe o que mandar na query, e a cluster-api e a platform-api revalidam com o alias que o
 *    the internal gateway assinou. Um escopo adulterado na URL vira 403/404 do servidor, nunca dado extra.
 * 2. O escopo vive SÓ na URL (`project`, `ns`). Nada vai para storage do browser: a URL
 *    é compartilhável e não carrega credencial, e storage client-side guardaria contexto de projeto
 *    num lugar que sobrevive à sessão.
 * 3. Com um único projeto de um único namespace o portal não mostra seletor (critério da issue).
 */

export type ScopeRole = 'viewer' | 'contributor' | 'admin';
export type LifecycleState = 'active' | 'read-only' | 'retired';

export interface ScopeEnvironment {
  id: string; name: string; cluster: string; region: string;
  /** Ambiente seguinte da cadeia de promoção (environments-promotion); null no terminal. */
  promotesTo: string | null;
}

export interface ScopeProject {
  id: string;
  name: string;
  description: string;
  role: ScopeRole;
  environment: ScopeEnvironment;
  namespaces: string[];
  appProject: string;
  gitopsPath: string;
  argoApplications: string[];
  owner: { team: string; contact: string };
  quota: { maxInstances: number | null; enforced: boolean };
  lifecycle: { state: LifecycleState };
  /** Projeto do ambiente seguinte que recebe a cópia promovida; null quando este projeto é terminal. */
  promotesTo: string | null;
}

/** Time dono (backlog ownership-model). `owner.team` dos projetos aponta para `id`. */
export interface ScopeTeam {
  id: string;
  name: string;
  description: string;
  /** Aliases de contato, em ordem. */
  contacts: string[];
  slack: { channel: string; url: string };
  /** URL do on-call; vazia quando o time não tem. */
  oncall: string;
}

/** Contrato de GET /platform/scope. */
export interface ScopeContext {
  organization: { id: string; name: string };
  alias: string;
  isAdmin: boolean;
  enforcement: 'compat' | 'strict';
  projects: ScopeProject[];
  /** Vazio em registry sem `teams`: o owner segue como texto nos projetos. */
  teams: ScopeTeam[];
  /** Cadeia de ambientes na ordem do registry (environments-promotion). */
  environments: ScopeEnvironment[];
  kubeconfig: { offered: boolean; reason: string };
}

/** O que a URL pede. Valores fora do formato DNS-1123 são descartados na leitura. */
export interface UrlScope { project?: string; namespace?: string }

export type ScopeSelection =
  | { status: 'empty' }
  | { status: 'not-found'; requested: string }
  | { status: 'unselected' }
  | { status: 'namespace-out-of-scope'; project: ScopeProject; requested: string }
  | { status: 'ready'; project: ScopeProject; namespace: string | null; implicit: boolean };

export const PROJECT_PARAM = 'project';
export const NAMESPACE_PARAM = 'ns';
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const ROLE_RANK: Record<ScopeRole, number> = { viewer: 1, contributor: 2, admin: 3 };

const label = (value: string | null): string | undefined =>
  value !== null && DNS_LABEL.test(value) ? value : undefined;

export function readUrlScope(search: URLSearchParams | string): UrlScope {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const project = label(params.get(PROJECT_PARAM));
  const namespace = label(params.get(NAMESPACE_PARAM));
  return { ...(project ? { project } : {}), ...(namespace ? { namespace } : {}) };
}

/** Devolve a query com o escopo aplicado. Preserva os outros parâmetros e não escreve nada além dos dois. */
export function writeUrlScope(search: URLSearchParams | string, scope: UrlScope): URLSearchParams {
  const params = new URLSearchParams(typeof search === 'string' ? search : search.toString());
  const project = scope.project ? label(scope.project) : undefined;
  const namespace = project && scope.namespace ? label(scope.namespace) : undefined;
  if (project) params.set(PROJECT_PARAM, project); else params.delete(PROJECT_PARAM);
  if (namespace) params.set(NAMESPACE_PARAM, namespace); else params.delete(NAMESPACE_PARAM);
  return params;
}

/** Escolhe o que mandar ao servidor a partir do contexto e da URL. Nunca inventa projeto. */
export function resolveSelection(context: ScopeContext, url: UrlScope): ScopeSelection {
  const projects = context.projects.filter(project => project.lifecycle.state !== 'retired');
  if (projects.length === 0) return { status: 'empty' };
  let project: ScopeProject | undefined;
  let implicit = false;
  if (url.project) {
    project = projects.find(candidate => candidate.id === url.project);
    if (!project) return { status: 'not-found', requested: url.project };
  } else if (projects.length === 1) {
    project = projects[0];
    implicit = true;
  } else {
    return { status: 'unselected' };
  }
  if (url.namespace && !project.namespaces.includes(url.namespace)) {
    return { status: 'namespace-out-of-scope', project, requested: url.namespace };
  }
  const namespace = url.namespace ?? (project.namespaces.length === 1 ? project.namespaces[0] : null);
  return { status: 'ready', project, namespace, implicit };
}

/** O seletor só aparece quando há escolha a fazer. */
export function needsSelector(context: ScopeContext): boolean {
  const projects = context.projects.filter(project => project.lifecycle.state !== 'retired');
  return projects.length > 1 || projects.some(project => project.namespaces.length > 1);
}

/** Query de escopo para as APIs. Vazia quando não há seleção pronta: o servidor decide o que fazer. */
export function scopeQuery(selection: ScopeSelection): string {
  if (selection.status !== 'ready') return '';
  const params = new URLSearchParams({ [PROJECT_PARAM]: selection.project.id });
  if (selection.namespace) params.set(NAMESPACE_PARAM, selection.namespace);
  return params.toString();
}

/** Dica de UI para esconder ação que o servidor recusaria. Não é autorização. */
export function roleAllows(role: ScopeRole, action: 'read' | 'propose' | 'operate'): boolean {
  const needed: ScopeRole = action === 'read' ? 'viewer' : action === 'propose' ? 'contributor' : 'admin';
  return ROLE_RANK[role] >= ROLE_RANK[needed];
}

export function canPropose(project: ScopeProject): boolean {
  return project.lifecycle.state === 'active' && roleAllows(project.role, 'propose');
}

/* ----------------------------------------------------------------------- leitura defensiva */

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const isRole = (value: unknown): value is ScopeRole => value === 'viewer' || value === 'contributor' || value === 'admin';
const isState = (value: unknown): value is LifecycleState => value === 'active' || value === 'read-only' || value === 'retired';

function asProject(raw: unknown): ScopeProject[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const row = raw as Record<string, unknown>;
  const env = (row.environment ?? {}) as Record<string, unknown>;
  const owner = (row.owner ?? {}) as Record<string, unknown>;
  const quota = (row.quota ?? {}) as Record<string, unknown>;
  const lifecycle = (row.lifecycle ?? {}) as Record<string, unknown>;
  const namespaces = Array.isArray(row.namespaces) ? row.namespaces.filter((ns): ns is string => typeof ns === 'string' && DNS_LABEL.test(ns)) : [];
  // Projeto sem id válido, papel conhecido ou namespace é descartado: a UI não completa lacuna.
  if (!DNS_LABEL.test(str(row.id)) || !isRole(row.role) || namespaces.length === 0 || !isState(lifecycle.state)) return [];
  return [{
    id: str(row.id), name: str(row.name) || str(row.id), description: str(row.description), role: row.role,
    environment: asEnvironment(env),
    namespaces, appProject: str(row.appProject), gitopsPath: str(row.gitopsPath),
    argoApplications: Array.isArray(row.argoApplications) ? row.argoApplications.filter((a): a is string => typeof a === 'string') : [],
    owner: { team: str(owner.team), contact: str(owner.contact) },
    quota: { maxInstances: typeof quota.maxInstances === 'number' ? quota.maxInstances : null, enforced: quota.enforced === true },
    lifecycle: { state: lifecycle.state },
    promotesTo: DNS_LABEL.test(str(row.promotesTo)) ? str(row.promotesTo) : null,
  }];
}

function asEnvironment(raw: unknown): ScopeEnvironment {
  const env = (raw ?? {}) as Record<string, unknown>;
  return { id: str(env.id), name: str(env.name), cluster: str(env.cluster), region: str(env.region),
    promotesTo: DNS_LABEL.test(str(env.promotesTo)) ? str(env.promotesTo) : null };
}

const HTTPS = /^https:\/\/[^\s]{1,500}$/;

function asTeam(raw: unknown): ScopeTeam[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const row = raw as Record<string, unknown>;
  const slack = (row.slack ?? {}) as Record<string, unknown>;
  if (!str(row.id)) return [];
  const url = HTTPS.test(str(slack.url)) ? str(slack.url) : '';
  return [{
    id: str(row.id), name: str(row.name) || str(row.id), description: str(row.description),
    contacts: Array.isArray(row.contacts) ? row.contacts.filter((c): c is string => typeof c === 'string' && c.length > 0) : [],
    slack: { channel: str(slack.channel), url },
    oncall: HTTPS.test(str(row.oncall)) ? str(row.oncall) : '',
  }];
}

/** O time dono de um projeto, quando o registry o declara. */
export function teamOf(context: Pick<ScopeContext, 'teams'>, teamId: string): ScopeTeam | null {
  return context.teams.find(team => team.id === teamId) ?? null;
}

export function asScopeContext(raw: unknown): ScopeContext {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const org = (body.organization ?? {}) as Record<string, unknown>;
  const kubeconfig = (body.kubeconfig ?? {}) as Record<string, unknown>;
  return {
    organization: { id: str(org.id), name: str(org.name) || str(org.id) },
    alias: str(body.alias),
    isAdmin: body.isAdmin === true,
    enforcement: body.enforcement === 'compat' ? 'compat' : 'strict',
    projects: Array.isArray(body.projects) ? body.projects.flatMap(asProject) : [],
    teams: Array.isArray(body.teams) ? body.teams.flatMap(asTeam) : [],
    environments: Array.isArray(body.environments) ? body.environments.map(asEnvironment).filter((e) => DNS_LABEL.test(e.id)) : [],
    // Só `true` explícito oferece kubeconfig; o default do ADR-0009 é não oferecer.
    kubeconfig: { offered: kubeconfig.offered === true, reason: str(kubeconfig.reason) },
  };
}
