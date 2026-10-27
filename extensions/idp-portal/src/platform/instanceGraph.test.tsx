// @vitest-environment jsdom
/*
 * cross-instance-graph: o adaptador reaproveita o renderer da composição (ids = nomes, REF para nó
 * externo, CICLO reportado), a página mostra aresta com evidência e diz "nenhuma aresta" quando leu e
 * não achou, e a seção do detalhe lista consome / consumida por.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceGraphResponse } from './kdpInventoryApi';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getInstanceGraph = vi.fn<(ns: string, signal?: AbortSignal) => Promise<InstanceGraphResponse>>();
vi.mock('./kdpInventoryApi', async () => {
  const actual = await vi.importActual<typeof import('./kdpInventoryApi')>('./kdpInventoryApi');
  return { ...actual, getInstanceGraph: (ns: string, signal?: AbortSignal) => getInstanceGraph(ns, signal) };
});

const { toCompositionGraph, edgesAround, instanceNodeId, relationLabel } = await import('./instanceGraphModel');
const { DependenciesPage } = await import('./DependenciesPage');
const { InstanceDependenciesSection } = await import('./InstanceDependenciesSection');
const { I18nProvider } = await import('./i18n');
const { InventoryError } = await import('./kdpInventoryApi');

const node = (kind: string, name: string, dependsOn: string[] = [], ns = 'appmod', external = false) => ({
  id: external ? `?/${ns}/${name}` : `${kind}/${ns}/${name}`, name, namespace: ns, kind: external ? '' : kind,
  capability: external ? '' : `cap/${kind.toLowerCase()}`, engine: external ? '' : 'kro', project: 'agent-platform',
  owner: 'team', ready: external ? null : true, external, dependsOn,
});

const graph = (): InstanceGraphResponse => ({
  namespace: '_all',
  nodes: [
    node('DynamoDBTable', 'orders'),
    node('WebApp', 'shop', ['DynamoDBTable/appmod/orders']),
    node('WebApp', 'shop-staging', ['?/appmod/shop-src'], 'appmod-staging'),
    node('WebApp', 'shop-src', [], 'appmod', true),
  ],
  edges: [
    { from: 'DynamoDBTable/appmod/orders', to: 'WebApp/appmod/shop', relation: 'consumes', evidence: 'spec.tableName = orders.outputs.tableName' },
    { from: '?/appmod/shop-src', to: 'WebApp/appmod-staging/shop-staging', relation: 'promoted-from', evidence: 'annotation platform.appmod/promoted-from=agent-platform/appmod/shop-src' },
  ],
  layers: [['?/appmod/shop-src', 'DynamoDBTable/appmod/orders'], ['WebApp/appmod-staging/shop-staging', 'WebApp/appmod/shop']],
  cycle: [],
  relations: { consumes: 1, declared: 0, 'promoted-from': 1 },
  partial: false, sources: [], readAt: 1,
});

describe('toCompositionGraph', () => {
  it('maps ids to instance names, keeps layers, marks the outside-scope node as external REF', () => {
    const g = toCompositionGraph(graph(), 'Dependências');
    expect(g.nodes.map((n) => n.id)).toEqual(['orders', 'shop', 'shop-staging', 'appmod/shop-src']);
    expect(g.nodes[1].dependsOn).toEqual(['orders']);
    expect(g.nodes[3].external).toBe(true);
    expect(g.edges).toEqual([{ from: 'orders', to: 'shop' }, { from: 'appmod/shop-src', to: 'shop-staging' }]);
    expect(g.layers).toEqual([['appmod/shop-src', 'orders'], ['shop-staging', 'shop']]);
    expect(g.nodes[2].apiVersion).toBe('appmod-staging/v0'); // o renderer imprime o grupo: namespace visível
    expect(g.state).toBe('Active');
    expect(toCompositionGraph({ ...graph(), cycle: ['WebApp/appmod/shop'] }, 'x').cycle).toEqual(['shop']);
  });

  it('edgesAround splits consumes and consumed-by for one instance', () => {
    const around = edgesAround(graph(), instanceNodeId('DynamoDBTable', 'appmod', 'orders'));
    expect(around.dependsOn).toEqual([]);
    expect(around.dependents.map((e) => e.to)).toEqual(['WebApp/appmod/shop']);
    expect(relationLabel('promoted-from', true)).toBe('promovida de');
  });
});

describe('DependenciesPage and detail section', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { getInstanceGraph.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

  it('renders the KPIs, the graph and the evidence table; outside-scope node is not a link', async () => {
    getInstanceGraph.mockResolvedValue(graph());
    const open = vi.fn();
    await act(async () => { root.render(<I18nProvider><DependenciesPage onOpenDetail={open} /></I18nProvider>); });
    await settle();
    const text = host.textContent ?? '';
    expect(text).toContain('Dependências');
    expect(text).toContain('spec.tableName = orders.outputs.tableName');
    expect(text).toContain('promovida de');
    expect(text).toContain('fora do escopo');
    expect(host.querySelector('svg[role="img"]')).not.toBeNull();
    const links = Array.from(host.querySelectorAll('a')).map((a) => a.textContent);
    expect(links).toContain('shop');
    expect(links).not.toContain('appmod/shop-src');
    expect(getInstanceGraph).toHaveBeenCalledWith('_all', expect.any(AbortSignal));
  });

  it('says it read N instances and found no edge, instead of an empty silence', async () => {
    getInstanceGraph.mockResolvedValue({ ...graph(), nodes: [node('WebApp', 'solo')], edges: [], layers: [['WebApp/appmod/solo']], relations: { consumes: 0, declared: 0, 'promoted-from': 0 } });
    await act(async () => { root.render(<I18nProvider><DependenciesPage onOpenDetail={vi.fn()} /></I18nProvider>); });
    await settle();
    expect(host.querySelector('[data-testid="no-edges"]')?.textContent).toContain('1 instâncias lidas e nenhuma aresta');
  });

  it('a failed read is a named failure, never an empty graph', async () => {
    getInstanceGraph.mockRejectedValue(new InventoryError(502, 'cluster-api unavailable', [{ source: 'app/web:WebApp', ok: false, error: 'http_503' }]));
    await act(async () => { root.render(<I18nProvider><DependenciesPage onOpenDetail={vi.fn()} /></I18nProvider>); });
    await settle();
    expect(host.textContent).toContain('http_503');
    expect(host.querySelector('svg[role="img"]')).toBeNull();
  });

  it('the detail section lists consumes and consumed-by with evidence', async () => {
    getInstanceGraph.mockResolvedValue(graph());
    await act(async () => { root.render(<I18nProvider><InstanceDependenciesSection kind="WebApp" namespace="appmod" name="shop" pt onOpenDetail={vi.fn()} /></I18nProvider>); });
    await settle();
    const text = host.textContent ?? '';
    expect(text).toContain('Consome');
    expect(text).toContain('orders');
    expect(text).toContain('spec.tableName = orders.outputs.tableName');
    expect(text).toContain('Nenhuma instância do escopo consome esta.');
    expect(getInstanceGraph).toHaveBeenCalledWith('appmod', expect.any(AbortSignal));
  });
});
