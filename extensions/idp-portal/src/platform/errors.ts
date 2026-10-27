import { IDENTITY_PROVIDER } from './deployment';
// the internal gateway rejects signed fetches with a plain object ({ name, message, retryable }), not an Error.
// Collapsing that to a generic string hid the real cause (role not registered) for days.
//
// Sem sessão the corporate SSO, o fetch assinado pelo the internal gateway resolve com algo que não é Response, e o primeiro
// `.json()` estoura como TypeError minificado ("h.json is not a function"). Medido em 24/10/2026 na
// Home: o texto chegava literalmente ao usuário. A detecção certa é na origem (`signedResponse`),
// antes de chamar `.json()`; a regex abaixo é só o fallback para o caso de algum caminho escapar.
export const SESSION_EXPIRED_MESSAGE = `${IDENTITY_PROVIDER} session expired or missing: reload the page to sign in again`;

export class SessionMissingError extends Error {
  constructor() {
    super(SESSION_EXPIRED_MESSAGE);
    this.name = 'SessionMissingError';
  }
}

/**
 * Confere que o que o fetch assinado devolveu é uma Response de verdade. Chamar logo depois de
 * `await fetch(...)` e antes de qualquer `.json()`/`.text()`.
 */
export function signedResponse(value: unknown): Response {
  const candidate = value as { json?: unknown } | null | undefined;
  if (!candidate || typeof candidate.json !== 'function') throw new SessionMissingError();
  return value as Response;
}

// Só identificador MINIFICADO (1 ou 2 caracteres) ou o "(intermediate value)" do Chrome. Um nome
// legível como `data.json` é bug nosso, e tem que continuar aparecendo como está. O sufixo opcional
// é a forma do Safari: "h.json is not a function. (In 'h.json()', 'h.json' is undefined)".
const MISSING_SESSION_SIGNATURE = /^(?:[A-Za-z_$][\w$]?|\(intermediate value\))\.(json|text) is not a function(?:\. \(In .*\))?$/;

export function isMissingSessionError(cause: unknown): boolean {
  if (cause instanceof SessionMissingError) return true;
  return cause instanceof TypeError && MISSING_SESSION_SIGNATURE.test(cause.message);
}

export function errorMessage(cause: unknown, fallback: string): string {
  if (isMissingSessionError(cause)) return SESSION_EXPIRED_MESSAGE;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  if (typeof cause === 'string' && cause) return cause;
  return fallback;
}
