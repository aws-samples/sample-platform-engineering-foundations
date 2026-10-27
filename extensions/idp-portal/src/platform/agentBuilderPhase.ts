// Fase observada do Agent Builder: função pura da seção 6.2 de
// docs/agent-platform/design-agent-builder.md. O golden é tests/fixtures/agent-builder/phase-cases.json;
// o teste deste arquivo consome o mesmo JSON que qualquer outra implementação.

export type ProvisionStatus = 'pending' | 'processing' | 'mr_open' | 'merged' | 'closed' | 'failed';
export type ConditionStatus = 'True' | 'False' | 'Unknown';
export type AgentOp = 'create' | 'disable';

export type AgentPhase =
  | 'FAILED' | 'CLOSED' | 'REQUESTED' | 'IN_REVIEW' | 'NOT_FOUND'
  | 'SYNCING' | 'SYNC_STALLED' | 'REJECTED' | 'DISABLED'
  | 'STARTING' | 'STALLED' | 'READY' | 'VERIFIED' | 'TEST_FAILED';

export interface PhaseRequest { status: ProvisionStatus; mergedAt: number | null }
export interface PhaseAgent {
  createdAt: number;
  accepted: ConditionStatus;
  ready: ConditionStatus;
  generation: number;
  observedGeneration: number;
  replicas: number | null;
  /** Pods não terminados do Deployment do agent, lidos pela cluster-api. Ausente ou null: não se sabe. */
  podReplicas?: number | null;
}
export interface PhaseA2A { state: string; hasText: boolean }

/** Orçamento de convergência depois do merge (B da seção 6.2), em segundos. */
export const CONVERGENCE_BUDGET_SECONDS = 900;

/** Estados A2A que ainda podem mudar. Tudo fora daqui encerra o teste. */
const A2A_RUNNING = new Set(['submitted', 'working', 'unknown']);

export function isA2ATerminal(state: string): boolean {
  return !A2A_RUNNING.has(state);
}

export function agentBuilderPhase(
  op: AgentOp,
  request: PhaseRequest | null,
  agent: PhaseAgent | null,
  a2a: PhaseA2A | null,
  now: number,
): AgentPhase {
  if (request?.status === 'failed') return 'FAILED';
  if (request?.status === 'closed') return 'CLOSED';
  if (request?.status === 'pending' || request?.status === 'processing') return 'REQUESTED';
  if (request?.status === 'mr_open') return 'IN_REVIEW';
  if (!request && !agent) return 'NOT_FOUND';

  const since = request ? request.mergedAt : agent?.createdAt ?? null;
  const withinBudget = since === null || now - since < CONVERGENCE_BUDGET_SECONDS;

  if (!agent) return withinBudget ? 'SYNCING' : 'SYNC_STALLED';
  if (agent.accepted === 'False') return 'REJECTED';
  // DISABLED é o que aconteceu, não o que foi pedido (review de 13/10/2026, rodada 3, R3-1): o spec
  // em replicas 0, o controller já tendo observado esse spec e zero pods de verdade. Com o pod antigo
  // ainda de pé ou o spec ainda não observado, um disable cai na regra 9 (SYNCING ou SYNC_STALLED) e
  // um agent aberto pela lista segue para as regras 10 e 11, que já exigem a geração observada.
  if (agent.replicas === 0 && agent.observedGeneration === agent.generation && agent.podReplicas === 0) return 'DISABLED';
  if (op === 'disable') return withinBudget ? 'SYNCING' : 'SYNC_STALLED';
  if (agent.ready === 'True' && agent.observedGeneration === agent.generation) {
    if (a2a && isA2ATerminal(a2a.state)) return a2a.state === 'completed' && a2a.hasText ? 'VERIFIED' : 'TEST_FAILED';
    return 'READY';
  }
  return withinBudget ? 'STARTING' : 'STALLED';
}

export interface PollPlan { source: 'request' | 'agent'; intervalMs: number }

/**
 * Seção 6.3. `elapsedInPhaseMs` conta desde que a fase atual começou neste navegador.
 * `null` quer dizer parar: a fase é terminal ou o prazo de polling acabou.
 */
