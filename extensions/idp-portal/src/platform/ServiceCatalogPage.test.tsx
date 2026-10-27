/*
 * Page-level smoke test. The parts tests prove each piece renders; this one proves the assembled
 * page renders against the REAL catalog with a props-driven live instance list, which is where a
 * wrong total or a lost facet would actually reach the user.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { capabilities } from './catalogLoader';
import { I18nProvider } from './i18n';
import { ServiceCatalogPage } from './ServiceCatalogPage';
import { LiveCounts, PREFERENCES_KEY } from './serviceCatalog';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// The i18n provider and the preference loader both read localStorage; node has none, so the test
// supplies one. Everything else about the page is exercised as-is.
const store: Record<string, string> = {};
const originalError = console.error;

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (key in store ? store[key] : null),
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    },
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return;
    originalError(...args);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(store)) delete store[key];
});

/** Uma instância live da primeira capability do catálogo, para o teste seguir os arquivos. */
const target = capabilities[0];
/* A contagem chega pela identidade LIVE (metadata.name do RGD), que é a chave da cluster-api. */
const COUNTS: LiveCounts = { counts: { [target.liveCapability]: 1 } };
const EMPTY: LiveCounts = { counts: {} };

function render(props: Parameters<typeof ServiceCatalogPage>[0] = {}): string {
  return renderToStaticMarkup(<I18nProvider><ServiceCatalogPage {...props} /></I18nProvider>);
}

describe('the catalog page renders the whole catalog', () => {
  it('reports visible/total off the real catalog, with no stale number', () => {
    const html = render({ counts: EMPTY });
    expect(text(html)).toContain(`(${capabilities.length}/${capabilities.length})`);
  });

  it('names the file-driven source instead of claiming a hardcoded list', () => {
    expect(text(render({ counts: EMPTY }))).toContain('platform/catalog');
  });

  it('renders every capability of the real catalog by display name', () => {
    const content = text(render({ counts: EMPTY }));
    for (const capability of capabilities) expect(content).toContain(capability.displayNamePt);
  });

  it('derives the added state from the live count it was handed, not from a flag', () => {
    const withInstance = text(render({ counts: COUNTS }));
    expect(withInstance).toContain('Adicionado');
    expect(withInstance).toContain('1 instância');
    // Same catalog, count read and zero: nothing is added.
    expect(text(render({ counts: EMPTY }))).not.toContain('Adicionado');
  });

  it('surfaces a live capability that has no catalog file rather than under-counting silently', () => {
    const html = text(render({ counts: { counts: { 'kagent-declarative': 1 } } }));
    expect(html).toContain('kagent-declarative');
    expect(html).toContain('fora do catálogo');
    // The totals stay the catalog totals; the orphan is reported, never counted in.
    expect(html).toContain(`(${capabilities.length}/${capabilities.length})`);
  });

  it('contagem não lida vira estado não lido, nunca "tudo disponível"', () => {
    const html = text(render({ counts: { counts: null } }));
    expect(html).toContain('Estado não lido');
    expect(html).not.toContain('Adicionado');
    // Este é o flash que a falha da API produzia: todo serviço marcado Disponível sem leitura.
    expect(html).not.toContain('Disponível');
    expect(html).toContain(`(${capabilities.length}/${capabilities.length})`);
  });

  it('distingue carregamento de falha da cluster-api quando a shell é dona da leitura', () => {
    expect(text(render({ counts: { counts: null, loading: true, error: '' } }))).toContain('Lendo as capabilities live do cluster');
    const failed = text(render({ counts: { counts: null, loading: false, error: 'HTTP 502' } }));
    expect(failed).toContain('Estado adicionado indisponível');
    expect(failed).toContain('HTTP 502');
    expect(failed).not.toContain('Lendo as capabilities live do cluster');
  });

  it('offers search, the three facets, both view modes and sorting on the same page', () => {
    const html = render({ counts: EMPTY });
    const content = text(html);
    expect(html).toContain('Buscar serviços');
    expect(html).toContain('Filtrar por categoria');
    expect(html).toContain('Filtrar por estado');
    expect(html).toContain('Filtrar por engine');
    expect(content).toContain('Grade');
    expect(content).toContain('Tabela');
    expect(content).toContain('Ordenar por');
  });

  it('honours the persisted view preference on the next render', () => {
    store[PREFERENCES_KEY] = JSON.stringify({ viewMode: 'table', pageSize: 12, sortField: 'name', descending: false });
    // The table view renders a real table element; the grid view does not.
    expect(render({ counts: EMPTY })).toContain('<table');
    store[PREFERENCES_KEY] = JSON.stringify({ viewMode: 'grid', pageSize: 12, sortField: 'state', descending: false });
    expect(render({ counts: EMPTY })).not.toContain('<table');
    delete store[PREFERENCES_KEY];
  });

  it('opens the named service directly, so a #service/<id> link lands on that page', () => {
    const content = text(render({ counts: COUNTS, initialServiceId: target.id }));
    expect(content).toContain(target.displayNamePt);
    expect(content).toContain('Instâncias live');
    // A contagem vem da capability live, e a tela nomeia essa identidade.
    expect(content).toContain(target.liveCapability);
    expect(content).toContain('Voltar ao catálogo');
  });

  it('ignores an unknown service id and stays on the catalog instead of breaking', () => {
    const content = text(render({ counts: EMPTY, initialServiceId: 'no-such-service' }));
    expect(content).toContain('Catálogo de serviços');
    expect(content).toContain(`(${capabilities.length}/${capabilities.length})`);
  });
});
