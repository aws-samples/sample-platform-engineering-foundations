// Modelo puro do Platform Assistant (issue #12): tipos do contrato e regras de apresentação.
// Sem rede, sem React. O backend (backend/platform_assistant) é a fonte do contrato, e os testes
// deste módulo renderizam as fixtures golden que o PRÓPRIO backend gera
// (tests/fixtures/platform-assistant/*.json), então UI e servidor não podem divergir em silêncio.

import { GIT_HOST } from '../deployment';
export type InputValue = string | number | boolean | Record<string, string> | PlanReference;
export interface PlanReference { fromRef: string; output: string }
export interface PlanItem { ref: string; capability: string; name: string; inputs: Record<string, InputValue>; dependsOn?: string[] }
export interface ProvisionPlan { schemaVersion: 'provision-plan/v1'; summary?: string; items: PlanItem[] }
export interface PlanIssue { path: string; code: string; message: string }
export interface AppliedDefault { field: string; value: unknown; basis: 'schema default' | 'item name' }
export interface Actor { type: 'human' | 'agent' | 'system'; persona: string; alias?: string; channel?: string; identity?: string }

export interface PreviewStep {
  ref: string; order: number; capability: string; displayName: string; displayNamePt: string; lifecycle: string;
  kind: string; name: string; path: string; change: 'create'; dependsOn: string[]; inputs: Record<string, InputValue>;
  defaults: AppliedDefault[]; references: { field: string; fromRef: string; output: string }[];
  deletionPolicy: string; readyCondition: string; outputs: string[]; cost: unknown; manifest: string | null;
}
export interface PlanPreview {
  valid: boolean; errors: PlanIssue[]; warnings: PlanIssue[]; project: string; namespace: string; summary: string;
  plan: ProvisionPlan; planSha256: string | null; compiler: string; steps: PreviewStep[];
  executor: { requestedBy: Actor; executedBy: Actor; writePath: string }; secrets: string;
}

export type StepState = 'planned' | 'waiting' | 'submitted' | 'mr_open' | 'syncing' | 'reconciling' | 'ready'
  | 'failed' | 'cancelled' | 'blocked';
export type UndoState = 'undo_planned' | 'undo_blocked' | 'undo_submitted' | 'undo_mr_open' | 'removing' | 'removed' | 'undo_failed';
export type RunState = 'running' | 'ready' | 'partial' | 'failed' | 'compensating' | 'compensated' | 'compensation_failed';
export interface RunStep {
  state: StepState; attempt: number; requestId: string | null; mrUrl: string; error: string; outputs: Record<string, string>;
  createdByPlan: boolean; observedError: string; lastDetail: Record<string, unknown>;
}
export interface RunEvent {
  seq: number; at: number; ref: string | null; type: string; source: string; from: string; to: string; actor: Actor;
  detail: Record<string, unknown>;
}
export interface PlanRun {
  planId: string; planSha256: string; project: string; namespace: string; requester: string; persona: string; channel: string;
  state: RunState; order: string[]; plan: ProvisionPlan; steps: Record<string, RunStep>; events: RunEvent[];
  compensation: null | { compensationSha256: string; order: string[]; confirmedBy: Actor; steps: Record<string, { state: UndoState; mrUrl: string; error: string }> };
}
export interface CompensationTarget { ref: string; name: string; path: string; capability: string; kind: string; deletionPolicy: string; effect: string }
export interface CompensationPreview {
  planId: string; compensationSha256: string; order: string[]; targets: CompensationTarget[];
  untouched: { ref: string; name: string; reason: string }[]; blocking: { code: string; message: string }[]; allowed: boolean;
}

// Tipo de indicador do Cloudscape. O texto sempre acompanha o ícone: estado nunca depende só de cor.
export type Indicator = 'success' | 'error' | 'warning' | 'in-progress' | 'pending' | 'stopped' | 'info';

const STEP: Record<StepState, [Indicator, string, string]> = {
  planned: ['pending', 'Planned', 'Planejado'],
  waiting: ['pending', 'Waiting for dependency', 'Aguardando dependência'],
  submitted: ['in-progress', 'Request queued for CI', 'Pedido na fila do CI'],
  mr_open: ['in-progress', 'Merge request open', 'Merge request aberto'],
  syncing: ['in-progress', 'Merged, waiting for Argo CD', 'Mergeado, aguardando o Argo CD'],
  reconciling: ['in-progress', 'Reconciling (not Ready)', 'Reconciliando (ainda não Ready)'],
  ready: ['success', 'Ready', 'Ready'],
  failed: ['error', 'Failed', 'Falhou'],
  cancelled: ['stopped', 'Merge request closed', 'Merge request fechado'],
  // Dependência que falhou OU projeto sem permissão de escrita agora (project_not_writable): o motivo vai na timeline.
  blocked: ['stopped', 'Blocked: not submitted', 'Bloqueado: não enviado'],
};
const UNDO: Record<UndoState, [Indicator, string, string]> = {
  undo_planned: ['pending', 'Rollback planned', 'Rollback planejado'],
  undo_blocked: ['stopped', 'Rollback blocked: no write permission or approval unavailable now', 'Rollback bloqueado: sem permissão de escrita ou aprovação indisponível agora'],
  undo_submitted: ['in-progress', 'Removal request queued', 'Pedido de remoção na fila'],
  undo_mr_open: ['in-progress', 'Removal merge request open', 'Merge request de remoção aberto'],
  removing: ['in-progress', 'Merged, waiting for Argo CD prune', 'Mergeado, aguardando o prune do Argo CD'],
  removed: ['success', 'Removed', 'Removido'],
  undo_failed: ['error', 'Removal failed', 'Remoção falhou'],
};
const RUN: Record<RunState, [Indicator, string, string]> = {
  running: ['in-progress', 'Running', 'Em execução'],
  ready: ['success', 'All resources Ready', 'Todos os recursos Ready'],
  partial: ['warning', 'Partial: some resources were created, some failed', 'Parcial: parte criada, parte falhou'],
  failed: ['error', 'Failed: nothing was created', 'Falhou: nada foi criado'],
  compensating: ['in-progress', 'Rolling back what this plan created', 'Revertendo o que este plano criou'],
  compensated: ['success', 'Rolled back', 'Revertido'],
  compensation_failed: ['error', 'Rollback failed', 'Rollback falhou'],
};

