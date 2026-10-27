/*
 * Comportamento do modelo da home do Dev. Cada teste fixa uma decisão que a tela depende:
 * o que não foi lido nunca vira zero, o que falhou vem antes do que converge, o que não tem horário
 * vai para o fim, e o layout vira uma coluna só na menor largura.
 */
import { describe, expect, it } from 'vitest';
import type { EventRow } from './clusterApi';
import { capabilities } from './catalogLoader';
import type { Freshness, InstanceRow } from './kdpInventoryApi';
import { buildServiceCatalog } from './serviceCatalog';
import {
  HOME_LAYOUT, activityFeed, catalogSummary, featuredServices, healthSignals, nextSteps,
  operationPhase, operationsInProgress, overallHealth, recentResources,
} from './devHomeModel';

const READ_AT = Date.parse('2026-10-21T12:00:00Z') / 1000;

const freshness = (patch: Partial<Freshness> = {}): Freshness => ({
  readAt: READ_AT, ageSeconds: 5, lastTransitionAgeSeconds: 5,
  stale: false, staleReasons: [], convergeBudgetSeconds: 600, ...patch,
});

const row = (patch: Partial<InstanceRow> = {}): InstanceRow => ({
  name: 'hello', namespace: 'demo', created: '2026-10-21T11:55:00Z', labels: {},
  capability: 'web-api', engine: 'kro', owner: 'platform-team', kind: 'WebApi', apiVersion: 'kro.run/v1alpha1',
  uid: 'uid-1', state: 'IN_PROGRESS', synced: 'Unknown', ready: false, readyBasis: 'NO_READY_CONDITION',
  generation: 1, observedGeneration: 1, statusStale: false, conditionCount: 0,
  freshness: freshness(), scorecard: null, ...patch,
});

const event = (patch: Partial<EventRow> = {}): EventRow => ({
  namespace: 'demo', reason: 'Created', type: 'Normal', object: 'Pod/hello', message: 'ok', count: 1,
  last: '2026-10-21T11:59:00Z', ...patch,
});

const target = capabilities[0];
const other = capabilities[1];

describe('catalogSummary', () => {
  it('soma instâncias só quando todas as contagens foram lidas', () => {
    const read = catalogSummary(buildServiceCatalog(capabilities, { counts: { [target.liveCapability]: 2 } }));
    expect(read.added).toBe(1);
    expect(read.instances).toBe(2);
    expect(read.unknown).toBe(0);
    expect(read.total).toBe(capabilities.length);
  });

  it('uma contagem que falhou deixa o total como não lido, nunca como a soma das outras', () => {
    const partial = catalogSummary(buildServiceCatalog(capabilities, { counts: { [target.liveCapability]: 2, [other.liveCapability]: null } }));
    expect(partial.instances).toBeNull();
    expect(partial.unknown).toBe(1);
  });

  it('leitura inteira falhou: tudo é desconhecido, nada é adicionado', () => {
    const failed = catalogSummary(buildServiceCatalog(capabilities, { counts: null }));
    expect(failed.unknown).toBe(capabilities.length);
    expect(failed.added).toBe(0);
    expect(failed.instances).toBeNull();
  });
});

describe('featuredServices', () => {
  it('mostra o que está em uso primeiro', () => {
    const entries = buildServiceCatalog(capabilities, { counts: { [other.liveCapability]: 3 } });
    const featured = featuredServices(entries, 3);
    expect(featured[0].id).toBe(other.id);
    expect(featured.length).toBeLessThanOrEqual(3);
  });

  it('o que não está em uso só entra se puder ser pedido agora', () => {
    const featured = featuredServices(buildServiceCatalog(capabilities, { counts: {} }), capabilities.length);
    expect(featured.length).toBeGreaterThan(0);
    for (const entry of featured) expect(['available', 'preview']).toContain(entry.lifecycle);
  });
});

