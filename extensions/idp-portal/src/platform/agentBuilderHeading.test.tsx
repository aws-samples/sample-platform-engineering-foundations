// Um h1 por view no Agent Builder, em toda aba e todo estado do gate (finding do E2E live 22/10:
// a página embrulhava o builder num ContentLayout com h1, e a aba Criar tem o h1 do Wizard).
// Renderiza o componente REAL; só o gate é fixado, porque no SSR o efeito que o resolve não roda.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from './i18n';
import type { GateState } from './useAgentBuilder';

const fixture = vi.hoisted(() => ({ gate: { status: 'loading' } as GateState }));
vi.mock('./useAgentBuilder', async importActual => ({
  ...(await importActual<typeof import('./useAgentBuilder')>()),
  useAgentBuilderGate: () => ({ gate: fixture.gate, retry: () => undefined }),
}));

const { AgentBuilder } = await import('./AgentBuilder');

const TRACKED_KEY = 'appmod.agentBuilder.tracked.v1';
const page = import.meta.glob('./AgentPlatformPage.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function render(gate: GateState, tracked: string | null): string {
  fixture.gate = gate;
  const storage = { getItem: (key: string) => (key === TRACKED_KEY ? tracked : null), setItem: () => undefined, removeItem: () => undefined };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { location: { pathname: '/agent-platform/', search: '', hash: '#agent-builder' }, history: { replaceState: () => undefined },
    localStorage: storage, sessionStorage: storage, setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
  return renderToStaticMarkup(<I18nProvider><AgentBuilder /></I18nProvider>);
}

const h1s = (html: string) => html.match(/<h1[\s>][\s\S]*?<\/h1>/g) ?? [];
const ENABLED: GateState = { status: 'enabled', alias: 'platform-admin', isAdmin: false };
const TRACKED = JSON.stringify({ name: 'ab-hello-agent', op: 'create' });

afterEach(() => { vi.unstubAllGlobals(); });

describe('Agent Builder: exatamente um h1 na view', () => {
  it('aba Criar: o único h1 é o do Wizard, e o nome da tela segue visível sem tag de heading', () => {
    const html = render(ENABLED, null);
    const found = h1s(html);
    expect(found).toHaveLength(1);
    // É o título da etapa (Wizard), focável pelo shell, e não o nome da tela.
    expect(found[0]).toMatch(/tabindex="-1"/);
    expect(found[0]).not.toContain('Agent Builder');
    // Título e descrição continuam no DOM, como texto.
    expect(html).toContain('Agent Builder');
    expect(html).toContain('A plataforma valida, compila e abre o MR');
    expect(html).toContain('role="tablist"');
  });

  it('controle, aba de lifecycle: sem Wizard na tela, o nome da tela é o h1', () => {
    const html = render(ENABLED, TRACKED);
    // Controle de que esta é mesmo a aba de lifecycle, e não a de criação.
    expect(html).toContain('ab-hello-agent');
    expect(html).not.toContain('Etapas do Agent Builder');
    const found = h1s(html);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('Agent Builder');
  });

  it.each<[string, GateState]>([
    ['carregando', { status: 'loading' }],
    ['desligado', { status: 'disabled' }],
    ['erro', { status: 'error', error: { title: 'x', detail: 'y', action: 'z' } as never }],
  ])('estado do gate %s: um h1, com o nome da tela', (_label, gate) => {
    const found = h1s(render(gate, null));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('Agent Builder');
  });

  it('a página não embrulha o builder em outro h1', () => {
    const branch = code(page['./AgentPlatformPage.tsx']).split("view === 'agent-builder'", 2)[1].split("view === 'inventory'", 1)[0];
    expect(branch).toContain('<AgentBuilder');
    expect(branch).not.toContain('variant="h1"');
    expect(branch).not.toContain('ContentLayout');
  });
});
