/*
 * O trail do tour dos primeiros passos (docs/agent-platform/design-first-run.md): de um pedido,
 * da instância no cluster e do estado da publicação, deriva em que etapa o site do SA está.
 * Puro, para ser testado sem tela. Cada etapa tem um tempo de referência, arredondado para
 * cima a partir do spike de 2026-09-28 (NÃO é a medida); passar de duas vezes esse tempo vira
 * "demorando mais que o normal", nunca um spinner infinito. O merge não tem relógio: enquanto o bot não mergeia, ele espera um humano.
 */
import type { ProvisionRequest } from './platformApi';

export type StepId = 'request' | 'mr' | 'merge' | 'gitops' | 'cloudfront' | 'page';
export type StepState = 'pending' | 'active' | 'slow' | 'waiting-human' | 'done' | 'error';
export interface TrailStep { id: StepId; state: StepState }
export interface TourInstance { state: string; outputs?: Record<string, string> }
export interface TrailInput {
  request: ProvisionRequest | null;
  instance: TourInstance | null;
  published: boolean;
  now: number;                 // epoch em segundos
  activeSince: number | null;  // quando a etapa atual começou, visto pelo portal
}
export interface Trail { steps: TrailStep[]; current: StepId | null; url: string; expiresAt: number }

// Referências, não medidas. O spike de 2026-09-28 (docs/agent-platform/design-first-run.md) mediu uma vez:
// MR aberto 53 s, validação e merge 1 min 14 s, mirror 2 min 56 s mais Argo 52 s, CloudFront 3 min 21 s.
// Pedido e página nunca foram medidos: 60 s e 30 s são estimativas.
export const EXPECTED_SECONDS: Record<StepId, number> = {
  request: 60, mr: 90, merge: 0, gitops: 300, cloudfront: 300, page: 30,
};
const ORDER: StepId[] = ['request', 'mr', 'merge', 'gitops', 'cloudfront', 'page'];
export const TOUR_TTL_SECONDS = 24 * 3600;

export function tourTrail({ request, instance, published, now, activeSince }: TrailInput): Trail {
  const status = request?.status;
  const deployed = instance?.outputs?.distributionStatus === 'Deployed' && Boolean(instance.outputs.url);
  const done: Record<StepId, boolean> = {
    request: Boolean(status && status !== 'pending' && status !== 'processing'),
    mr: Boolean(instance) || status === 'mr_open' || status === 'merged',
    merge: Boolean(instance) || status === 'merged',
    gitops: Boolean(instance),
    cloudfront: deployed,
    page: deployed && published,
  };
  const failedAt: StepId | null = status === 'failed' ? 'request' : status === 'closed' && !instance ? 'merge' : null;
  const current = request ? ORDER.find(id => !done[id]) ?? null : null;
  const steps = ORDER.map((id): TrailStep => {
    if (id === failedAt) return { id, state: 'error' };
    if (done[id]) return { id, state: 'done' };
    if (id !== current || failedAt) return { id, state: 'pending' };
    if (id === 'merge') return { id, state: 'waiting-human' };
    const late = activeSince !== null && now - activeSince > 2 * EXPECTED_SECONDS[id];
    return { id, state: late ? 'slow' : 'active' };
  });
  return {
    steps,
    current: failedAt ?? current,
    url: deployed ? instance!.outputs!.url : '',
    expiresAt: request?.createdAt ? request.createdAt + TOUR_TTL_SECONDS : 0,
  };
}
