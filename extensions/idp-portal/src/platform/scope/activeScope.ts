/*
 * Escopo ativo para os clients HTTP (issue #10). Uma fonte só: a URL, lida pelo shell.
 *
 * O shell resolve a seleção (`?project=`, `ns`) contra GET /platform/scope e publica aqui o que os
 * clients precisam para PEDIR o escopo certo. Nada aqui concede acesso: a cluster-api e a
 * platform-api resolvem de novo com o alias que o the internal gateway assinou, e um escopo adulterado vira
 * 403/404 do servidor. Também não há storage: o valor vive na memória da aba e é reescrito a cada
 * render do shell a partir da URL, então reload e deep link reconstroem o mesmo estado.
 *
 * Regra de qual projeto pedir, nesta ordem:
 *   1. o caminho já traz `project`: fica como está;
 *   2. fluxo de namespace FIXO (Agent Builder em `kagent`, tour em `appmod`): o projeto dono desse
 *      namespace, porque o recurso só existe nele;
 *   3. o projeto selecionado na URL;
 *   4. sem seleção, o dono do namespace que a própria requisição nomeia;
 *   5. senão, nada: o servidor decide (em `compat` só quem enxerga todo projeto passa sem escopo).
 */

import type { ScopeProject, ScopeTeam } from './scopeModel';

export interface ActiveScope {
  /** Projeto selecionado (explícito na URL ou implícito com um projeto só). */
  project: string | null;
  /** namespace -> projeto dono, dos projetos que a sessão enxerga. */
  owners: Readonly<Record<string, string>>;
  /** Times do registry (ownership-model). Vazio quando o registry não os declara. */
  teams?: readonly ScopeTeam[];
  /** projeto -> owner do registry, para o detalhe mostrar o dono do projeto ao lado do do objeto. */
  projectOwners?: Readonly<Record<string, { team: string; contact: string }>>;
  /** Projetos visíveis (environments-promotion): o detalhe resolve o alvo de promoção do projeto dono. */
  projects?: readonly ScopeProject[];
}

const EMPTY: ActiveScope = { project: null, owners: {}, teams: [], projectOwners: {}, projects: [] };
let active: ActiveScope = EMPTY;

export function setActiveScope(next: ActiveScope): void {
  active = { project: next.project, owners: { ...next.owners }, teams: [...(next.teams ?? [])],
    projectOwners: { ...(next.projectOwners ?? {}) }, projects: [...(next.projects ?? [])] };
}

/** Alvo de promoção de um namespace: o projeto `promotesTo` do dono, com o namespace único dele.
 *  null quando o dono é terminal, o alvo não é visível ou tem mais de um namespace (a cópia precisaria
 *  de uma escolha que a UI não inventa). */
export interface PromotionTarget { project: ScopeProject; namespace: string; source: ScopeProject }
export function promotionTargetFor(namespace: string, scope: ActiveScope = active): PromotionTarget | null {
  const sourceId = scope.owners[namespace];
  const source = (scope.projects ?? []).find((p) => p.id === sourceId);
  if (!source?.promotesTo) return null;
  const project = (scope.projects ?? []).find((p) => p.id === source.promotesTo);
  if (!project || project.lifecycle.state !== 'active' || project.namespaces.length !== 1) return null;
  return { project, namespace: project.namespaces[0], source };
}

export function getActiveScope(): ActiveScope {
  return active;
}

/** Só para testes. */
export function resetActiveScope(): void {
  active = EMPTY;
}

export interface ScopeHint {
  /** Namespace que a requisição toca, quando ele não está na query (POST com `ns` no corpo). */
  namespace?: string;
  /** `true` quando o recurso só existe nesse namespace (Agent Builder, tour). */
  fixed?: boolean;
}

/** O projeto que esta requisição deve pedir, ou `null` para deixar o servidor decidir. */
export function projectFor(hint: ScopeHint = {}): string | null {
  const owner = hint.namespace && hint.namespace !== '_all' ? active.owners[hint.namespace] ?? null : null;
  if (hint.fixed && owner) return owner;
  return active.project ?? owner;
}

/** O mesmo caminho com `project=` aplicado. Preserva a query existente e nunca sobrescreve um `project` já presente. */
export function scopedPath(path: string, hint: ScopeHint = {}): string {
  const [pathname, query = ''] = path.split('?', 2);
  const params = new URLSearchParams(query);
  if (params.has('project')) return path;
  const project = projectFor({ ...hint, namespace: hint.namespace ?? params.get('ns') ?? undefined });
  if (!project) return path;
  params.set('project', project);
  return `${pathname}?${params.toString()}`;
}
