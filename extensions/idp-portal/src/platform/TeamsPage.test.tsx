// @vitest-environment jsdom
/*
 * Página Times: owners do registry com contato, projetos do time e contagem viva por projeto. Falha
 * de leitura do cluster aparece como falha no card, nunca como zero.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstancesResponse } from './kdpInventoryApi';
import { context, project, team } from './scope/scopeFixtures';
import type { ProjectScope } from './scope/useProjectScope';
import { PEOPLE_DIRECTORY_URL } from './deployment';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listInstances = vi.fn<(query: { namespace?: string; ready?: string }, signal?: AbortSignal) => Promise<InstancesResponse>>();
vi.mock('./kdpInventoryApi', async () => {
  const actual = await vi.importActual<typeof import('./kdpInventoryApi')>('./kdpInventoryApi');
  return { ...actual, listInstances: (query: { namespace?: string; ready?: string }, signal?: AbortSignal) => listInstances(query, signal) };
});

const { TeamsPage, countText, projectsOf } = await import('./TeamsPage');
const { I18nProvider } = await import('./i18n');

const page = (total: number, partial = false): InstancesResponse => ({
  items: [], total, namespace: 'x', capabilities: [], kinds: [], page: { limit: 1, offset: 0, returned: 0, nextCursor: null },
  partial, truncated: false, truncatedSources: [], sources: partial ? [{ source: 'static-web-app:StaticWebApp', ok: false, error: 'http_403' }] : [], readAt: 1,
} as unknown as InstancesResponse);

function scopeOf(state: ProjectScope['state']): ProjectScope {
  return { state, selection: null, select: vi.fn(), retry: vi.fn() };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { listInstances.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('TeamsPage', () => {
  it('lists the team with contacts, Slack, its projects and live counts', async () => {
    listInstances.mockImplementation(async query => page(query.ready === 'true' ? 2 : 3));
    const ctx = context([project({ id: 'agent-platform', name: 'Agent Platform', namespaces: ['appmod'] }),
      project({ id: 'other', owner: { team: 'someone-else', contact: 'zed' } })]);
    await act(async () => { root.render(<I18nProvider><TeamsPage scope={scopeOf({ status: 'loaded', context: ctx })} onNavigateView={vi.fn()} /></I18nProvider>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const text = host.textContent ?? '';
    expect(text).toContain('Platform Team');
    // Diretório de pessoas é do perfil de deployment: com ele o alias vira link; sem ele, texto.
    if (PEOPLE_DIRECTORY_URL) expect(host.querySelector(`a[href="${PEOPLE_DIRECTORY_URL}platform-admin"]`)).not.toBeNull();
    else expect(text).toContain('platform-admin');
    expect(text).toContain('#platform-team');
    expect(text).toContain('Agent Platform');
    expect(text).not.toContain('other');
    expect(text).toContain('2/3 prontos');
    expect(listInstances).toHaveBeenCalledWith({ namespace: 'appmod', limit: 1 }, expect.any(AbortSignal));
  });

  it('shows a failed count as a failure, not zero', async () => {
    listInstances.mockImplementation(async () => page(0, true));
    const ctx = context([project({ id: 'agent-platform', namespaces: ['appmod'] })]);
    await act(async () => { root.render(<I18nProvider><TeamsPage scope={scopeOf({ status: 'loaded', context: ctx })} onNavigateView={vi.fn()} /></I18nProvider>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain('falha: static-web-app:StaticWebApp (http_403)');
    expect(host.textContent).not.toContain('0/0');
  });

  it('helpers', () => {
    expect(projectsOf(team(), [project({ id: 'a' }), project({ id: 'b', owner: { team: 'x', contact: 'y' } }), project({ id: 'c', lifecycle: { state: 'retired' } })]).map(p => p.id)).toEqual(['a']);
    expect(countText(undefined, true)).toBe('lendo…');
    expect(countText({ status: 'ready', total: 4, ready: 1 }, false)).toBe('1/4 ready');
  });
});
