import { describe, expect, it } from 'vitest';
import {
  DRAFT_VIEW_IDS, labelOf, resolveRoute, ROUTES, SEARCHABLE_ROUTES, titleOf, VIEW_IDS, viewHref,
} from './routeRegistry';
import { contentKey, DRAFT_VIEWS, viewTitle } from '../shellNavigation';

import shell from '../AgentPlatformPage.tsx?raw';

describe('route registry', () => {
  it('ids são únicos e todo id tem título nos dois idiomas', () => {
    expect(new Set(VIEW_IDS).size).toBe(VIEW_IDS.length);
    for (const route of ROUTES) {
      expect(route.title.pt.length, route.id).toBeGreaterThan(0);
      expect(route.title.en.length, route.id).toBeGreaterThan(0);
    }
  });

  it('todo id do registry tem um branch de render no shell, e o shell não renderiza id fora do registry', () => {
    // O switch do shell é `view === '<id>'`; o último (admin) é o `else`. Admin entra pelo lazy import.
    const rendered = new Set([...shell.matchAll(/view === '([a-z-]+)'/g)].map(match => match[1]));
    rendered.add('admin');
    for (const id of VIEW_IDS) expect(rendered.has(id), `sem render para #${id}`).toBe(true);
    for (const id of rendered) expect((VIEW_IDS as readonly string[]).includes(id), `render de view fora do registry: ${id}`).toBe(true);
  });

  it('resolve hash, hash com parâmetro, caminho canônico e desconhecido', () => {
    expect(resolveRoute({ hash: '#catalog' })).toMatchObject({ view: 'catalog', param: null, redirect: false, unknown: null });
    const id = 'a'.repeat(32);
    expect(resolveRoute({ hash: `#assistant/${id}` })).toMatchObject({ view: 'assistant', param: id, canonical: `#assistant/${id}` });
    // Parâmetro em view que não aceita, ou fora do formato, é ignorado em vez de virar 404.
    expect(resolveRoute({ hash: `#catalog/${id}` })).toMatchObject({ view: 'catalog', param: null });
    expect(resolveRoute({ hash: '#assistant/not-an-id' })).toMatchObject({ view: 'assistant', param: null });
    // Caminho canônico relativo a /agent-platform/ normaliza para o hash (replace).
    expect(resolveRoute({ pathname: '/agent-platform/scorecards', hash: '' })).toMatchObject({ view: 'scorecards', redirect: true, canonical: '#scorecards' });
    // services/... é rota do router, nunca view.
    expect(resolveRoute({ pathname: '/agent-platform/services/x/ns/name', hash: '' })).toMatchObject({ view: 'home', redirect: false });
    expect(resolveRoute({ hash: '' })).toMatchObject({ view: 'home', unknown: null });
    expect(resolveRoute({ hash: '#nope' })).toMatchObject({ view: 'home', unknown: 'nope', redirect: false });
  });

  it('busca deriva do registry: toda view não legada é pesquisável, legada não', () => {
    const searchable = SEARCHABLE_ROUTES.map(route => route.view);
    for (const route of ROUTES) {
      const legacy = 'legacy' in route && route.legacy;
      expect(searchable.includes(route.id), route.id).toBe(!legacy);
    }
    // Rótulo da busca = rótulo do menu quando difere do título da aba.
    expect(SEARCHABLE_ROUTES.find(route => route.view === 'studio')).toMatchObject({ pt: 'Studio', en: 'Studio' });
  });

  it('shellNavigation lê títulos e rascunhos do registry', () => {
    expect(viewTitle('studio', false)).toBe('Service Owner Studio - AppMod Agent Platform');
    expect(viewTitle('services', true)).toBe('Meus recursos - AppMod Agent Platform');
    expect(titleOf('nope', true)).toBeNull();
    expect(DRAFT_VIEWS).toBe(DRAFT_VIEW_IDS);
    expect([...DRAFT_VIEW_IDS].sort()).toEqual(['agent-builder', 'provision', 'studio']);
    expect(contentKey('provision', 'p1')).toBe('view:provision');
    expect(contentKey('catalog', 'p1')).toBe('project:p1');
  });

  it('menu: label e href por id', () => {
    expect(labelOf('admin', true)).toBe('Administração da plataforma');
    expect(labelOf('home', false)).toBe('Home');
    expect(viewHref('teams')).toBe('#teams');
  });
});
