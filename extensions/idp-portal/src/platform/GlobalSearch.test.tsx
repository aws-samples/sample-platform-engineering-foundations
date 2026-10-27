/*
 * Busca global e ownership: as partes puras (modelo de busca, resolução de owner, label no manifest)
 * e um render da caixa de busca contra a cluster-api falsa.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PEOPLE_DIRECTORY_URL } from './deployment';
import { capabilities } from './catalogLoader';
import { VIEW_IDS } from './routes/routeRegistry';
import { GlobalSearch, SEARCH_VIEWS, firstHit, groupHits, instanceHits, matches, searchCapabilities, searchViews } from './GlobalSearch';
import { I18nProvider } from './i18n';
import type { InstanceRow } from './kdpInventoryApi';
import { OWNER_LABEL, withOwnerLabel } from './manifestNamespace';
import { OwnerLink, resolveOwner } from './ownership';
import { team } from './scope/scopeFixtures';
import pageSource from './AgentPlatformPage.tsx?raw';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (patch: Partial<InstanceRow> = {}): InstanceRow => ({
  name: 'hello-webapp', namespace: 'appmod', created: '2026-10-01T00:00:00Z', labels: {},
  capability: 'static-web-app', engine: 'kro', owner: 'platform-team', kind: 'StaticWebApp', apiVersion: 'kro.run/v1alpha1',
  uid: 'u1', state: 'ACTIVE', synced: 'True', ready: true, readyBasis: 'CONDITION_TRUE', generation: 1, observedGeneration: 1,
  statusStale: false, conditionCount: 1, scorecard: null,
  freshness: { readAt: 1, ageSeconds: 10, lastTransitionAgeSeconds: 10, stale: false, staleReasons: [], convergeBudgetSeconds: 600 },
  ...patch,
});

describe('modelo da busca', () => {
  it('casa sem acento e sem caixa', () => {
    expect(matches('composi', 'Composições')).toBe(true);
    expect(matches('TIMES', 'times')).toBe(true);
    expect(matches('', 'x')).toBe(false);
  });

  it('toda view do shell é pesquisável e vice-versa', () => {
    // A lista vem do route registry; o shell deriva `VALID_VIEWS` dele (uma fonte, não quatro).
    expect(pageSource).toContain('const VALID_VIEWS: readonly View[] = VIEW_IDS;');
    const searchable = SEARCH_VIEWS.map(entry => entry.view);
    // `inventory` e `entity` são caminhos legados sem link no menu; não entram na busca.
    expect([...searchable].sort()).toEqual(VIEW_IDS.filter(v => v !== 'inventory' && v !== 'entity').sort());
  });

  it('acha página, capability e instância, agrupados nessa ordem', () => {
    const views = searchViews('compos', true);
    expect(views.map(hit => hit.target)).toEqual([{ kind: 'view', view: 'compositions' }]);
    const caps = searchCapabilities('static', capabilities, true);
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.every(hit => hit.target.kind === 'path' && hit.target.path.includes('/services/'))).toBe(true);
    const instances = instanceHits([row()], true);
    expect(instances[0].description).toContain('owner platform-team');
    expect(instances[0].target).toEqual({ kind: 'path', path: expect.stringContaining('hello-webapp') });
    expect(groupHits(views, caps, instances, true).map(group => group.label)).toEqual(['Páginas', 'Capabilities', 'Instâncias']);
    expect(groupHits([], [], [], true)).toEqual([]);
    expect(firstHit(groupHits(views, caps, instances, true))).toBe(views[0]);
    expect(firstHit(groupHits([], [], instances, true))).toBe(instances[0]);
    expect(firstHit([])).toBeNull();
  });
});

describe('ownership', () => {
  const teams = [team()];
  it('resolve time, alias, texto e vazio', () => {
    expect(resolveOwner('platform-team', teams)).toEqual({ kind: 'team', team: teams[0] });
    expect(resolveOwner('platform-admin', teams)).toEqual({ kind: 'alias', alias: 'platform-admin' });
    expect(resolveOwner('Time X', teams)).toEqual({ kind: 'text', text: 'Time X' });
    expect(resolveOwner('  ', teams)).toEqual({ kind: 'none' });
  });
  it('renderiza link de contato por tipo e nunca inventa owner', () => {
    const html = (owner: string) => renderToStaticMarkup(<OwnerLink owner={owner} teams={teams} pt />);
    if (PEOPLE_DIRECTORY_URL) expect(html('platform-admin')).toContain(`${PEOPLE_DIRECTORY_URL}platform-admin`);
    else expect(html('platform-admin')).not.toContain('href');
    expect(html('platform-team')).toContain('#platform-team');
    expect(html('platform-team')).toContain('Platform Team');
    expect(html('')).toContain('sem owner declarado');
  });
});

describe('withOwnerLabel', () => {
  const base = 'apiVersion: kro.run/v1alpha1\nkind: StaticSite\nmetadata:\n  name: x\n  namespace: appmod\nspec:\n  name: y\n';
  it('cria labels como primeiro filho de metadata quando não existe', () => {
    const out = withOwnerLabel(base, 'platform-admin');
    expect(out).toBe('apiVersion: kro.run/v1alpha1\nkind: StaticSite\nmetadata:\n  labels:\n    platform.appmod/owner: platform-admin\n  name: x\n  namespace: appmod\nspec:\n  name: y\n');
    expect(withOwnerLabel(out, 'platform-admin')).toBe(out);
  });
  it('acrescenta ao bloco labels existente e substitui o owner anterior', () => {
    const withLabels = 'kind: X\nmetadata:\n  name: x\n  labels:\n    app: y\nspec: {}\n';
    const out = withOwnerLabel(withLabels, 'alice');
    expect(out).toBe(`kind: X\nmetadata:\n  name: x\n  labels:\n    ${OWNER_LABEL}: alice\n    app: y\nspec: {}\n`);
    expect(withOwnerLabel(out, 'bob')).toBe(`kind: X\nmetadata:\n  name: x\n  labels:\n    ${OWNER_LABEL}: bob\n    app: y\nspec: {}\n`);
  });
  it('não toca owner inválido, documento sem metadata ou multi-documento', () => {
    expect(withOwnerLabel(base, 'bad value!')).toBe(base);
    expect(withOwnerLabel(base, '')).toBe(base);
    expect(withOwnerLabel('kind: X\nspec: {}\n', 'a')).toBe('kind: X\nspec: {}\n');
    expect(withOwnerLabel(`${base}---\n${base}`, 'a')).toBe(`${base}---\n${base}`);
  });
});

describe('GlobalSearch (render)', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it('lê instâncias pela cluster-api após o debounce e navega pela seleção', async () => {
    const find = vi.fn(async () => [row()]);
    const onNavigate = vi.fn();
    await act(async () => { root.render(<I18nProvider><GlobalSearch catalog={capabilities} onNavigate={onNavigate} findInstances={find} /></I18nProvider>); });
    const input = host.querySelector('input')!;
    expect(input.getAttribute('placeholder')).toContain('Buscar');
    await act(async () => {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'hello');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)); });
    expect(find).toHaveBeenCalledWith('hello', expect.any(AbortSignal));
    // `expandToViewport` renderiza o dropdown num portal fora do host: a prova é no documento.
    expect(document.body.textContent).toContain('hello-webapp');
    expect(document.body.textContent).toContain('Instâncias');
    // Trocar a consulta limpa as instâncias antigas antes do próximo resultado chegar.
    find.mockImplementation(() => new Promise(() => { /* nunca responde */ }));
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'compos');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)); });
    expect(document.body.textContent).not.toContain('hello-webapp');
    expect(document.body.textContent).toContain('Composições');
    // Enter sem escolher linha abre o primeiro resultado (a página Composições).
    // ArrowDown realça a linha "Buscar ..." (texto digitado); Enter nela não é um resultado, então abre o primeiro.
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true })); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })); });
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'view', view: 'compositions' });
  });
});
