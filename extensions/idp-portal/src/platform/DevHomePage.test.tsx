/*
 * Render estático da home do Dev, um teste por estado da tela.
 *
 * O projeto não tem jsdom, então o render é de servidor e os efeitos não rodam: a view recebe os
 * estados prontos, que é exatamente o que se quer afirmar. O que este arquivo prova:
 *
 *  - carregando, erro, vazio, parcial, não lido e pronto são telas DIFERENTES, com texto diferente;
 *  - erro de leitura nunca aparece como lista vazia, e não lido nunca aparece como zero;
 *  - todo status sai com ícone e texto, e as listas têm rótulo acessível;
 *  - o texto da tela não tem em dash.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import pageSource from './DevHomePage.tsx?raw';
import modelSource from './devHomeModel.ts?raw';
import { capabilities } from './catalogLoader';
import type { Freshness, InstanceRow, ScorecardsResponse } from './kdpInventoryApi';
import { buildServiceCatalog } from './serviceCatalog';
import { I18nProvider } from './i18n';
import { DevHomePage, DevHomeView, DevHomeViewProps } from './DevHomePage';
import { LOADING, activityFeed, operationsInProgress } from './devHomeModel';
import { defaultLayout } from './dashboard/layoutModel';
import { WidgetId, WIDGET_IDS } from './dashboard/widgetRegistry';

const text = (html: string) => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&middot;/g, '·')
  .replace(/\s+/g, ' ');

const originalError = console.error;
beforeAll(() => {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return;
    originalError(...args);
  });
});
afterAll(() => { vi.restoreAllMocks(); delete (globalThis as { localStorage?: unknown }).localStorage; });

const READ_AT = Date.parse('2026-10-21T12:00:00Z') / 1000;
const freshness = (patch: Partial<Freshness> = {}): Freshness => ({
  readAt: READ_AT, ageSeconds: 5, lastTransitionAgeSeconds: 5, stale: false, staleReasons: [], convergeBudgetSeconds: 600, ...patch,
});
const row = (patch: Partial<InstanceRow> = {}): InstanceRow => ({
  name: 'hello', namespace: 'demo', created: '2026-10-21T11:55:00Z', labels: {},
  capability: 'web-api', engine: 'kro', owner: 'platform-team', kind: 'WebApi', apiVersion: 'kro.run/v1alpha1',
  uid: 'uid-1', state: 'ACTIVE', synced: 'True', ready: true, readyBasis: 'CONDITION_TRUE',
  generation: 1, observedGeneration: 1, statusStale: false, conditionCount: 1, freshness: freshness(), scorecard: null, ...patch,
});

const target = capabilities[0];
const overview = { version: 'v1.33', namespaces: [], nodes: { total: 3, ready: 3, spot: 1 }, pods: { total: 10, running: 10, pending: 0, failed: 0 } };
const noop = () => undefined;

const dashboardLayout = defaultLayout({
  projectId: 'agent-platform', authorizedWidgets: new Set<WidgetId>(WIDGET_IDS),
  now: () => '2026-10-23T12:00:00Z',
});
const dashboard = {
  state: { status: 'ready' as const, layout: dashboardLayout, palette: [] as WidgetId[], issue: '' as const },
  setWidgets: async () => '' as const,
  reset: async () => '' as const,
};
const scorecards: ScorecardsResponse = {
  namespace: '_all',
  standards: { version: 1, levels: ['bronze', 'silver', 'gold'], rules: [
    { id: 'ready', level: 'bronze', check: 'ready', engines: null, title: 'Resource is Ready', titlePt: 'Recurso está Ready', description: 'd', descriptionPt: 'd' },
    { id: 'owner-declared', level: 'bronze', check: 'owner', engines: null, title: 'Owner declared', titlePt: 'Owner declarado', description: 'd', descriptionPt: 'd' },
  ] },
  summary: { total: 3, byLevel: { none: 1, bronze: 0, silver: 1, gold: 1 } },
  rules: [{ id: 'ready', applicable: 3, passed: 3 }, { id: 'owner-declared', applicable: 3, passed: 2 }],
  items: [], argoReadable: true, partial: false, truncatedSources: [], sources: [], readAt: 1,
};
const platform = { rgds: [{ name: 'web-api', state: 'Active', kind: 'WebApi', topology: 3, created: '' }], instances: [] };

function props(patch: Partial<DevHomeViewProps> = {}): DevHomeViewProps {
  return {
    pt: true,
    entries: buildServiceCatalog(capabilities, { counts: { [target.liveCapability]: 1 } }),
    catalogLoading: false,
    catalogError: '',
    recent: { status: 'ready', data: [row({ name: 'minha-api' })], partial: false, sources: [] },
    operations: { status: 'ready', data: { items: [], total: 0 }, partial: false, sources: [] },
    activity: { status: 'ready', data: [] },
    overview: { status: 'ready', data: overview },
    platform: { status: 'ready', data: platform },
    scorecards: { status: 'ready', data: scorecards },
    onView: noop, onPath: noop, onOpenService: noop, onCreate: noop,
    ...patch,
  };
}

function render(patch: Partial<DevHomeViewProps> = {}, locale: 'pt-BR' | 'en-US' = 'pt-BR'): string {
  (globalThis as { localStorage?: { getItem(key: string): string | null } }).localStorage = {
    getItem: (key: string) => (key === 'agent-platform-locale' ? locale : null),
  };
  return renderToStaticMarkup(<I18nProvider><DevHomeView {...props({ pt: locale === 'pt-BR', ...patch })} /></I18nProvider>);
}

// O React emite o warning de key UMA vez por componente: este bloco tem de ser o primeiro render do
// arquivo, e a captura roda na coleta (antes dos outros describes), não dentro do it.
describe('sem erro de contagem, nenhum filho vazio no SpaceBetween', () => {
  const errors: string[] = [];
  const previous = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    render({ catalogError: '' });
    render({ catalogError: '' }, 'en-US');
  } finally {
    console.error = previous;
  }

  it('catalogError vazio não gera o warning de key única do React', () => {
    expect(errors.filter(message => /unique "key"|unique key/i.test(message))).toEqual([]);
  });
});

describe('estado carregando', () => {
  const html = render({
    catalogLoading: true,
    entries: buildServiceCatalog(capabilities, { counts: null }),
    recent: LOADING, operations: LOADING, activity: LOADING, overview: LOADING, platform: LOADING,
  });

  it('diz que está lendo em cada bloco, sem nenhum número', () => {
    const content = text(html);
    expect(content).toContain('Lendo os recursos live do cluster');
    expect(content).toContain('Lendo o que está provisionando');
    expect(content).toContain('Lendo os eventos');
    expect(content).toContain('Verificando');
    expect(content).not.toContain('Nada provisionando');
    expect(content).not.toContain('Você ainda não tem recursos');
  });

  it('o indicador de carregando é o status do Cloudscape, com ícone', () => {
    expect(html).toContain('awsui_status-loading');
  });
});

describe('estado de erro', () => {
  const html = text(render({
    recent: { status: 'error', message: 'HTTP 502' },
    operations: { status: 'error', message: 'HTTP 502' },
    activity: { status: 'error', message: 'timeout' },
    overview: { status: 'error', message: 'timeout' },
    platform: { status: 'error', message: 'timeout' },
  }));

  it('erro de leitura é erro, nunca lista vazia', () => {
    expect(html).toContain('Não foi possível ler o cluster');
    expect(html).toContain('HTTP 502');
    expect(html).not.toContain('Você ainda não tem recursos');
    expect(html).not.toContain('Nada provisionando');
    expect(html).toContain('Leitura falhou');
  });

  it('saúde sem resposta aparece como não lida, e diz quem não respondeu', () => {
    expect(html).toContain('Não lido');
    expect(html).toContain('Sem resposta de: overview: timeout; platform: timeout');
    expect(html).not.toContain('Saudável');
  });

  it('eventos indisponíveis dizem por quê', () => {
    expect(html).toContain('Eventos indisponíveis: timeout');
  });

  it('a contagem live que falhou vira alerta, e nenhum serviço é contado como em uso', () => {
    const failed = text(render({ catalogError: 'socket hang up', entries: buildServiceCatalog(capabilities, { counts: null }) }));
    expect(failed).toContain('Contagem live indisponível');
    expect(failed).toContain('socket hang up');
    expect(failed).toContain('Serviços em uso Não lido');
    // Sem leitura, o primeiro passo é conferir acesso, não criar o primeiro site.
    expect(failed).toContain('O estado live não foi lido');
    expect(failed).not.toContain('Seu primeiro site em 10 minutos');
  });
});

describe('estado vazio', () => {
  const html = text(render({
    entries: buildServiceCatalog(capabilities, { counts: {} }),
    recent: { status: 'ready', data: [], partial: false, sources: [] },
    operations: { status: 'ready', data: { items: [], total: 0 }, partial: false, sources: [] },
  }));

  it('vazio de verdade convida a começar, e diz que nada está provisionando', () => {
    expect(html).toContain('Você ainda não tem recursos');
    expect(html).toContain('Nada provisionando agora');
    expect(html).toContain('Nenhum evento recente no cluster');
  });

  it('o primeiro passo sugerido é o primeiro site', () => {
    expect(html).toContain('Seu primeiro site em 10 minutos');
  });

  it('vazio parcial NÃO é sucesso: aponta para as fontes que falharam', () => {
    const partial = text(render({
      recent: { status: 'ready', data: [], partial: true, sources: [{ source: 'web-api:WebApi', ok: false, error: 'forbidden' }] },
      operations: { status: 'ready', data: { items: [], total: 0 }, partial: true, sources: [{ source: 'web-api:WebApi', ok: false, error: 'forbidden' }] },
    }));
    expect(partial).toContain('Nenhum recurso nas fontes que responderam');
    expect(partial).toContain('Nada em andamento nas fontes que responderam');
    expect(partial).not.toContain('todos os recursos estão prontos');
    expect(partial).toContain('forbidden');
  });
});

describe('estado não lido (unknown)', () => {
  it('uma contagem que falhou não vira soma parcial de instâncias', () => {
    const other = capabilities[1];
    const html = text(render({ entries: buildServiceCatalog(capabilities, { counts: { [target.liveCapability]: 2, [other.liveCapability]: null } }) }));
    expect(html).toContain('Parte das contagens não foi lida');
    expect(html).not.toMatch(/Instâncias live 2 /);
  });

  it('uma fonte de saúde sem resposta deixa só os sinais dela como não lidos', () => {
    const html = text(render({ platform: { status: 'error', message: 'timeout' } }));
    expect(html).toContain('3/3 ready');
    expect(html).toContain('Compositions (kro) Não lido');
  });
});

describe('estado pronto', () => {
  const operations = operationsInProgress([
    row({ name: 'fila-pedidos', ready: false, readyBasis: 'NO_READY_CONDITION', state: 'IN_PROGRESS' }),
    row({ name: 'banco-quebrado', ready: false, readyBasis: 'CONDITION_FALSE', state: 'ERROR' }),
  ], READ_AT);
  const activity = activityFeed([
    { namespace: 'demo', reason: 'BackOff', type: 'Warning', object: 'Pod/hello', message: 'Back-off restarting', count: 3, last: '2026-10-21T11:59:00Z' },
  ], Date.parse('2026-10-21T12:00:00Z'));
  const html = render({ operations: { status: 'ready', data: { items: operations, total: 2 }, partial: false, sources: [] }, activity: { status: 'ready', data: activity } });
  const content = text(html);

  it('mostra o recurso recente com link para o detalhe live', () => {
    expect(content).toContain('minha-api');
    expect(html).toContain('href="/agent-platform/services/web-api/demo/minha-api?kind=WebApi"');
  });

  it('mostra o progresso estimado e diz que é estimativa', () => {
    expect(content).toContain('Progresso estimado de fila-pedidos');
    expect(content).toContain('5min de ~10min previstos');
    expect(content).toContain('o controller não reporta progresso');
    expect(content).toContain('O controller reportou falha');
  });

  it('o recurso que falhou vira o primeiro próximo passo', () => {
    const steps = content.split('Próximos passos')[1] ?? '';
    expect(steps.indexOf('1 recurso falhou')).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf('1 recurso falhou')).toBeLessThan(steps.indexOf('1 recurso provisionando'));
  });

  it('a atividade marca aviso como aviso, com contagem e idade', () => {
    expect(content).toContain('Aviso · BackOff');
    expect(content).toContain('3x');
    expect(content).toContain('há 1min');
  });

  it('o catálogo em destaque traz o serviço em uso e o Create governado', () => {
    expect(content).toContain(target.displayNamePt);
    expect(content).toContain('Create');
    expect(content).toContain(`Ver os ${capabilities.length} serviços`);
  });

  it('a saúde lida aparece como saudável', () => {
    expect(content).toContain('Saudável');
  });
});

describe('acessibilidade e idioma', () => {
  const html = render();

  it('tem um h1 e um h2 por bloco', () => {
    expect(html.match(/<h1/g)?.length).toBe(1);
    for (const heading of ['Recursos recentes', 'Operações em andamento', 'Do catálogo', 'Próximos passos', 'Saúde da plataforma', 'Atividade']) {
      expect(html).toMatch(new RegExp(`<h2[^>]*>(?:(?!</h2>).)*${heading}`, 's'));
    }
  });

  it('as listas e a tabela têm rótulo acessível', () => {
    expect(html).toContain('aria-label="Próximos passos"');
    expect(html).toContain('aria-label="Recursos recentes"');
  });

  it('status é ícone mais texto, nunca só cor', () => {
    expect(html).toContain('awsui_status-success');
    expect(html).toContain('<svg');
  });

  it('a feature flag pronta expõe personalização sem alterar o conteúdo dos widgets', () => {
    const enabled = render({ dashboard });
    expect(text(enabled)).toContain('Adicionar widget');
    expect(text(enabled)).toContain('Restaurar padrão');
    // No render estático o Board ainda não mediu a largura e desenha o slot vazio; os itens são
    // provados em jsdom em dashboard/DashboardBoard.test.tsx. Aqui prova-se que os 7 widgets chegam a ele.
    expect(enabled).toContain(`data-dashboard-widgets="${WIDGET_IDS.length}"`);
    expect(text(enabled)).not.toContain('Personalizar painel');
  });

  it('renderiza em en-US', () => {
    const english = text(render({}, 'en-US'));
    expect(english).toContain('Recent resources');
    expect(english).toContain('Operations in progress');
    expect(english).toContain('Next steps');
  });

  it('nenhum em dash no que a tela mostra nem no fonte', () => {
    expect(text(html)).not.toContain('\u2014');
    expect(text(render({}, 'en-US'))).not.toContain('\u2014');
    expect(pageSource).not.toContain('\u2014');
    expect(modelSource).not.toContain('\u2014');
    // Controle: o fonte foi de fato carregado, então o "não contém" não passa por vazio.
    expect(pageSource).toContain('export function DevHomeView');
  });
});

describe('página com as leituras', () => {
  it('abre em carregando, sem afirmar nada antes da primeira resposta', () => {
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    const html = text(renderToStaticMarkup(
      <I18nProvider><DevHomePage counts={{ counts: null, loading: true, error: '' }} onNavigateView={noop} onNavigatePath={noop} /></I18nProvider>,
    ));
    expect(html).toContain('Lendo os recursos live do cluster');
    expect(html).not.toContain('Nada provisionando');
    expect(html).not.toContain('Saudável');
  });
});
