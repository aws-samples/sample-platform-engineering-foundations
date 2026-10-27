/**
 * Auth adapter: como o frontend obtém uma Response AUTENTICADA de uma API do portal.
 *
 * Duas implementações, uma interface:
 *
 * - `harmony`: o portal roda dentro do Amazon the internal gateway, que injeta `window.harmony.authorization`.
 *   `registerApi({ url, roleArn, region })` faz o `fetch` global daquela origem sair assinado com
 *   SigV4 pela role de invocação; sem sessão the corporate SSO o fetch "resolve" com algo que não é Response
 *   (ver `signedResponse`). É o que o portal interno usa hoje.
 * - `bearer`: o portal roda fora do the internal gateway (extension do aws-samples): um token OIDC/Cognito vai no
 *   header `Authorization: Bearer`, e o API Gateway valida com um JWT authorizer. O provedor do
 *   token é injetado (`setTokenProvider`), então este módulo não conhece Cognito nem Amplify.
 *
 * Os clients chamam `apiFetch(endpointId, path, init)` e recebem uma `Response` de verdade ou uma
 * exceção tipada (`SessionMissingError` quando não há sessão; `AuthUnavailableError` quando o
 * runtime de auth não existe). O modo vem do build (`VITE_AUTH_MODE`), com `harmony` como default
 * para o bundle interno; testes trocam o adapter com `setAuthAdapter`.
 */
import { SessionMissingError, signedResponse } from '../errors';
import { Endpoint, EndpointId, ENDPOINTS } from './endpoints';
import { HARMONY_ROLE_ARN_DEFAULT } from '../deployment';

export type AuthMode = 'harmony' | 'bearer';

export interface AuthAdapter {
  readonly mode: AuthMode;
  /** O runtime de auth está presente (the internal gateway injetado; token provider configurado). */
  available(): boolean;
  /** Prepara o endpoint uma vez (registerApi no the internal gateway; no-op no bearer). */
  prepare(endpoint: Endpoint): void;
  /** Fetch autenticado. Devolve Response real ou lança SessionMissingError/AuthUnavailableError. */
  fetch(endpoint: Endpoint, path: string, init?: RequestInit): Promise<Response>;
}

/** O runtime de autenticação não está presente (fora do the internal gateway; sem token provider). */
export class AuthUnavailableError extends Error {
  constructor(mode: AuthMode) {
    super(mode === 'harmony' ? 'harmony unavailable' : 'authentication unavailable');
    this.name = 'AuthUnavailableError';
  }
}

// Role de invocação do the internal gateway: uma só para as três APIs, lida do build para a extension não a levar.
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
export const HARMONY_ROLE_ARN = env.VITE_HARMONY_ROLE_ARN?.trim() || HARMONY_ROLE_ARN_DEFAULT;

type HarmonyWindow = Window & {
  harmony?: { authorization?: { registerApi(config: { url: string; roleArn: string; region: string }): void } };
};

function harmonyAuthorization() {
  return typeof window === 'undefined' ? undefined : (window as HarmonyWindow).harmony?.authorization;
}

const withJson = (init?: RequestInit): RequestInit =>
  ({ ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });

export function harmonyAdapter(): AuthAdapter {
  const registered = new Set<string>();
  return {
    mode: 'harmony',
    available: () => typeof harmonyAuthorization()?.registerApi === 'function',
    prepare(endpoint) {
      if (registered.has(endpoint.url)) return;
      // Registrar fora do the internal gateway é no-op silencioso: o fetch sai sem assinatura e o servidor nega,
      // que é o comportamento que os clients já tratavam. Quem exige o runtime usa `available()`.
      harmonyAuthorization()?.registerApi?.({ url: endpoint.url, roleArn: HARMONY_ROLE_ARN, region: endpoint.region });
      registered.add(endpoint.url);
    },
    async fetch(endpoint, path, init) {
      this.prepare(endpoint);
      return signedResponse(await fetch(`${endpoint.url}${path}`, withJson(init)));
    },
  };
}

export type TokenProvider = () => Promise<string | null> | string | null;

export function bearerAdapter(tokenProvider: TokenProvider | null): AuthAdapter {
  return {
    mode: 'bearer',
    available: () => tokenProvider !== null,
    prepare() { /* nada a registrar: o token vai por request */ },
    async fetch(endpoint, path, init) {
      if (!tokenProvider) throw new AuthUnavailableError('bearer');
      const token = await tokenProvider();
      if (!token) throw new SessionMissingError();
      const prepared = withJson(init);
      return fetch(`${endpoint.url}${path}`, { ...prepared, headers: { ...(prepared.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
    },
  };
}

export const AUTH_MODE: AuthMode = env.VITE_AUTH_MODE === 'bearer' ? 'bearer' : 'harmony';

let tokenProvider: TokenProvider | null = null;
/** Extension: quem integra o login (Cognito, OIDC) entrega aqui a função que devolve o token atual. */
export function setTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider;
  if (active.mode === 'bearer') active = bearerAdapter(provider);
}

let active: AuthAdapter = AUTH_MODE === 'bearer' ? bearerAdapter(null) : harmonyAdapter();

export function authAdapter(): AuthAdapter {
  return active;
}

/** Só para testes: troca o adapter ativo (ou volta ao default com `null`). */
export function setAuthAdapter(adapter: AuthAdapter | null): void {
  active = adapter ?? (AUTH_MODE === 'bearer' ? bearerAdapter(tokenProvider) : harmonyAdapter());
}

/** Fetch autenticado a uma API do portal: `apiFetch('cluster', '/cluster/overview')`. */
export function apiFetch(endpoint: EndpointId | Endpoint, path: string, init?: RequestInit): Promise<Response> {
  const target = typeof endpoint === 'string' ? ENDPOINTS[endpoint] : endpoint;
  return active.fetch(target, path, init);
}

/** Lança `AuthUnavailableError` quando o runtime de auth não existe; para clients que exigem o the internal gateway. */
export function requireAuth(): void {
  if (!active.available()) throw new AuthUnavailableError(active.mode);
}
