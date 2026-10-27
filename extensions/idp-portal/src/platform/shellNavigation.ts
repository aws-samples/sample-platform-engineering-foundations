/*
 * Navegação do shell da Developer Platform, sem React e sem DOM real, para ser testável no vitest
 * sem jsdom: rota com parâmetro (`#assistant/<planId>`, `#studio/<requestId>`), título da aba,
 * foco no cabeçalho da view nova e a guarda de rascunho ao trocar de projeto.
 *
 * Fonte única do estado navegável: a URL. Nada aqui grava em storage do browser.
 * A LISTA de views (ids, títulos, rascunho) vive em `routes/routeRegistry.ts`; aqui só a mecânica.
 */
import { DRAFT_VIEW_IDS, ROUTE_ID, titleOf } from './routes/routeRegistry';

/** planId do Assistant e requestId do Studio: o mesmo formato que os servidores aceitam. */
export { ROUTE_ID };

/** `#assistant/<id>` -> `<id>` quando o hash é dessa view e o id tem o formato do servidor. */
export function routeParam(hash: string, view: string): string | null {
  const [head, param] = String(hash || '').replace(/^#/, '').split('/');
  return head === view && param && ROUTE_ID.test(param) ? param : null;
}

export function viewHash(view: string, param?: string | null): string {
  return param && ROUTE_ID.test(param) ? `#${view}/${param}` : `#${view}`;
}

/** Título da rota de caminho `/agent-platform/services/...`, que não é uma view por hash. */
const PATH_TITLES: Record<string, { pt: string; en: string }> = {
  services: { pt: 'Meus recursos', en: 'My resources' },
};
export const APP_TITLE = 'AppMod Agent Platform';

/** Título da aba por view, para leitor de tela e histórico do browser distinguirem as telas. */
export function viewTitle(view: string, pt: boolean): string {
  const fromRegistry = titleOf(view, pt);
  if (fromRegistry) return `${fromRegistry} - ${APP_TITLE}`;
  const entry = PATH_TITLES[view];
  return entry ? `${pt ? entry.pt : entry.en} - ${APP_TITLE}` : APP_TITLE;
}

/** O mínimo de DOM que o foco usa; o teste passa um fake. */
export interface FocusableLike {
  focus(options?: { preventScroll?: boolean }): void;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
}
export interface RootLike extends FocusableLike {
  querySelector(selector: string): FocusableLike | null;
}

export function focusElement(element: FocusableLike): void {
  if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
  element.focus({ preventScroll: true });
}

/** Marca do fallback do Suspense: enquanto ela está na região, a view ainda está chegando. */
export const VIEW_LOADING_ATTR = 'data-view-loading';

/**
 * Foca o h1 da view nova. A view é lazy, então o h1 pode chegar depois: tenta até `attempts`
 * frames e, sem h1, foca a própria região de conteúdo, que nunca deixa o foco perdido no item de
 * menu que acabou de sumir. Devolve a função que cancela as tentativas pendentes.
 *
 * Enquanto o fallback do Suspense (`[data-view-loading]`) está na região, o frame NÃO conta
 * contra `attempts`, até o teto `loadingAttempts`. Sem isso, um chunk lazy que demorava mais que
 * 30 frames (~0,5 s, comum na VPN) fazia o foco cair na DIV da região antes de o h1 existir:
 * finding live de 22/10/2026 em Provisionar.
 */
export function focusViewHeading(root: RootLike | null, schedule: (run: () => void) => number, cancel: (id: number) => void,
  attempts = 30, loadingAttempts = 600): () => void {
  let pending = 0;
  let stopped = false;
  const tryFocus = (left: number, loadingLeft: number) => {
    if (stopped || !root) return;
    const heading = root.querySelector('h1');
    if (heading) { focusElement(heading); return; }
    if (loadingLeft > 0 && root.querySelector(`[${VIEW_LOADING_ATTR}]`)) {
      pending = schedule(() => tryFocus(left, loadingLeft - 1));
      return;
    }
    if (left <= 0) { focusElement(root); return; }
    pending = schedule(() => tryFocus(left - 1, loadingLeft));
  };
  tryFocus(attempts, loadingAttempts);
  return () => { stopped = true; if (pending) cancel(pending); };
}

/*
 * Guarda de rascunho. Telas presas ao projeto (wizard de Create, Assistant) registram aqui que têm
 * formulário sujo; trocar de projeto com um deles registrado pede confirmação antes. Studio e Agent
 * Builder não são presos ao projeto e não são remontados na troca, então não precisam registrar.
 */
const drafts = new Map<string, string>();

export function setProjectDraft(id: string, label: string | null): void {
  if (label) drafts.set(id, label); else drafts.delete(id);
}

export function projectDrafts(): string[] {
  return [...drafts.values()];
}

/** Só para testes. */
export function resetProjectDrafts(): void {
  drafts.clear();
}

export type ProjectSwitch = { kind: 'none' } | { kind: 'apply'; project: string | null } | { kind: 'confirm'; project: string | null; drafts: string[] };

/** O que fazer ao pedir a troca para `next`. Mesmo projeto: nada. Rascunho preso ao projeto: confirmar. */
export function decideProjectSwitch(current: string | null, next: string | null, open = projectDrafts()): ProjectSwitch {
  if (current === next) return { kind: 'none' };
  return open.length ? { kind: 'confirm', project: next, drafts: open } : { kind: 'apply', project: next };
}

/** Views que guardam rascunho e por isso NÃO remontam quando o projeto muda. */
export const DRAFT_VIEWS: ReadonlySet<string> = DRAFT_VIEW_IDS;

/** Chave do Suspense do conteúdo: views de rascunho ficam montadas; as outras remontam por projeto. */
export function contentKey(view: string, project: string | null): string {
  return DRAFT_VIEWS.has(view) ? `view:${view}` : `project:${project ?? '_all'}`;
}
