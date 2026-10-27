// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationBox, PlatformEvent, PlatformEventList } from './platformApi';

class ResizeObserverStub { observe(): void { /* jsdom */ } unobserve(): void { /* noop */ } disconnect(): void { /* noop */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listEvents = vi.fn<(filters?: unknown) => Promise<PlatformEventList>>();
const getNotifications = vi.fn<() => Promise<NotificationBox>>();
const markNotificationsRead = vi.fn<(input: unknown) => Promise<{ ok: boolean }>>();
vi.mock('./platformApi', async () => {
  const actual = await vi.importActual<typeof import('./platformApi')>('./platformApi');
  return { ...actual, listEvents: (f?: unknown) => listEvents(f), getNotifications: () => getNotifications(), markNotificationsRead: (i: unknown) => markNotificationsRead(i) };
});

const { actionLabel, eventSummary, eventTarget, matchesEvent, relativeTime, resultIndicator, EVENT_ACTIONS } = await import('./eventsModel');
const { NotificationsPanel } = await import('./NotificationsPanel');
const { AuditLogPage } = await import('./AuditLogPage');
const { PlatformApiError } = await import('./platformApi');
const { I18nProvider } = await import('./i18n');

function ev(patch: Partial<PlatformEvent> = {}): PlatformEvent {
  return { id: 'a'.repeat(32), time: Math.floor(Date.now() / 1000) - 120, actor: 'platform-admin', action: 'workload.restarted', kind: 'Deployment',
    name: 'web', namespace: 'appmod', project: 'agent-platform', result: 'ok', detail: '', link: '/agent-platform/#cluster', source: 'cluster-api', ...patch };
}

let roots: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];
async function mount(element: JSX.Element): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => { root.render(element); });
  await act(async () => { await Promise.resolve(); });
  return host;
}
afterEach(async () => {
  for (const { root, host } of roots) { await act(async () => { root.unmount(); }); host.remove(); }
  roots = [];
  vi.clearAllMocks();
});

describe('eventsModel', () => {
  it('rotula toda ação do vocabulário nos dois idiomas e deixa ação desconhecida como está', () => {
    for (const action of EVENT_ACTIONS) {
      expect(actionLabel(action, true)).not.toBe(action);
      expect(actionLabel(action, false)).not.toBe(action);
    }
    expect(actionLabel('made.up', true)).toBe('made.up');
  });
  it('resumo, indicador por resultado, alvo interno e tempo relativo', () => {
    expect(eventSummary(ev(), true)).toBe('Workload reiniciado · Deployment appmod/web · por platform-admin');
    expect(resultIndicator('failed', false)).toEqual({ type: 'error', text: 'failed' });
    expect(resultIndicator('denied', true)).toEqual({ type: 'warning', text: 'negado' });
    expect(eventTarget({ link: '/agent-platform/#assistant/' + 'b'.repeat(32) })).toEqual({ hash: '#assistant/' + 'b'.repeat(32) });
    expect(eventTarget({ link: 'https://evil.example/#home' })).toBeNull();
    expect(eventTarget({ link: '' })).toBeNull();
    const now = 1_700_000_000_000;
    expect(relativeTime(now / 1000 - 30, true, now)).toBe('agora');
    expect(relativeTime(now / 1000 - 600, false, now)).toBe('10 min ago');
    expect(relativeTime(now / 1000 - 3 * 86_400, true, now)).toBe('há 3 d');
    expect(matchesEvent(ev({ detail: 'replicas=3' }), 'REPLICAS')).toBe(true);
    expect(matchesEvent(ev(), 'nope')).toBe(false);
  });
});

