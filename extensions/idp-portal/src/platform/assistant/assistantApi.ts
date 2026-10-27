// Client do Platform Assistant. Rotas `/platform/assistant/*` da platform-api (montadas por
// backend/platform_assistant/transport.handle_http). SigV4 via the internal gateway, como os outros clients.
//
// Este módulo nunca envia `requester`, `manifest`, `namespace` nem labels: identidade vem da sessão
// e o manifest é do compiler. O servidor recusa esses campos com 400 de qualquer forma.
//
// `draft` são duas chamadas: o BFF (único lugar que alcança o gateway do modelo) devolve só o
// CANDIDATO de provision-plan/v1, e a platform-api revalida esse candidato no preview, contra o
// catálogo publicado e o projeto, antes de qualquer coisa poder ser enviada.
import type { CompensationPreview, PlanIssue, PlanPreview, PlanRun, ProvisionPlan } from './assistantModel';
import { signedResponse } from '../errors';
import { apiFetch, authAdapter } from '../auth/authAdapter';
import { ENDPOINTS, endpointForUrl } from '../auth/endpoints';

export const PLATFORM_API = ENDPOINTS.platform.url;
export const BFF_URL = ENDPOINTS.bff.url;

export class AssistantApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code: string, public readonly body: unknown = null) {
    super(message);
    this.name = 'AssistantApiError';
  }
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// Fetcher default: URL absoluta -> endpoint do adapter. O código de erro `harmony_unavailable` fica
// por compatibilidade com a UI, que o mapeia para "abra pelo the internal gateway".
function harmonyFetch(url: string, init: RequestInit): Promise<Response> {
  if (!authAdapter().available()) throw new AssistantApiError(0, 'harmony unavailable', 'harmony_unavailable');
  const endpoint = endpointForUrl(url);
  if (!endpoint) return fetch(url, init);
  return apiFetch(endpoint, url.slice(endpoint.url.length), init);
}

export interface AssistantClient {
  draft(project: string, prompt: string, selection?: { capability: string; name: string }[]): Promise<{ modelOutputAccepted: boolean; errors: { code: string; message: string }[]; preview: PlanPreview | null }>;
  preview(project: string, plan: ProvisionPlan): Promise<PlanPreview>;
  submit(project: string, plan: ProvisionPlan, idempotencyKey: string, planSha256: string): Promise<{ replayed: boolean; run: PlanRun }>;
  get(planId: string): Promise<{ run: PlanRun }>;
  refresh(planId: string): Promise<{ run: PlanRun }>;
  retry(planId: string, ref: string, expectedAttempt: number): Promise<{ replayed: boolean; run: PlanRun }>;
  compensationPreview(planId: string): Promise<CompensationPreview>;
  compensationConfirm(planId: string, compensationSha256: string): Promise<{ replayed: boolean; run: PlanRun }>;
}

const PLAN_ID = /^[0-9a-f]{32}$/;
const REF = /^[a-z][a-z0-9]{0,15}$/;

export function createAssistantClient(fetcher: Fetcher = harmonyFetch, base = PLATFORM_API, bff = BFF_URL): AssistantClient {
  const call = <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => send<T>(`${base}/platform/assistant${path}`, method, body);
  async function send<T>(url: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = signedResponse(await fetcher(url, {
        method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      }));
    } catch (cause) {
      if (cause instanceof AssistantApiError) throw cause;
      throw new AssistantApiError(0, cause instanceof Error && cause.message ? cause.message : 'network error', 'network');
    }
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const record = (parsed && typeof parsed === 'object' ? parsed : {}) as { error?: unknown; code?: unknown };
      throw new AssistantApiError(response.status, String(record.error ?? `HTTP ${response.status}`), String(record.code ?? 'http_error'), parsed);
    }
    return parsed as T;
  }
  const id = (planId: string): string => {
    if (!PLAN_ID.test(planId)) throw new AssistantApiError(400, 'invalid plan id', 'plan_id_invalid');
    return planId;
  };
  return {
    draft: async (project, prompt, selection) => {
      const proposal = await send<{ modelOutputAccepted: boolean; plan: ProvisionPlan | null; errors: PlanIssue[] }>(
        `${bff}/gateway/assistant/draft`, 'POST', selection ? { project, prompt, selection } : { project, prompt });
      if (!proposal.modelOutputAccepted || !proposal.plan) {
        return { modelOutputAccepted: false, errors: proposal.errors ?? [], preview: null };
      }
      return { modelOutputAccepted: true, errors: [], preview: await call<PlanPreview>('POST', '/preview', { project, plan: proposal.plan }) };
    },
    preview: (project, plan) => call('POST', '/preview', { project, plan }),
    submit: (project, plan, idempotencyKey, planSha256) => call('POST', '/plans', { project, plan, idempotencyKey, confirm: { planSha256 } }),
    get: (planId) => call('GET', `/plans/${id(planId)}`),
    refresh: (planId) => call('POST', `/plans/${id(planId)}/refresh`, {}),
    retry: (planId, ref, expectedAttempt) => {
      if (!REF.test(ref)) throw new AssistantApiError(400, 'invalid step ref', 'ref_invalid');
      return call('POST', `/plans/${id(planId)}/steps/${ref}/retry`, { expectedAttempt });
    },
    compensationPreview: (planId) => call('GET', `/plans/${id(planId)}/compensation`),
    compensationConfirm: (planId, compensationSha256) => call('POST', `/plans/${id(planId)}/compensation`, { confirm: { compensationSha256 } }),
  };
}
