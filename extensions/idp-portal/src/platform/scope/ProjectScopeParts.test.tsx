import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectDetails, ProjectScopeSelector, ScopeContextSummary } from './ProjectScopeParts';
import { ScopeRequestError } from './scopeApi';
import { resolveSelection } from './scopeModel';
import { context, project } from './scopeFixtures';
import type { ScopeLoadState } from './useProjectScope';

const originalError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return;
    originalError(...args);
  });
});
afterAll(() => vi.restoreAllMocks());

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const noop = () => undefined;

function render(state: ScopeLoadState, url: { project?: string; namespace?: string } = {}, locale: 'pt-BR' | 'en-US' = 'pt-BR') {
  const selection = state.status === 'loaded' ? resolveSelection(state.context, url) : null;
  return text(renderToStaticMarkup(<ProjectScopeSelector state={state} selection={selection} locale={locale} onRetry={noop} onSelect={noop} />));
}

describe('ProjectScopeSelector states', () => {
  it('loading', () => {
    expect(render({ status: 'loading' })).toContain('Carregando projetos');
  });

  it.each([
    [403, 'Sem acesso à plataforma'],
    [503, 'Escopo indisponível'],
    [0, 'Sem conexão com a platform-api'],
    [500, 'Falha ao ler o contexto'],
  ])('error %i is named and offers retry, never an empty state', (status, header) => {
    const html = render({ status: 'error', error: new ScopeRequestError(status, 'x') });
    expect(html).toContain(header);
    expect(html).toContain('Tentar de novo');
    expect(html).not.toContain('nenhum projeto');
  });

  it('empty: valid session without any project', () => {
    expect(render({ status: 'loaded', context: context([]) })).toContain('Você ainda não participa de nenhum projeto');
  });

  it('single project: context and role, no selector', () => {
    const html = render({ status: 'loaded', context: context([project({ id: 'agent-platform', name: 'Agent Platform', namespaces: ['appmod'] })]) });
    expect(html).toContain('AppMod LATAM / Agent Platform / appmod');
    expect(html).toContain('contribuidor');
    expect(html).not.toContain('Escolha um projeto');
  });

  it('several projects: selector with a placeholder, no invented default', () => {
    const html = render({ status: 'loaded', context: context([project({ id: 'team-a' }), project({ id: 'team-b' })]) }, {}, 'en-US');
    expect(html).toContain('Choose a project');
  });

  it('a project from the URL the caller cannot see is reported, not silently swapped', () => {
    const html = render({ status: 'loaded', context: context([project({ id: 'team-a' }), project({ id: 'team-b' })]) }, { project: 'team-c' });
    expect(html).toContain('O projeto "team-c" não existe ou você não tem acesso a ele.');
  });

  it('a namespace from another project is reported', () => {
    const html = render({ status: 'loaded', context: context([project({ id: 'team-a' }), project({ id: 'team-b' })]) }, { project: 'team-a', namespace: 'ns-team-b' });
    expect(html).toContain('Namespace fora do projeto');
  });
});

describe('ScopeContextSummary and ProjectDetails', () => {
  it('shows organization, project, namespace, environment and role as text', () => {
    const ctx = context([project({ id: 'team-a', name: 'Team A', role: 'viewer' })]);
    const html = text(renderToStaticMarkup(<ScopeContextSummary context={ctx} selection={resolveSelection(ctx, {})} locale="en-US" />));
    expect(html).toBe('AppMod LATAM / Team A / ns-team-a · Lab viewer');
  });

  it('shows ownership, quota and lifecycle, and says kubeconfig is not offered', () => {
    const p = project({ id: 'agent-platform', lifecycle: { state: 'read-only' } });
    const html = text(renderToStaticMarkup(<ProjectDetails project={p} context={context([p])} locale="pt-BR" />));
    expect(html).toContain('platform-team (platform-admin)');
    expect(html).toContain('Não definida');
    expect(html).toContain('somente leitura');
    expect(html).toContain('O portal não oferece kubeconfig');
  });
});

describe('no client-side storage in the scope module', () => {
  it('never touches localStorage or sessionStorage', () => {
    const sources = import.meta.glob(['./*.ts', './*.tsx', '!./*.test.ts', '!./*.test.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(5);
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });
});