export function pollPlan(phase: AgentPhase, elapsedInPhaseMs: number): PollPlan | null {
  switch (phase) {
    case 'REQUESTED': return elapsedInPhaseMs < 120_000 ? { source: 'request', intervalMs: 5_000 } : null;
    case 'IN_REVIEW': return { source: 'request', intervalMs: 30_000 };
    case 'SYNCING':
    case 'STARTING': return { source: 'agent', intervalMs: 10_000 };
    default: return null;
  }
}

export type IndicatorType = 'success' | 'error' | 'warning' | 'info' | 'stopped' | 'pending' | 'in-progress' | 'loading';

export interface PhasePresentation { indicator: IndicatorType; label: string; detail: string }

/** Rótulo, ícone e frase de cada fase. O texto sempre carrega o estado: nada depende só da cor. */
export function presentPhase(phase: AgentPhase, pt: boolean): PhasePresentation {
  const P = (indicator: IndicatorType, labelPt: string, labelEn: string, detailPt: string, detailEn: string): PhasePresentation =>
    ({ indicator, label: pt ? labelPt : labelEn, detail: pt ? detailPt : detailEn });
  switch (phase) {
    case 'FAILED': return P('error', 'Falhou: o pedido não virou MR', 'Failed: the request did not become an MR', 'O CI recusou o pedido. Leia o motivo abaixo e corrija o rascunho.', 'CI rejected the request. Read the reason below and fix the draft.');
    case 'CLOSED': return P('stopped', 'Encerrado: MR fechado sem merge', 'Closed: MR closed without merge', 'Nada foi criado no cluster.', 'Nothing was created in the cluster.');
    case 'REQUESTED': return P('in-progress', 'Pedido registrado: abrindo o MR', 'Request recorded: opening the MR', 'O bot abre o merge request em alguns minutos. Pode fechar esta aba.', 'The bot opens the merge request within minutes. You can close this tab.');
    case 'IN_REVIEW': return P('pending', 'Em review no GitLab', 'In review on GitLab', 'Alguém do time revisa e faz o merge. Depois disso, o Argo CD aplica.', 'Someone on the team reviews and merges. Then Argo CD applies it.');
    case 'NOT_FOUND': return P('stopped', 'Não encontrado', 'Not found', 'Não há pedido nem agent do builder com esse nome.', 'There is no request or builder agent with this name.');
    case 'SYNCING': return P('in-progress', 'Merge feito: aguardando o Argo CD', 'Merged: waiting for Argo CD', 'O mirror leva o arquivo ao CodeCommit e o Argo CD aplica. Costuma levar poucos minutos.', 'The mirror copies the file to CodeCommit and Argo CD applies it. It usually takes a few minutes.');
    case 'SYNC_STALLED': return P('warning', 'Atenção: o Argo CD não aplicou em 15 min', 'Attention: Argo CD did not apply within 15 min', 'Confira a Application agent-platform-agents no Argo CD e o job de mirror no GitLab.', 'Check the agent-platform-agents Application in Argo CD and the mirror job in GitLab.');
    case 'REJECTED': return P('error', 'Recusado pelo controller do kagent', 'Rejected by the kagent controller', 'O controller não aceitou o Agent. O motivo dele está abaixo.', 'The controller did not accept the Agent. Its reason is below.');
    case 'DISABLED': return P('stopped', 'Desativado (replicas: 0)', 'Disabled (replicas: 0)', 'O objeto e o histórico continuam. Para reativar, faça Revert do MR "disable:" no GitLab.', 'The object and its history remain. To re-enable, revert the "disable:" MR on GitLab.');
    case 'STARTING': return P('in-progress', 'Iniciando o agent', 'Starting the agent', 'O controller aceitou o Agent e está subindo o pod.', 'The controller accepted the Agent and is starting the pod.');
    case 'STALLED': return P('warning', 'Atenção: o agent não ficou pronto em 15 min', 'Attention: the agent was not ready within 15 min', 'Leia as condições e os eventos abaixo. Falta de imagem ou de memória são as causas mais comuns.', 'Read the conditions and events below. Missing image or memory are the most common causes.');
    case 'READY': return P('success', 'Pronto: falta o teste A2A', 'Ready: A2A test pending', 'O agent está Ready. Faça uma pergunta no chat de teste para verificar de ponta a ponta.', 'The agent is Ready. Ask a question in the test chat to verify it end to end.');
    case 'VERIFIED': return P('success', 'Verificado por A2A', 'Verified over A2A', 'O agent respondeu pelo protocolo A2A. Está operacional.', 'The agent answered over the A2A protocol. It is operational.');
    case 'TEST_FAILED': return P('warning', 'Atenção: o teste A2A não trouxe resposta válida', 'Attention: the A2A test returned no valid answer', 'O agent está Ready, mas não respondeu com texto. Tente outra pergunta ou leia os eventos.', 'The agent is Ready but did not answer with text. Try another question or read the events.');
  }
}