export interface Status { type: Indicator; label: string }
const pick = (entry: [Indicator, string, string] | undefined, raw: string, pt: boolean): Status =>
  entry ? { type: entry[0], label: pt ? entry[2] : entry[1] } : { type: 'info', label: raw };
export const stepStatus = (state: string, pt: boolean): Status => pick(STEP[state as StepState] ?? UNDO[state as UndoState], state, pt);
export const runStatus = (state: string, pt: boolean): Status => pick(RUN[state as RunState], state, pt);

export function isReference(value: unknown): value is PlanReference {
  return typeof value === 'object' && value !== null && 'fromRef' in value;
}

/** Valor mostrado ao usuário. Referência não é texto livre: vira "saída de <ref>". */
export function displayValue(value: InputValue, pt: boolean): string {
  if (isReference(value)) return pt ? `saída ${value.output} de ${value.fromRef}` : `${value.fromRef} output ${value.output}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Só link do GitLab interno, https, sem query (onde caberia `?private_token=`). */
export function safeMrUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === GIT_HOST && !parsed.search && !parsed.username ? parsed.href : null;
  } catch {
    return null;
  }
}

export function actorLabel(actor: Actor): string {
  if (actor.type === 'human') return `${actor.persona} (${actor.alias ?? '?'}, ${actor.channel === 'mcp' ? 'MCP' : 'portal'})`;
  return actor.identity ? `${actor.persona} (${actor.identity})` : actor.persona;
}

export interface TimelineRow { seq: number; at: string; ref: string; what: string; source: string; actor: string; link: string | null; type: Indicator }

const EVENT_TEXT: Record<string, [string, string]> = {
  plan_confirmed: ['Plan confirmed', 'Plano confirmado'],
  plan_state: ['Plan state', 'Estado do plano'],
  mr_merged: ['Merge request merged', 'Merge request mergeado'],
  retry: ['Retry requested', 'Retry pedido'],
  compensation_confirmed: ['Rollback confirmed', 'Rollback confirmado'],
  observation_unavailable: ['Cluster read failed (state kept)', 'Leitura do cluster falhou (estado mantido)'],
};

/** Linha do tempo única: pedido, MR, Argo, conditions e Ready, na ordem real dos eventos. */
export function timelineRows(run: PlanRun, pt: boolean): TimelineRow[] {
  return [...run.events].sort((a, b) => a.seq - b.seq).map((event) => {
    const transition = event.type === 'step_state' || event.type === 'undo_state' || event.type === 'plan_state';
    const target = transition ? (event.type === 'plan_state' ? runStatus(event.to, pt) : stepStatus(event.to, pt)) : null;
    const text = EVENT_TEXT[event.type];
    const reason = typeof event.detail.message === 'string' ? `: ${event.detail.message}`
      : typeof event.detail.reason === 'string' && event.detail.reason ? `: ${event.detail.reason}` : '';
    return {
      seq: event.seq,
      at: new Date(event.at * 1000).toISOString().replace('.000Z', 'Z'),
      ref: event.ref ?? '-',
      what: (target ? target.label : text ? (pt ? text[1] : text[0]) : event.type) + reason,
      source: event.source,
      actor: actorLabel(event.actor),
      link: safeMrUrl(event.detail.mrUrl),
      type: target?.type ?? (event.type === 'observation_unavailable' ? 'warning' : 'info'),
    };
  });
}

export function canRetry(run: PlanRun, ref: string): boolean {
  const step = run.steps[ref];
  return !run.compensation && !!step && (step.state === 'failed' || step.state === 'cancelled') && !step.createdByPlan;
}

/** Edita um input do plano, de forma imutável. O hash muda no próximo preview, então a confirmação anterior cai. */
export function editInput(plan: ProvisionPlan, ref: string, field: string, raw: string, schemaType: string | undefined): ProvisionPlan {
  const value: InputValue = schemaType === 'integer' || schemaType === 'number' ? Number(raw)
    : schemaType === 'boolean' ? raw === 'true' : raw;
  return { ...plan, items: plan.items.map((item) => (item.ref === ref ? { ...item, inputs: { ...item.inputs, [field]: value } } : item)) };
}

/** Chave de idempotência por intenção de envio: o mesmo clique repetido reaproveita a mesma. */
export function newIdempotencyKey(random: () => string = () => crypto.randomUUID()): string {
  return `pa-${random().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`;
}

/** Confirmação só vale para o hash que o servidor mostrou neste preview. */
export function confirmable(preview: PlanPreview | null, acknowledged: boolean): boolean {
  return !!preview && preview.valid && !!preview.planSha256 && acknowledged;
}

/**
 * O que a rota `#assistant/<planId>` pede ao componente montado: carregar o plano do servidor
 * (reload, deep link, outro plano), voltar ao pedido vazio (rota sem planId) ou nada.
 */
export function routeAction(planId: string | null, loaded: string | null): 'load' | 'reset' | 'none' {
  if (planId && planId !== loaded) return 'load';
  if (!planId && loaded) return 'reset';
  return 'none';
}