describe('operações em andamento', () => {
  it('classifica pela base de Ready do backend, não pela cor', () => {
    expect(operationPhase(row({ readyBasis: 'CONDITION_FALSE' }))).toBe('blocked');
    expect(operationPhase(row({ readyBasis: 'NEGATIVE_CONDITION' }))).toBe('blocked');
    expect(operationPhase(row({ freshness: freshness({ staleReasons: ['CONVERGE_BUDGET_EXCEEDED'] }) }))).toBe('slow');
    expect(operationPhase(row({ readyBasis: 'STATUS_STALE' }))).toBe('stale');
    expect(operationPhase(row())).toBe('converging');
  });

  it('falha vem antes do que converge, e linha pronta nunca entra', () => {
    const items = operationsInProgress([
      row({ name: 'converging' }),
      row({ name: 'ready', ready: true, readyBasis: 'CONDITION_TRUE' }),
      row({ name: 'failed', readyBasis: 'CONDITION_FALSE' }),
    ], READ_AT);
    expect(items.map(item => item.row.name)).toEqual(['failed', 'converging']);
  });

  it('o percentual é estimado pelo tempo previsto e nunca chega a 100 antes de Ready', () => {
    const [half] = operationsInProgress([row({ created: '2026-10-21T11:55:00Z' })], READ_AT);
    expect(half.elapsedSeconds).toBe(300);
    expect(half.percent).toBe(50);
    const [late] = operationsInProgress([row({ created: '2026-10-21T10:00:00Z' })], READ_AT);
    expect(late.percent).toBe(95);
  });

  it('sem horário de criação ou sem orçamento não há barra com número inventado', () => {
    expect(operationsInProgress([row({ created: null })], READ_AT)[0].percent).toBeNull();
    expect(operationsInProgress([row({ freshness: freshness({ convergeBudgetSeconds: 0 }) })], READ_AT)[0].percent).toBeNull();
  });
});

describe('recentResources', () => {
  it('ordena pelo mais novo e manda quem não tem horário para o fim', () => {
    const rows = recentResources([
      row({ name: 'old', created: '2026-10-01T00:00:00Z' }),
      row({ name: 'no-time', created: null }),
      row({ name: 'new', created: '2026-10-21T00:00:00Z' }),
    ], 6);
    expect(rows.map(item => item.name)).toEqual(['new', 'old', 'no-time']);
  });

  it('respeita o limite', () => {
    expect(recentResources(Array.from({ length: 10 }, (_, index) => row({ name: `r${index}` })), 4)).toHaveLength(4);
  });
});

describe('activityFeed', () => {
  it('mais recente primeiro, aviso marcado como aviso e sem horário no fim', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const feed = activityFeed([
      event({ reason: 'Old', last: '2026-10-21T10:00:00Z' }),
      event({ reason: 'NoTime', last: '' }),
      event({ reason: 'BackOff', type: 'Warning', last: '2026-10-21T11:59:30Z', count: 0 }),
    ], now);
    expect(feed.map(item => item.reason)).toEqual(['BackOff', 'Old', 'NoTime']);
    expect(feed[0].type).toBe('warning');
    expect(feed[0].ageSeconds).toBe(30);
    expect(feed[0].count).toBe(1);
    expect(feed[2].ageSeconds).toBeNull();
  });
});

