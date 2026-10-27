/**
 * Formatação de eventos (audit-log e notifications-center), sem React: rótulo por ação nos dois
 * idiomas, indicador por resultado e o texto de uma linha que o sino e a tabela mostram.
 */
import type { StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import type { PlatformEvent } from './platformApi';

const ACTION_LABELS: Record<string, { pt: string; en: string }> = {
  'provision.requested': { pt: 'Pedido de provisionamento criado', en: 'Provision request created' },
  'provision.mr-opened': { pt: 'Merge request aberto', en: 'Merge request opened' },
  'provision.merged': { pt: 'Merge request mergeado', en: 'Merge request merged' },
  'provision.failed': { pt: 'Provisionamento falhou', en: 'Provisioning failed' },
  'provision.closed': { pt: 'Pedido fechado sem merge', en: 'Request closed without merge' },
  'plan.submitted': { pt: 'Plano do Assistant submetido', en: 'Assistant plan submitted' },
  'plan.retried': { pt: 'Passo do plano reexecutado', en: 'Plan step retried' },
  'plan.compensated': { pt: 'Rollback do plano confirmado', en: 'Plan rollback confirmed' },
  'plan.failed': { pt: 'Plano falhou', en: 'Plan failed' },
  'workload.restarted': { pt: 'Workload reiniciado', en: 'Workload restarted' },
  'workload.scaled': { pt: 'Workload escalado', en: 'Workload scaled' },
  'pod.deleted': { pt: 'Pod removido', en: 'Pod deleted' },
  'layout.reset': { pt: 'Layout do dashboard restaurado', en: 'Dashboard layout reset' },
  'instance.ready': { pt: 'Instância ficou Ready', en: 'Instance became Ready' },
  'instance.not-ready': { pt: 'Instância deixou de estar Ready', en: 'Instance is no longer Ready' },
  'promotion.requested': { pt: 'Promoção entre ambientes pedida', en: 'Promotion between environments requested' },
};

export const EVENT_ACTIONS: readonly string[] = Object.keys(ACTION_LABELS);

export function actionLabel(action: string, pt: boolean): string {
  const entry = ACTION_LABELS[action];
  return entry ? (pt ? entry.pt : entry.en) : action;
}

export function resultIndicator(result: string, pt: boolean): { type: StatusIndicatorProps.Type; text: string } {
  if (result === 'failed') return { type: 'error', text: pt ? 'falhou' : 'failed' };
  if (result === 'denied') return { type: 'warning', text: pt ? 'negado' : 'denied' };
  return { type: 'success', text: 'ok' };
}

/** "Deployment appmod/web" ou "ProvisionRequest hello-site". */
export function objectLabel(event: Pick<PlatformEvent, 'kind' | 'namespace' | 'name'>): string {
  return `${event.kind} ${event.namespace ? `${event.namespace}/` : ''}${event.name}`;
}

/** Uma linha: "Workload reiniciado · Deployment appmod/web · por platform-admin". */
export function eventSummary(event: PlatformEvent, pt: boolean): string {
  return `${actionLabel(event.action, pt)} · ${objectLabel(event)} · ${pt ? 'por' : 'by'} ${event.actor}`;
}

/** Hash interno do portal a partir do `link` do evento, ou null se não aponta para o portal. */
export function eventTarget(event: Pick<PlatformEvent, 'link'>): { hash: string } | null {
  const match = /^\/agent-platform\/(#[a-z-]+(?:\/[0-9a-f]{32})?)$/.exec(event.link || '');
  return match ? { hash: match[1] } : null;
}

export function relativeTime(epochSeconds: number, pt: boolean, now = Date.now()): string {
  const seconds = Math.max(0, Math.round(now / 1000 - epochSeconds));
  if (seconds < 60) return pt ? 'agora' : 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return pt ? `há ${minutes} min` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return pt ? `há ${hours} h` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  return pt ? `há ${days} d` : `${days} d ago`;
}

/** Filtro local da página de auditoria (o servidor já filtra ator/ação/resultado; isto é a caixa de texto). */
export function matchesEvent(event: PlatformEvent, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  return [event.actor, event.action, event.kind, event.name, event.namespace, event.project, event.detail]
    .some(field => field.toLowerCase().includes(needle));
}
