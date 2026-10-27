// Client of the Service Owner Studio routes. SigV4 via the internal gateway, like the other clients.
//
// The transport is injected so the Studio is isolable: the page works against a fake in tests and
// in a local preview, and the integrator wires the real routes without touching this contract.
// This module never sends compiled artifacts, a manifest, a requester or model tools: the server
// compiles, the session names the requester, and the model has no tool to call.
import { ApiError } from '../agentBuilderApi';
import type { DraftOrigin, PreviewResponse, RequestStatus, ServiceDraft, StudioIssue, StudioOp } from './serviceStudioModel';
import { apiFetch, authAdapter } from '../auth/authAdapter';

export const ROUTES = {
  generate: '/gateway/service-drafts/generate',
  preview: '/platform/service-drafts/preview',
  request: '/platform/provision-requests',
  status: (id: string) => `/platform/provision-requests/${id}`,
} as const;

export type Transport = (base: 'bff' | 'platform', path: string, init?: RequestInit) => Promise<unknown>;

export interface GenerateResponse {
  state: 'valid' | 'invalid';
  draft: ServiceDraft;
  validation: { valid: boolean; errors: StudioIssue[]; warnings: StudioIssue[] };
  provenance: { origin: 'model'; modelAlias: string; sources: string[] };
}

export interface ServiceRequest {
  state: 'requested'; requestId: string; status: RequestStatus; kind: 'service-capability'; op: StudioOp; path: string;
  draftSha256: string | null; mrUrl?: string; error?: string;
  /** Último instante (epoch s) em que o sweep do CI leu o MR no GitLab; null = nunca confirmado. */
  statusCheckedAt?: number | null;
  /** Idade desse carimbo no instante da leitura, calculada no servidor (sem relógio do browser). */
  statusAgeSeconds?: number | null;
}

export const harmonyTransport: Transport = async (base, path, init) => {
  if (!authAdapter().available()) throw new ApiError(0, 'harmony unavailable');
  const response = await apiFetch(base === 'bff' ? 'bff' : 'platform', path, init);
  const body: unknown = await response.json().catch(() => null);
  // 200 with state=invalid and 403 with state=unauthorized are answers, not failures: the UI shows them.
  if (!response.ok && !(body && typeof body === 'object' && 'state' in body)) {
    const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${response.status}`;
    throw new ApiError(response.status, message, body);
  }
  return body;
};

const post = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });

export function serviceStudioApi(transport: Transport = harmonyTransport) {
  return {
    generate(prompt: string, locale: 'pt-BR' | 'en-US', previousDraft?: ServiceDraft): Promise<GenerateResponse> {
      return transport('bff', ROUTES.generate, post(previousDraft ? { prompt, locale, previousDraft } : { prompt, locale })) as Promise<GenerateResponse>;
    },
    preview(input: { op: 'create' | 'evolve'; draft: ServiceDraft; base?: ServiceDraft; origin: DraftOrigin; sources: string[] }): Promise<PreviewResponse> {
      return transport('platform', ROUTES.preview, post(input)) as Promise<PreviewResponse>;
    },
    request(input: { op: StudioOp; draft: ServiceDraft; base?: ServiceDraft; origin: DraftOrigin; sources: string[]; previewSha256?: string }): Promise<ServiceRequest> {
      return transport('platform', ROUTES.request, post({ kind: 'service-capability', ...input })) as Promise<ServiceRequest>;
    },
    status(requestId: string): Promise<ServiceRequest> {
      if (!/^[0-9a-f]{32}$/.test(requestId)) return Promise.reject(new ApiError(400, 'invalid request id'));
      return transport('platform', ROUTES.status(requestId)) as Promise<ServiceRequest>;
    },
  };
}

export type ServiceStudioApi = ReturnType<typeof serviceStudioApi>;
