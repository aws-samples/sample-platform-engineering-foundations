/*
 * Client de GET /platform/scope (platform-api, SigV4 via the internal gateway). Mesma URL e role que
 * platformApi.ts registra: registrar de novo com a configuração idêntica é idempotente, e o
 * alternativo seria editar um módulo de outra frente.
 *
 * O erro carrega o status porque a UI trata cada um de um jeito: 403 é sessão sem acesso ao
 * portal, 503 é registry de escopo indisponível no deploy, 0 é rede. Nenhum vira "sem projeto".
 */
import { asScopeContext, ScopeContext } from './scopeModel';
import { signedResponse } from '../errors';
import { apiFetch } from '../auth/authAdapter';
import { ENDPOINTS } from '../auth/endpoints';

export class ScopeRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly aborted: boolean;
  constructor(status: number, message: string, code = '', aborted = false) {
    super(message);
    this.name = 'ScopeRequestError';
    this.status = status;
    this.code = code;
    this.aborted = aborted;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Default: fetch autenticado pelo adapter. Testes injetam um `FetchLike` e recebem a URL completa. */
const adapterFetch: FetchLike = (input, init) => apiFetch('platform', input.slice(ENDPOINTS.platform.url.length), init);

export async function getScopeContext(signal?: AbortSignal, fetchImpl: FetchLike = adapterFetch): Promise<ScopeContext> {
  let response: Response;
  try {
    response = signedResponse(await fetchImpl(`${ENDPOINTS.platform.url}/platform/scope`, { headers: { 'Content-Type': 'application/json' }, signal }));
  } catch (cause) {
    const aborted = (cause instanceof Error && cause.name === 'AbortError') || Boolean(signal?.aborted);
    if (aborted) throw new ScopeRequestError(0, 'request aborted', '', true);
    throw new ScopeRequestError(0, cause instanceof Error && cause.message ? cause.message : 'platform API unreachable');
  }
  const body: unknown = await response.json().catch(() => ({}));
  const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof payload.error === 'string' && payload.error ? payload.error : `HTTP ${response.status}`;
    throw new ScopeRequestError(response.status, message, typeof payload.code === 'string' ? payload.code : '');
  }
  return asScopeContext(body);
}
