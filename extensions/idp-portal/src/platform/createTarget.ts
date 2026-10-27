/*
 * Para onde o Create (wizard) pode gravar, derivado do projeto ativo, e quando o caminho manual do
 * GitLab é oferecido. O servidor decide de novo (platform-api e CI recusam infra fora de
 * platform/instances); isto só impede a UI de montar um pedido que ele recusaria.
 */
import type { ScopeProject } from './scope/scopeModel';

/** Único diretório GitOps que recebe instância kro: a Application agent-platform-instances. */
export const INFRA_GITOPS_PATH = 'platform/instances';

export type InfraTarget =
  | { allowed: true; namespaces: string[] | null }
  | { allowed: false; reason: 'gitops_path' | 'read_only'; project: ScopeProject };

/**
 * `null` (compat, todos os projetos): namespace livre, o servidor resolve o dono. Projeto com outro
 * diretório (agent-builder escreve platform/agents) ou fora de `active`: Create de infra bloqueado.
 */
export function infraTarget(project: ScopeProject | null): InfraTarget {
  if (!project) return { allowed: true, namespaces: null };
  if (project.gitopsPath !== INFRA_GITOPS_PATH) return { allowed: false, reason: 'gitops_path', project };
  if (project.lifecycle.state !== 'active') return { allowed: false, reason: 'read_only', project };
  return { allowed: true, namespaces: project.namespaces };
}

/** O namespace a usar: o pedido, se o projeto o tem; senão o primeiro do projeto. */
export function targetNamespace(target: InfraTarget, wanted: string): string {
  if (!target.allowed || !target.namespaces || target.namespaces.includes(wanted)) return wanted;
  return target.namespaces[0] ?? wanted;
}

/**
 * O caminho manual (copiar o YAML e abrir o GitLab) só cobre falha de TRANSPORTE: rede (sem
 * status) ou 5xx. Um 4xx é o servidor recusando o pedido (escopo, permissão, validação), e
 * oferecer o GitLab ali seria um atalho em volta da recusa.
 */
export function offersManualFallback(cause: unknown): boolean {
  const status = typeof cause === 'object' && cause !== null && 'status' in cause ? Number((cause as { status: unknown }).status) : NaN;
  return !Number.isFinite(status) || status === 0 || status >= 500;
}