describe('NotificationsPanel', () => {
  it('lista com não lidas em destaque, marca todas, abre o alvo interno', async () => {
    const onOpen = vi.fn(); const onMarkAllRead = vi.fn();
    const box: NotificationBox = { unread: 1, readAt: 0, items: [
      { ...ev(), read: false },
      { ...ev({ id: 'b'.repeat(32), action: 'provision.merged', kind: 'ProvisionRequest', name: 'r1', namespace: '', link: '/agent-platform/#provision' }), read: true },
    ] };
    const host = await mount(<NotificationsPanel state={{ status: 'ready', box }} pt onMarkAllRead={onMarkAllRead} onOpen={onOpen} onRetry={() => undefined} />);
    expect(host.textContent).toContain('1 não lida(s) de 2');
    expect(host.querySelectorAll('[data-read="false"]')).toHaveLength(1);
    const links = host.querySelectorAll<HTMLAnchorElement>('[data-testid="notifications-list"] a');
    expect(links[0].textContent).toContain('Workload reiniciado');
    await act(async () => { links[0].click(); });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a'.repeat(32) }), '#cluster');
    const markAll = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Marcar todas'));
    expect(markAll).toBeTruthy();
    await act(async () => { markAll!.click(); });
    expect(onMarkAllRead).toHaveBeenCalled();
  });
  it('estados: desligado, erro com retry, vazio', async () => {
    const onRetry = vi.fn();
    let host = await mount(<NotificationsPanel state={{ status: 'disabled' }} pt={false} onMarkAllRead={() => undefined} onOpen={() => undefined} onRetry={onRetry} />);
    expect(host.textContent).toContain('disabled in this deployment');
    host = await mount(<NotificationsPanel state={{ status: 'error', message: 'HTTP 502' }} pt onMarkAllRead={() => undefined} onOpen={() => undefined} onRetry={onRetry} />);
    expect(host.textContent).toContain('Notificações não lidas: HTTP 502');
    await act(async () => { host.querySelector('button')!.click(); });
    expect(onRetry).toHaveBeenCalled();
    host = await mount(<NotificationsPanel state={{ status: 'ready', box: { unread: 0, readAt: 0, items: [] } }} pt onMarkAllRead={() => undefined} onOpen={() => undefined} onRetry={onRetry} />);
    expect(host.textContent).toContain('Nada por aqui');
  });
});

describe('AuditLogPage', () => {
  it('lista eventos do servidor, mostra o escopo, filtra por texto e navega pelo link interno', async () => {
    listEvents.mockResolvedValue({ count: 2, scope: 'all', readAt: 0, items: [ev(), ev({ id: 'c'.repeat(32), actor: 'ana', action: 'pod.deleted', kind: 'Pod', name: 'web-1', result: 'failed', detail: 'http_409', link: '' })] });
    const onNavigateHash = vi.fn();
    const host = await mount(<I18nProvider><AuditLogPage onNavigateHash={onNavigateHash} /></I18nProvider>);
    expect(listEvents).toHaveBeenCalledWith({ action: '', result: '', actor: '', limit: 200 });
    const text = host.textContent ?? '';
    expect(text).toContain('Auditoria');
    expect(text).toContain('Todos os eventos (admin).');
    expect(text).toContain('Workload reiniciado');
    expect(text).toContain('Pod removido');
    expect(text).toContain('http_409');
    const link = [...host.querySelectorAll('a')].find(a => a.textContent?.includes('Workload reiniciado'))!;
    await act(async () => { link.click(); });
    expect(onNavigateHash).toHaveBeenCalledWith('#cluster');
  });
  it('503 vira "desligada" e erro vira indicador de erro, nunca tabela vazia', async () => {
    listEvents.mockRejectedValueOnce(new PlatformApiError(503, 'events store disabled'));
    let host = await mount(<I18nProvider><AuditLogPage onNavigateHash={() => undefined} /></I18nProvider>);
    expect(host.textContent).toContain('desligada neste deployment');
    listEvents.mockRejectedValueOnce(new Error('boom'));
    host = await mount(<I18nProvider><AuditLogPage onNavigateHash={() => undefined} /></I18nProvider>);
    expect(host.textContent).toContain('Eventos não lidos: boom');
    expect(host.textContent).not.toContain('Nenhum evento com estes filtros');
  });
});