describe('saúde', () => {
  const overview = { version: 'v1.33', namespaces: [], nodes: { total: 3, ready: 3, spot: 1 }, pods: { total: 10, running: 10, pending: 0, failed: 0 } };
  const platform = { rgds: [{ name: 'web-api', state: 'Active', kind: 'WebApi', topology: 3, created: '' }], instances: [] };

  it('leitura que falhou vira não lido, nunca 0/0 saudável', () => {
    const signals = healthSignals(null, null, true);
    expect(signals.every(signal => signal.level === 'unknown')).toBe(true);
    expect(signals.map(signal => signal.value).join(' ')).not.toContain('0/0');
    expect(overallHealth(signals)).toBe('unknown');
  });

  it('uma fonte que falhou não derruba os sinais da outra', () => {
    const signals = healthSignals(overview, null, true);
    expect(signals.find(signal => signal.id === 'nodes')?.level).toBe('success');
    expect(signals.find(signal => signal.id === 'compositions')?.level).toBe('unknown');
    expect(overallHealth(signals)).toBe('unknown');
  });

  it('o pior nível vence', () => {
    const degraded = healthSignals({ ...overview, nodes: { total: 3, ready: 2, spot: 0 } }, platform, true);
    expect(overallHealth(degraded)).toBe('warning');
    expect(overallHealth(healthSignals(overview, platform, true))).toBe('success');
    expect(overallHealth(healthSignals({ ...overview, nodes: { total: 0, ready: 0, spot: 0 } }, platform, true))).toBe('error');
  });
});

describe('nextSteps', () => {
  const detailPathOf = (item: InstanceRow) => `/agent-platform/services/${item.capability}/${item.namespace}/${item.name}`;
  const known = catalogSummary(buildServiceCatalog(capabilities, { counts: {} }));
  const used = catalogSummary(buildServiceCatalog(capabilities, { counts: { [target.liveCapability]: 1 } }));

  it('falha vem primeiro, é o único passo primário e aponta para o detalhe do recurso', () => {
    const operations = operationsInProgress([row({ name: 'broken', readyBasis: 'CONDITION_FALSE' }), row({ name: 'moving' })], READ_AT);
    const steps = nextSteps({ pt: true, catalog: used, operations, detailPathOf });
    expect(steps[0].id).toBe('blocked');
    expect(steps[0].target).toEqual({ path: '/agent-platform/services/web-api/demo/broken' });
    expect(steps.filter(step => step.primary)).toHaveLength(1);
    expect(steps[1].id).toBe('progress');
    expect(steps.length).toBeLessThanOrEqual(4);
  });

  it('quem não usa nenhum serviço recebe o primeiro site como sugestão', () => {
    const steps = nextSteps({ pt: true, catalog: known, operations: [], detailPathOf });
    expect(steps[0]).toMatchObject({ id: 'first-run', primary: true, target: { view: 'getting-started' } });
  });

  it('sem leitura live, o passo é conferir o acesso, e não oferece o primeiro site', () => {
    const unread = catalogSummary(buildServiceCatalog(capabilities, { counts: null }));
    const steps = nextSteps({ pt: false, catalog: unread, operations: null, detailPathOf });
    expect(steps[0].id).toBe('access');
    expect(steps.map(step => step.id)).not.toContain('first-run');
  });

  it('o catálogo é sempre uma saída', () => {
    expect(nextSteps({ pt: true, catalog: used, operations: [], detailPathOf }).map(step => step.id)).toContain('catalog');
    expect(nextSteps({ pt: true, catalog: null, operations: null, detailPathOf }).map(step => step.id)).toContain('catalog');
  });

  it('o agent acompanhado pelo Agent Builder vira passo', () => {
    const steps = nextSteps({ pt: true, catalog: used, operations: [], trackedAgent: 'faq-bot', detailPathOf });
    expect(steps[0]).toMatchObject({ id: 'agent', target: { view: 'agent-builder' } });
    expect(steps[0].title).toContain('faq-bot');
  });
});

describe('layout responsivo', () => {
  it('toda coluna ocupa a largura inteira na menor tela', () => {
    for (const [block, columns] of Object.entries(HOME_LAYOUT)) {
      for (const column of columns) expect(column.colspan.default, block).toBe(12);
    }
  });

  it('no desktop comum (breakpoint m do container) cada bloco fecha exatamente uma linha de 12', () => {
    const sumAt = (block: keyof typeof HOME_LAYOUT) => HOME_LAYOUT[block].reduce((total, column) => total + (column.colspan.m ?? column.colspan.default), 0);
    expect(sumAt('work')).toBe(12);
    expect(sumAt('context')).toBe(12);
  });
});