export type StepState = 'done' | 'current' | 'error' | 'warning' | 'pending';
export interface TimelineStep { key: string; label: string; state: StepState }

const CREATE_STEPS = ['request', 'review', 'sync', 'start', 'ready', 'test'] as const;
const DISABLE_STEPS = ['request', 'review', 'sync', 'disabled'] as const;

const STEP_LABELS: Record<string, [string, string]> = {
  request: ['Pedido registrado', 'Request recorded'],
  review: ['Review e merge do MR', 'MR review and merge'],
  sync: ['Argo CD aplica', 'Argo CD applies'],
  start: ['Controller aceita e inicia', 'Controller accepts and starts'],
  ready: ['Agent Ready', 'Agent Ready'],
  test: ['Teste A2A', 'A2A test'],
  disabled: ['Desativado', 'Disabled'],
};

/** Onde cada fase cai na trilha, e em que estado. */
const CREATE_POSITION: Record<AgentPhase, [number, StepState]> = {
  FAILED: [0, 'error'], REQUESTED: [0, 'current'],
  IN_REVIEW: [1, 'current'], CLOSED: [1, 'error'],
  SYNCING: [2, 'current'], SYNC_STALLED: [2, 'warning'], NOT_FOUND: [0, 'warning'],
  REJECTED: [3, 'error'], STARTING: [3, 'current'], STALLED: [3, 'warning'],
  READY: [5, 'current'], TEST_FAILED: [5, 'warning'], VERIFIED: [5, 'done'],
  DISABLED: [5, 'done'],
};
const DISABLE_POSITION: Partial<Record<AgentPhase, [number, StepState]>> = {
  FAILED: [0, 'error'], REQUESTED: [0, 'current'],
  IN_REVIEW: [1, 'current'], CLOSED: [1, 'error'],
  SYNCING: [2, 'current'], SYNC_STALLED: [2, 'warning'], REJECTED: [2, 'error'],
  DISABLED: [3, 'done'],
};

export function timelineFor(op: AgentOp, phase: AgentPhase, pt: boolean): TimelineStep[] {
  // Um agent desativado segue a trilha de desativação, mesmo quando foi aberto sem pedido.
  const disableTrail = op === 'disable' || phase === 'DISABLED';
  const keys: readonly string[] = disableTrail ? DISABLE_STEPS : CREATE_STEPS;
  const [at, state] = (disableTrail ? DISABLE_POSITION[phase] : CREATE_POSITION[phase]) ?? [0, 'warning'];
  return keys.map((key, index) => ({
    key,
    label: STEP_LABELS[key][pt ? 0 : 1],
    state: index < at ? 'done' : index === at ? state : 'pending',
  }));
}

export function stepStateLabel(state: StepState, pt: boolean): string {
  const labels: Record<StepState, [string, string]> = {
    done: ['concluído', 'done'], current: ['em andamento', 'in progress'], error: ['falhou', 'failed'],
    warning: ['precisa de atenção', 'needs attention'], pending: ['aguardando', 'waiting'],
  };
  return labels[state][pt ? 0 : 1];
}

export function stepIndicator(state: StepState): IndicatorType {
  return ({ done: 'success', current: 'in-progress', error: 'error', warning: 'warning', pending: 'pending' } as const)[state];
}
