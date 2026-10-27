/*
 * Estado da tela "Your first 10 minutes" derivado do trail (tourTrail.ts). Puro, para a tela não
 * parecer estática e para cada estado ser testado sem DOM:
 *
 *  - carregando identidade ou status vira indicador de carregamento, nunca uma lista de etapas paradas;
 *  - falhar ao ler o status vira erro com retentativa, nunca um carregamento que gira para sempre;
 *  - com pedido em andamento, a etapa atual tem nome, o progresso conta as etapas concluídas e o tempo
 *    mostrado é MEDIDO (agora menos o createdAt que o servidor gravou), nunca um número fixo;
 *  - concluído, falho e aguardando humano não usam indicador animado.
 */
import type { ProvisionRequest } from './platformApi';
import { EXPECTED_SECONDS, StepId, StepState, Trail } from './tourTrail';

export type FirstRunPhase = 'loading-identity' | 'idle' | 'loading-status' | 'status-error' | 'running' | 'slow' | 'waiting-human' | 'done' | 'error';
export type IdentityState = 'loading' | 'ready' | 'failed';

export interface FirstRunProgress {
  phase: FirstRunPhase;
  done: number;
  total: number;
  percent: number;
  current: StepId | null;
  currentState: StepState | null;
  /** Segundos desde o createdAt do pedido até a última leitura. null sem createdAt. */
  elapsedSeconds: number | null;
  /** Referência da etapa atual (EXPECTED_SECONDS, arredondada para cima a partir do spike, NÃO é medida).
   *  null quando a etapa não tem relógio (merge). */
  expectedStepSeconds: number | null;
}

/** Do pedido ao site, medido uma vez no spike de 2026-09-28 (docs/agent-platform/design-first-run.md). */
export const SPIKE_TOTAL_SECONDS = 9 * 60 + 16;

export interface FirstRunInput {
  identity: IdentityState;
  requestId: string;
  request: ProvisionRequest | null;
  trail: Trail;
  now: number;
  /** A última leitura do status falhou e ainda não há pedido lido: não é carregamento, é erro. */
  statusError: boolean;
}

export function firstRunProgress({ identity, requestId, request, trail, now, statusError }: FirstRunInput): FirstRunProgress {
  const total = trail.steps.length;
  const done = trail.steps.filter(step => step.state === 'done').length;
  const currentStep = trail.steps.find(step => step.id === trail.current) ?? null;
  const base = {
    done, total, percent: total ? Math.round((done / total) * 100) : 0,
    current: trail.current, currentState: currentStep?.state ?? null,
    elapsedSeconds: request?.createdAt ? Math.max(0, now - request.createdAt) : null,
    expectedStepSeconds: trail.current && EXPECTED_SECONDS[trail.current] > 0 ? EXPECTED_SECONDS[trail.current] : null,
  };
  const phase: FirstRunPhase = identity === 'loading' ? 'loading-identity'
    : !requestId ? 'idle'
      : !request ? (statusError ? 'status-error' : 'loading-status')
        : trail.steps.some(step => step.state === 'error') ? 'error'
          : done === total ? 'done'
            : currentStep?.state === 'waiting-human' ? 'waiting-human'
              : currentStep?.state === 'slow' ? 'slow'
                : 'running';
  return { ...base, phase };
}

/** "9 min 16 s", "45 s", "12 min". Sem horas: o tour expira em 24 h e o pior caso é o merge humano. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(s / 60);
  const rest = s % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}
