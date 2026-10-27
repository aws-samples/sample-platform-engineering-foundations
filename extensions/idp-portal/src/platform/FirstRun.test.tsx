/*
 * Tela "Your first 10 minutes": um teste por estado. O projeto não tem jsdom, então o modelo é puro e a
 * view é renderizada no servidor com os estados prontos, que é o que se quer afirmar:
 *
 *  - carregando identidade ou status mostra indicador de carregamento, não etapas paradas;
 *  - falhar ao ler o status mostra erro com retentativa, nunca carregamento infinito;
 *  - a referência por etapa nunca é chamada de "medida";
 *  - com pedido em andamento há bloco de progresso: StatusIndicator in-progress, nome da etapa atual,
 *    barra pelas etapas concluídas, tempo MEDIDO desde o pedido e texto de polling;
 *  - concluído, falho e aguardando humano não têm indicador animado;
 *  - "9 minutos" nunca aparece como fato fixo durante um run;
 *  - nenhum texto da tela tem em dash.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import viewSource from './FirstRun.tsx?raw';
import modelSource from './firstRunModel.ts?raw';
import type { ProvisionRequest } from './platformApi';
import { tourTrail, EXPECTED_SECONDS, TourInstance } from './tourTrail';
import { firstRunProgress, formatDuration, IdentityState, SPIKE_TOTAL_SECONDS } from './firstRunModel';
import { FirstRunView, FirstRunViewProps, POLL_MS } from './FirstRun';

const CREATED_AT = 1_000;
const req = (status: ProvisionRequest['status']): ProvisionRequest =>
  ({ requestId: 'a'.repeat(32), status, path: 'platform/instances/tour-alice.yaml', createdAt: CREATED_AT, mrUrl: 'https://gitlab.example/mr/1' });
const DEPLOYED: TourInstance = { state: 'ACTIVE', outputs: { distributionStatus: 'Deployed', url: 'https://d1.cloudfront.net' } };

interface Scenario { identity?: IdentityState; requestId?: string; request?: ProvisionRequest | null; instance?: TourInstance | null; published?: boolean; now?: number; statusError?: boolean }

function viewProps({ identity = 'ready', requestId = 'a'.repeat(32), request = null, instance = null, published = false, now = CREATED_AT + 192, statusError = false }: Scenario): FirstRunViewProps {
  const trail = tourTrail({ request, instance, published, now, activeSince: CREATED_AT });
  return {
    locale: 'en-US', alias: identity === 'ready' ? 'alice' : '', requestId, request, trail,
    progress: firstRunProgress({ identity, requestId, request, trail, now, statusError }),
    statusError,
    lastReadAt: request ? now : null, published, error: statusError ? 'HTTP 500' : '', busy: false, demo: false, demoUrl: '',
    onStart: () => undefined, onPublish: () => undefined, onDismissError: () => undefined, onDemoChange: () => undefined,
  };
}
const render = (scenario: Scenario, locale = 'en-US') => renderToStaticMarkup(<FirstRunView {...viewProps(scenario)} locale={locale} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const IN_PROGRESS = /awsui_status-in-progress_/;
const LOADING = /awsui_status-loading_/;

const originalError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return;
    originalError(...args);
  });
});
afterAll(() => { vi.restoreAllMocks(); });

describe('firstRunProgress', () => {
  const at = (scenario: Scenario) => {
    const { identity = 'ready', requestId = 'a'.repeat(32), request = null, instance = null, published = false, now = CREATED_AT + 192, statusError = false } = scenario;
    const trail = tourTrail({ request, instance, published, now, activeSince: CREATED_AT });
    return firstRunProgress({ identity, requestId, request, trail, now, statusError });
  };

  it('distingue carregar a identidade, carregar o status e ainda não ter pedido', () => {
    expect(at({ identity: 'loading', requestId: '' }).phase).toBe('loading-identity');
    expect(at({ requestId: '' }).phase).toBe('idle');
    expect(at({ request: null }).phase).toBe('loading-status');
  });

  it('falhar ao ler o status sem pedido lido é status-error, não carregamento', () => {
    expect(at({ request: null, statusError: true }).phase).toBe('status-error');
    // Com o pedido já lido, uma leitura falha não apaga o progresso conhecido.
    expect(at({ request: req('merged'), statusError: true }).phase).toBe('running');
  });

  it('em andamento conta as etapas concluídas, nomeia a atual e mede o tempo pelo createdAt', () => {
    const p = at({ request: req('merged'), now: CREATED_AT + 192 });
    expect(p).toMatchObject({ phase: 'running', current: 'gitops', done: 3, total: 6, percent: 50, elapsedSeconds: 192 });
    expect(p.expectedStepSeconds).toBe(EXPECTED_SECONDS.gitops);
  });

  it('o merge humano é waiting-human, sem tempo esperado', () => {
    expect(at({ request: req('mr_open') })).toMatchObject({ phase: 'waiting-human', current: 'merge', done: 2, percent: 33, expectedStepSeconds: null });
  });

  it('passar de duas vezes o tempo medido vira slow', () => {
    expect(at({ request: req('merged'), now: CREATED_AT + 2 * EXPECTED_SECONDS.gitops + 1 }).phase).toBe('slow');
  });

  it('concluído é 100% e falho é error', () => {
    expect(at({ request: req('merged'), instance: DEPLOYED, published: true })).toMatchObject({ phase: 'done', done: 6, percent: 100 });
    expect(at({ request: req('failed') })).toMatchObject({ phase: 'error', current: 'request' });
    expect(at({ request: req('closed') })).toMatchObject({ phase: 'error', current: 'merge' });
  });

  it('formata a duração medida sem arredondar para um número redondo', () => {
    expect(formatDuration(SPIKE_TOTAL_SECONDS)).toBe('9 min 16 s');
    expect(formatDuration(192)).toBe('3 min 12 s');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(600)).toBe('10 min');
  });
});

describe('FirstRunView', () => {
  it('carregando a identidade mostra indicador de carregamento e nenhuma etapa', () => {
    const html = render({ identity: 'loading', requestId: '' });
    expect(html).toMatch(LOADING);
    expect(text(html)).toContain('Loading your identity and saved request...');
    expect(text(html)).not.toContain('Create my site');
    expect(text(html)).not.toContain('Request recorded');
  });

  it('com pedido salvo e status ainda não lido mostra carregamento, não etapas paradas', () => {
    const html = render({ request: null });
    expect(html).toMatch(LOADING);
    expect(text(html)).toContain('Reading the status of your request...');
    expect(text(html)).not.toContain('Request recorded');
  });

  it('falha ao ler o status mostra erro com retentativa, sem carregamento e sem etapas paradas', () => {
    const html = render({ request: null, statusError: true });
    const t = text(html);
    expect(html).not.toMatch(LOADING);
    expect(html).not.toMatch(IN_PROGRESS);
    expect(html).toMatch(/awsui_status-error_/);
    expect(t).toContain(`Could not read the status of your request. Trying again every ${POLL_MS / 1000} s.`);
    expect(t).not.toContain('Reading the status of your request...');
    expect(t).not.toContain('Request recorded');
    expect(text(render({ request: null, statusError: true }, 'pt-BR'))).toContain('Não consegui ler o status do seu pedido. Tentando de novo a cada 10 s.');
  });

  it('a referência por etapa vem de EXPECTED_SECONDS e nunca é rotulada como medida', () => {
    // Única frase "medido/measured" do bloco é o tempo desde o pedido, calculado pelo createdAt.
    expect(viewSource).not.toMatch(/medido no spike|measured in the spike/);
    expect(modelSource).not.toMatch(/expectedStepSeconds.*medido no spike/);
    for (const status of ['pending', 'processing', 'mr_open', 'merged'] as const) {
      for (const locale of ['en-US', 'pt-BR']) {
        const t = text(render({ request: req(status) }, locale));
        expect(t).not.toMatch(/(Reference for this step|Referência para esta etapa)[^.]*(measured|medido)/);
      }
    }
  });

  it('o polling para quando o run termina, inclusive em erro terminal', () => {
    expect(viewSource).toMatch(/const settled = finished \|\| trail\.steps\.some\(s => s\.state === 'error'\);/);
    expect(viewSource).toMatch(/if \(!requestId \|\| settled\) return undefined;/);
  });

  it('sem pedido, o tempo aparece como expectativa rotulada, nunca como fato fixo', () => {
    const t = text(render({ requestId: '' }));
    expect(t).toContain('Expected: about 9 min 16 s from request to site, measured once in the 2026-09-28 spike');
    expect(t).not.toContain('Measured time from request to site: 9 minutes');
  });

  it('em andamento mostra o bloco de progresso com a etapa atual em destaque, barra, tempo medido e polling', () => {
    const html = render({ request: req('merged'), now: CREATED_AT + 192 });
    const t = text(html);
    expect(html).toMatch(IN_PROGRESS);
    expect(t).toContain('Now: GitOps mirror and Argo CD');
    expect(t).toContain('3 of 6 steps done');
    expect(html).toMatch(/aria-valuenow="50"|value="50"/);
    expect(t).toContain('Time since the request: 3 min 12 s, measured from when the request was recorded.');
    expect(t).toContain('Reference for this step: up to about 5 min.');
    expect(t).not.toMatch(/measured in the spike/i);
    expect(t).toContain(`Checking every ${POLL_MS / 1000} s.`);
    expect(t).toMatch(/Last update: \S+/);
    expect(t).toMatch(/GitOps mirror and Argo CD Now/);
    // O LiveRegion só preenche a região aria-live no cliente; no render de servidor prova-se pelo código.
    expect(viewSource).toMatch(/<LiveRegion>\s*<StatusIndicator type=\{type\}>\{headline\}<\/StatusIndicator>\s*<\/LiveRegion>/);
    expect(t).not.toContain('9 min');
  });

  it('atraso destaca a etapa atual com warning e orientação operacional, sem spinner', () => {
    const html = render({ request: req('merged'), now: CREATED_AT + 2 * EXPECTED_SECONDS.gitops + 1 });
    const t = text(html);
    expect(html).toMatch(/awsui_status-warning_/);
    expect(html).not.toMatch(LOADING);
    expect(t).toContain('Taking longer than usual: GitOps mirror and Argo CD');
    expect(t).toMatch(/GitOps mirror and Argo CD Now/);
    expect(t).toContain('Open Argo CD');
  });

  it('falha transitória preserva o progresso conhecido e mantém o retry visível', () => {
    const html = render({ request: req('merged'), statusError: true });
    const t = text(html);
    expect(html).not.toMatch(LOADING);
    expect(t).toContain('Status temporarily unavailable. Showing the last known progress and trying again every 10 s.');
    expect(t).toContain('Now: GitOps mirror and Argo CD');
    expect(text(render({ request: req('merged'), statusError: true }, 'pt-BR'))).toContain('Status temporariamente indisponível. Mostrando o último progresso conhecido e tentando de novo a cada 10 s.');
  });

  it('aguardando o operador não usa indicador animado e diz que a etapa não tem relógio', () => {
    const html = render({ request: req('mr_open') });
    const t = text(html);
    expect(html).not.toMatch(IN_PROGRESS);
    expect(html).not.toMatch(LOADING);
    expect(t).toContain('Waiting for the operator approval: Merged to main');
    expect(t).toContain('This step has no expected time: it depends on the operator.');
  });

  it('concluído mostra sucesso, sem animação, sem polling e sem relógio correndo', () => {
    const html = render({ request: req('merged'), instance: DEPLOYED, published: true });
    const t = text(html);
    expect(html).not.toMatch(IN_PROGRESS);
    expect(html).not.toMatch(LOADING);
    expect(t).toContain('Your site is live');
    expect(t).toContain('6 of 6 steps done');
    expect(t).not.toContain('Checking every');
    expect(t).not.toContain('Time since the request');
    expect(t).not.toMatch(/\bNow\b/);
  });

  it('falho mostra erro na etapa que parou, sem animação e sem polling', () => {
    const html = render({ request: req('closed') });
    const t = text(html);
    expect(html).not.toMatch(IN_PROGRESS);
    expect(html).not.toMatch(LOADING);
    expect(t).toContain('Stopped at: Merged to main');
    expect(t).toContain('The merge request was closed without merging.');
    expect(t).not.toContain('Checking every');
  });

  it('pt-BR fala português no bloco de progresso', () => {
    const t = text(render({ request: req('merged'), now: CREATED_AT + 192 }, 'pt-BR'));
    expect(t).toContain('Agora: Mirror GitOps e Argo CD');
    expect(t).toContain('3 de 6 etapas concluídas');
    expect(t).toContain('Verificando a cada 10 s.');
  });

  it('o código e o texto da tela não têm em dash', () => {
    expect(viewSource).not.toContain('\u2014');
    expect(modelSource).not.toContain('\u2014');
    for (const scenario of [{ request: req('merged') }, { request: req('mr_open') }, { requestId: '' }]) {
      expect(text(render(scenario))).not.toContain('\u2014');
      expect(text(render(scenario, 'pt-BR'))).not.toContain('\u2014');
    }
  });
});
