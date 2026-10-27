/**
 * Cognito Hosted UI + Authorization Code com PKCE, para o flavor público (`VITE_AUTH_MODE=bearer`).
 *
 * Sem Amplify: três chamadas HTTP e `crypto.subtle`. O portal manda o ACCESS token ao API Gateway
 * (authorizer JWT valida assinatura, expiração, issuer e `client_id`); o backend lê o alias da claim
 * `username`. Tokens ficam em `sessionStorage` (morrem com a aba), o `code_verifier` também. Nada
 * aqui é usado no bundle interno: `bootstrapCognito` devolve `false` quando o modo não é bearer ou
 * quando as variáveis do Cognito não foram definidas no build.
 *
 * Variáveis do Vite: VITE_COGNITO_DOMAIN (ex.: https://idp-portal-xyz.auth.us-east-1.amazoncognito.com),
 * VITE_COGNITO_CLIENT_ID. O redirect é a URL atual sem query nem hash, que tem que estar nas
 * callback URLs do app client.
 */
import { AUTH_MODE, setTokenProvider } from './authAdapter';

const env = import.meta.env as Record<string, string | undefined>;
const STORAGE_KEY = 'idp-portal.cognito';
const VERIFIER_KEY = 'idp-portal.cognito.verifier';
const REFRESH_MARGIN_MS = 60_000;

export interface CognitoConfig { domain: string; clientId: string; redirectUri: string }
interface StoredTokens { accessToken: string; idToken: string; refreshToken: string | null; expiresAt: number }

export function cognitoConfig(): CognitoConfig | null {
  const domain = env.VITE_COGNITO_DOMAIN?.trim().replace(/\/$/, '');
  const clientId = env.VITE_COGNITO_CLIENT_ID?.trim();
  if (!domain || !clientId) return null;
  return { domain, clientId, redirectUri: `${window.location.origin}${window.location.pathname}` };
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const verifier = base64url(random.buffer);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(digest) };
}

function readTokens(): StoredTokens | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
  } catch { return null; }
}

function writeTokens(tokens: StoredTokens | null): void {
  if (tokens) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tokens)); else sessionStorage.removeItem(STORAGE_KEY);
}

async function tokenRequest(config: CognitoConfig, body: Record<string, string>): Promise<StoredTokens> {
  const response = await fetch(`${config.domain}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, ...body }).toString(),
  });
  if (!response.ok) throw new Error(`cognito token endpoint ${response.status}`);
  const json = await response.json() as { access_token: string; id_token: string; refresh_token?: string; expires_in: number };
  const previous = readTokens();
  return { accessToken: json.access_token, idToken: json.id_token, refreshToken: json.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: Date.now() + json.expires_in * 1000 };
}

export async function signIn(config: CognitoConfig): Promise<void> {
  const { verifier, challenge } = await pkcePair();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const params = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri,
    scope: 'openid email profile', code_challenge_method: 'S256', code_challenge: challenge, state: window.location.hash.slice(1) });
  window.location.assign(`${config.domain}/oauth2/authorize?${params.toString()}`);
}

export function signOut(config: CognitoConfig): void {
  writeTokens(null);
  window.location.assign(`${config.domain}/logout?${new URLSearchParams({ client_id: config.clientId, logout_uri: config.redirectUri }).toString()}`);
}

/** Troca `?code=` por tokens quando é o retorno do Hosted UI; devolve o hash a restaurar, ou null. */
async function completeRedirect(config: CognitoConfig): Promise<string | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  if (!code) return null;
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!verifier) throw new Error('cognito: code without verifier (login started in another tab?)');
  writeTokens(await tokenRequest(config, { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, code_verifier: verifier }));
  const state = url.searchParams.get('state') ?? '';
  url.searchParams.delete('code'); url.searchParams.delete('state');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${state ? `#${state}` : ''}`);
  return state;
}

async function currentAccessToken(config: CognitoConfig): Promise<string | null> {
  const tokens = readTokens();
  if (!tokens) return null;
  if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) return tokens.accessToken;
  if (!tokens.refreshToken) { writeTokens(null); return null; }
  try {
    const refreshed = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    writeTokens(refreshed);
    return refreshed.accessToken;
  } catch { writeTokens(null); return null; }
}

/**
 * Chamado antes do primeiro render. No modo bearer com Cognito configurado: completa o redirect, ou
 * inicia o login se não há sessão, e injeta o provider de token. Devolve `true` quando o app pode
 * renderizar autenticado; `false` quando este bundle não usa Cognito (interno) ou quando redirecionou.
 */
export async function bootstrapCognito(): Promise<boolean> {
  const config = cognitoConfig();
  if (AUTH_MODE !== 'bearer' || !config) return false;
  await completeRedirect(config);
  if (!(await currentAccessToken(config))) { await signIn(config); return false; }
  setTokenProvider(() => currentAccessToken(config));
  return true;
}
