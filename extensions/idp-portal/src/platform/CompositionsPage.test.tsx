// @vitest-environment jsdom
/*
 * Página de Composições (kro-native-compositions, fatia 2).
 *
 * O que se prova: a lista vem da cluster-api e carrega estado, contagem de instâncias e grafo por
 * definição; a seleção troca o detalhe (grafo, schema, condições); definição sem plural e fonte que
 * falhou aparecem como texto próprio, nunca como zero; e erro de leitura vira LoadFailure com retry.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompositionSummary, CompositionsResponse } from './kdpInventoryApi';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe(): void { /* jsdom */ } unobserve(): void { /* noop */ } disconnect(): void { /* noop */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const listCompositions = vi.fn<(namespace: string, signal?: AbortSignal) => Promise<CompositionsResponse>>();
vi.mock('./kdpInventoryApi', async () => {
  const actual = await vi.importActual<typeof import('./kdpInventoryApi')>('./kdpInventoryApi');
  return { ...actual, listCompositions: (namespace: string, signal?: AbortSignal) => listCompositions(namespace, signal) };
});

const { CompositionsPage, definitionIndicator, instancesText } = await import('./CompositionsPage');
const { InventoryError } = await import('./kdpInventoryApi');
const { I18nProvider } = await import('./i18n');

function summary(patch: Partial<CompositionSummary> = {}): CompositionSummary {
  return {
    name: 'static-web-app', kind: 'StaticWebApp', apiVersion: 'kro.run/v1alpha1', state: 'Active',
    created: '2026-10-01T00:00:00Z', generation: 3, observedGeneration: 3, conditions: [],
    plural: 'staticwebapps', listable: true,
    graph: {
      name: 'static-web-app', kind: 'StaticWebApp', state: 'Active',
      nodes: [
        { id: 'bucket', kind: 'Bucket', apiVersion: 's3.services.k8s.aws/v1alpha1', external: false, dependsOn: [], usesSchema: true, readyWhen: 0, includeWhen: 0 },
        { id: 'distribution', kind: 'Distribution', apiVersion: 'cloudfront.services.k8s.aws/v1alpha1', external: false, dependsOn: ['bucket'], usesSchema: false, readyWhen: 1, includeWhen: 0 },
      ],
      edges: [{ from: 'bucket', to: 'distribution' }], layers: [['bucket'], ['distribution']], cycle: [],
      outputs: [{ name: 'url', from: ['distribution'] }], controllerOrder: [],
    },
    schema: { spec: [{ path: 'name', type: 'string', required: true, default: null, description: 'Site name', markers: {} },
                     { path: 'replicas', type: 'integer', required: false, default: '2', description: '', markers: { minimum: '1' } }],
              status: ['url'] },
    instances: { total: 3, ready: 2, notReady: 1, truncated: false, error: '' },
    revisions: { items: [{ revision: 2, generation: 3, ready: true, hash: 'h2', created: '2026-10-02T00:00:00Z', resources: 2 },
                         { revision: 1, generation: 1, ready: true, hash: 'h1', created: '2026-10-01T00:00:00Z', resources: 2 }],
                 latest: { revision: 2, generation: 3, ready: true, hash: 'h2', created: '2026-10-02T00:00:00Z', resources: 2 }, pending: null, lastIssued: 2, error: '' },
    rollout: [{ name: 'hello-site', namespace: 'appmod', rollout: { status: 'current', children: 2, withHash: 2, onLatest: 2, latestRevision: 2 } },
              { name: 'old-site', namespace: 'appmod', rollout: { status: 'behind', children: 2, withHash: 2, onLatest: 1, latestRevision: 2 } }],
    source: 'platform/compositions/static-web-app-rgd.yaml',
    ...patch,
  };
}

function response(items: CompositionSummary[], patch: Partial<CompositionsResponse> = {}): CompositionsResponse {
  return { items, total: items.length, namespace: '_all', partial: false, truncated: false, sources: [{ source: 'kro.run/resourcegraphdefinitions', ok: true, error: '' }], readAt: Math.floor(Date.now() / 1000), ...patch };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  listCompositions.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(onOpenService = vi.fn(), onCreate = vi.fn()) {
  await act(async () => {
    root.render(<I18nProvider><CompositionsPage onOpenService={onOpenService} onCreate={onCreate} /></I18nProvider>);
  });
  await act(async () => { await Promise.resolve(); });
  return { onOpenService, onCreate };
}

const textOf = () => host.textContent ?? '';

describe('CompositionsPage', () => {
  it('lists every definition with state, counts and the selected graph', async () => {
    listCompositions.mockResolvedValue(response([
      summary(),
      summary({ name: 'dynamodb-table', kind: 'DynamoTable', listable: false, plural: '', instances: null, graph: { ...summary().graph, name: 'dynamodb-table', nodes: [], edges: [], layers: [], outputs: [] }, schema: { spec: [], status: [] } }),
    ]));
    await mount();
    expect(listCompositions).toHaveBeenCalledWith('_all', expect.any(AbortSignal));
    const text = textOf();
    expect(text).toContain('Composições');
    expect(text).toContain('dynamodb-table');
    expect(text).toContain('2/3 prontas');
    expect(text).toContain('sem listagem');
    // Resumo: 2 definições, 2 Active, 2/3 instâncias, uma definição sem contagem.
    expect(text).toContain('2/3 · 1 sem contagem');
    // A primeira definição é selecionada por default e o detalhe carrega o grafo e o schema.
    expect(host.querySelector('[data-testid="composition-svg"]')).not.toBeNull();
    expect(text).toContain('Schema (2)');
    // Revisões (composition-revisions): aba com a contagem, revisão ativa e rollout no resumo.
    expect(text).toContain('Revisões (2)');
    expect(text).toContain('r2');
    expect(text).toContain('1 atrás');
    expect(text).toContain('Editar definição no Git');
  });

  it('switches the detail when another definition is selected and opens the service list', async () => {
    const other = summary({ name: 'dynamodb-table', kind: 'DynamoTable', state: 'Inactive', instances: { total: 1, ready: 0, notReady: 1, truncated: true, error: '' } });
    listCompositions.mockResolvedValue(response([summary(), other]));
    const { onOpenService } = await mount();
    const link = Array.from(host.querySelectorAll('a')).find(a => a.textContent === 'dynamodb-table');
    expect(link).toBeDefined();
    await act(async () => { link!.click(); });
    const detailHeading = Array.from(host.querySelectorAll('h2')).map(h => h.textContent ?? '');
    expect(detailHeading.some(h => h.includes('dynamodb-table'))).toBe(true);
    expect(textOf()).toContain('0/1+ prontas');
    const view = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Ver instâncias'));
    await act(async () => { view!.click(); });
    expect(onOpenService).toHaveBeenCalledWith('dynamodb-table');
  });

  it('renders a failed instance source as a named failure and a partial warning, never as zero', async () => {
    listCompositions.mockResolvedValue(response(
      [summary({ instances: { total: null, ready: null, notReady: null, truncated: false, error: 'http_403' } })],
      { partial: true, sources: [{ source: 'kro.run/resourcegraphdefinitions', ok: true, error: '' }, { source: 'static-web-app:instances', ok: false, error: 'http_403' }] },
    ));
    await mount();
    const text = textOf();
    expect(text).toContain('falha: http_403');
    expect(text).not.toContain('0/0');
    expect(text).toContain('static-web-app:instances');
  });

  it('shows the load failure with a retry that reads again', async () => {
    listCompositions.mockRejectedValueOnce(new InventoryError(502, 'cluster discovery unavailable', [{ source: 'kro.run/resourcegraphdefinitions', ok: false, error: 'http_503' }], true));
    listCompositions.mockResolvedValueOnce(response([summary()]));
    await mount();
    expect(textOf()).toContain('cluster discovery unavailable');
    const retry = Array.from(host.querySelectorAll('button')).find(b => /Tentar|Retry|novo/i.test(b.textContent ?? ''));
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(listCompositions).toHaveBeenCalledTimes(2);
    expect(textOf()).toContain('2/3 prontas');
  });
});

describe('helpers', () => {
  it('maps definition state to text plus icon', () => {
    expect(definitionIndicator('Active', true)).toEqual({ type: 'success', text: 'Active' });
    expect(definitionIndicator('Inactive', true)).toEqual({ type: 'error', text: 'Inactive' });
    expect(definitionIndicator('', true)).toEqual({ type: 'pending', text: 'Sem estado' });
    expect(definitionIndicator('Reconciling', false)).toEqual({ type: 'info', text: 'Reconciling' });
  });
  it('distinguishes not listable, failed and truncated instance counts', () => {
    expect(instancesText(summary({ listable: false, instances: null }), false)).toBe('not listable');
    expect(instancesText(summary({ instances: { total: null, ready: null, notReady: null, truncated: false, error: 'unreachable' } }), false)).toBe('failed: unreachable');
    expect(instancesText(summary({ instances: { total: 500, ready: 499, notReady: 1, truncated: true, error: '' } }), true)).toBe('499/500+ prontas');
  });
});
