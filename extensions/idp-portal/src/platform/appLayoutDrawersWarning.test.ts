/*
 * Origem do warning live `[AwsUi] [app-layout-drawers] multiple app layout instances detected when
 * calling onDrawersRegistered` (medido em 2026-10-22, ver docs/agent-platform/app-layout-drawers-warning.md).
 *
 * O Cloudscape guarda o runtime de plugins em window[Symbol.for('awsui-plugin-api')] e, ao carregar,
 * sobe por window.parent enquanto a origem for a mesma (findUpApi). Todo AppLayout que vê o mesmo
 * objeto divide UM DrawersController, que aceita um único listener de onDrawersRegistered. No the internal gateway,
 * o iframe same-origin /navigation/nav-takeover.html tem um AppLayout próprio e herda o objeto do
 * nosso frame: a assinatura dele é a segunda, e o console.warn sai pelo código do NOSSO chunk, porque
 * a função do controller compartilhado é a que o nosso bundle instalou primeiro.
 *
 * Estes testes carregam o módulo real do Cloudscape (o mesmo `internal/plugins` que o AppLayout usa),
 * simulando cada bundle com vi.resetModules + um `window` próprio.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = Symbol.for('awsui-plugin-api');
type DrawersInternal = { onDrawersRegistered(listener: (drawers: unknown[]) => void): () => void };
type FakeWindow = { parent?: unknown; [KEY]?: { awsuiPluginsInternal: { appLayout: DrawersInternal } } };

/** Carrega o runtime de plugins como um bundle novo faria, num `window` dado. */
async function loadBundleIn(win: FakeWindow): Promise<DrawersInternal> {
  vi.resetModules();
  vi.stubGlobal('window', win);
  await import('@cloudscape-design/components/internal/plugins');
  return win[KEY]!.awsuiPluginsInternal.appLayout;
}

function drawersWarnings(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(call => call.join(' ').includes('multiple app layout instances detected when calling onDrawersRegistered')).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('app-layout-drawers: quem dispara o warning', () => {
  it('um AppLayout nosso, sem shell, assina uma vez e não gera warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const top: FakeWindow = {};
    top.parent = top;
    const ours = await loadBundleIn(top);
    ours.onDrawersRegistered(() => undefined);
    expect(drawersWarnings(warn)).toBe(0);
  });

  it('StrictMode (mount, cleanup, mount do efeito) não gera warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const top: FakeWindow = {};
    top.parent = top;
    const ours = await loadBundleIn(top);
    const unsubscribe = ours.onDrawersRegistered(() => undefined);
    unsubscribe();
    ours.onDrawersRegistered(() => undefined);
    expect(drawersWarnings(warn)).toBe(0);
  });

  it('um iframe same-origin com AppLayout próprio (o nav-takeover do the internal gateway) divide o controller e gera o warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const top: FakeWindow = {};
    top.parent = top;
    const ours = await loadBundleIn(top);
    ours.onDrawersRegistered(() => undefined);

    const iframe: FakeWindow = { parent: top };
    const shell = await loadBundleIn(iframe);
    expect(iframe[KEY]).toBe(top[KEY]); // findUpApi reaproveitou o objeto do frame pai
    shell.onDrawersRegistered(() => undefined);
    expect(drawersWarnings(warn)).toBe(1);
  });

  it('um iframe cross-origin não alcança o controller do pai e não gera warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const top: FakeWindow = {};
    top.parent = top;
    const ours = await loadBundleIn(top);
    ours.onDrawersRegistered(() => undefined);

    const crossOriginParent = new Proxy({}, { get() { throw new DOMException('Blocked a frame', 'SecurityError'); } });
    const iframe: FakeWindow = { parent: crossOriginParent };
    const shell = await loadBundleIn(iframe);
    expect(iframe[KEY]).not.toBe(top[KEY]);
    shell.onDrawersRegistered(() => undefined);
    expect(drawersWarnings(warn)).toBe(0);
  });
});

describe('app-layout-drawers: a nossa árvore tem um AppLayout só', () => {
  const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

  it('apenas AgentPlatformPage importa AppLayout, e renderiza um único <AppLayout>', () => {
    const importers = Object.entries(sources)
      // Pacote interno (One Theme) ou público (@cloudscape-design): o mesmo teste vale nos dois flavors.
      .filter(([, source]) => /from '(@amzn\/awsui-components-react\/polaris|@cloudscape-design\/components)\/app-layout(-toolbar)?'|\bAppLayout\b[^;]*from '(@amzn\/awsui-components-react(\/polaris)?|@cloudscape-design\/components)'/.test(source))
      .map(([path]) => path);
    expect(importers).toEqual(['/src/platform/AgentPlatformPage.tsx']);
    expect(sources['/src/platform/AgentPlatformPage.tsx'].match(/<AppLayout\b/g)).toHaveLength(1);
  });
});
