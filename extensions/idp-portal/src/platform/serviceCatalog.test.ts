import { describe, expect, it } from 'vitest';
import { Capability } from './catalogLoader';
import {
  CREATE_INTENT_KEY,
  CatalogPreferences,
  DEFAULT_PREFERENCES,
  LiveCounts,
  PREFERENCES_KEY,
  PreferenceStorage,
  applyCatalogQuery,
  buildServiceCatalog,
  capabilityForLiveId,
  clearedCreateLocation,
  createHref,
  createIntentFor,
  deriveFacets,
  filterServiceEntries,
  loadPreferences,
  normalizeCapabilityKey,
  readCapabilityFromHash,
  resolveCreateCapability,
  savePreferences,
  searchServiceEntries,
  serviceHref,
  sortServiceEntries,
  stateIndicator,
  stateLabel,
  takeCreateIntent,
  unmatchedCapabilityKeys,
  writeCreateIntent,
} from './serviceCatalog';

function capability(partial: Partial<Capability> & { id: string }): Capability {
  return {
    domain: 'compute',
    name: partial.id,
    version: 'v1',
    displayName: partial.id,
    displayNamePt: partial.id,
    description: '',
    descriptionPt: '',
    pattern: 'kro + ACK',
    engine: 'ack',
    lifecycle: 'available',
    goldenPath: 'GP-X1',
    // Sem rgdRef a identidade live é o próprio id; o fixture divergente abaixo cobre o outro caso.
    liveCapability: partial.liveCapability ?? partial.id,
    ...partial,
  };
}

/** Contagem live por capability, no formato que `GET /cluster/capabilities?counts=true` devolve. */
function counts(map: Record<string, number | null>): LiveCounts {
  return { counts: map };
}

const FIXTURE: Capability[] = [
  capability({ id: 'lambda', domain: 'compute', liveCapability: 'lambda-function', rgdRef: 'platform/compositions/lambda-function-rgd.yaml', displayName: 'Lambda function', displayNamePt: 'Função Lambda', description: 'Governed Lambda function.', descriptionPt: 'Função Lambda governada.' }),
  capability({ id: 'dynamodb', domain: 'database', engine: 'ack', liveCapability: 'dynamodb-table', displayName: 'DynamoDB table', displayNamePt: 'Tabela DynamoDB', lifecycle: 'preview' }),
  capability({ id: 'scheduled', domain: 'agent', engine: 'kro', liveCapability: 'scheduled-agent', displayName: 'Scheduled agent', displayNamePt: 'Agent agendado' }),
  capability({ id: 'postgres', domain: 'database', lifecycle: 'planned', displayName: 'PostgreSQL database', displayNamePt: 'Banco PostgreSQL' }),
];

// In-memory storage so the test needs no browser localStorage.
function memoryStorage(seed: Record<string, string> = {}): PreferenceStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value; },
    removeItem: key => { delete data[key]; },
  };
}

describe('live capability key normalisation', () => {
  // The three shapes the platform actually emits: kro compositions tag the bare id, the tour
  // writes "frontend/static-web-app (tour)" and the admin path writes "agent/kagent-declarative".
  it('accepts the bare id, the domain-prefixed form and a parenthetical suffix', () => {
    expect(normalizeCapabilityKey('inference-ecs')).toBe('inference-ecs');
    expect(normalizeCapabilityKey('frontend/static-web-app (tour)')).toBe('static-web-app');
    expect(normalizeCapabilityKey('agent/kagent-declarative')).toBe('kagent-declarative');
    expect(normalizeCapabilityKey('  COMPUTE/Lambda  ')).toBe('lambda');
  });

  it('treats an absent or empty tag as no capability instead of matching everything', () => {
    expect(normalizeCapabilityKey('')).toBe('');
    expect(normalizeCapabilityKey('   ')).toBe('');
    expect(normalizeCapabilityKey('/')).toBe('');
  });
});

describe('added state from the live capability count', () => {
  it('marks a capability added only when the cluster counts an instance, never from a fixed flag', () => {
    const entries = buildServiceCatalog(FIXTURE, counts({ 'lambda-function': 1 }));
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    expect(byId.get('lambda')?.state).toBe('added');
    expect(byId.get('lambda')?.instanceCount).toBe(1);
    // Everything else keeps its declared lifecycle: no instance, no added state.
    expect(byId.get('dynamodb')?.state).toBe('preview');
    expect(byId.get('scheduled')?.state).toBe('available');
    expect(byId.get('postgres')?.state).toBe('planned');
    expect(entries.filter(entry => entry.state === 'added')).toHaveLength(1);
  });

  it('joins on the LIVE capability, so a divergent catalog id still resolves', () => {
    // `lambda` compõe o RGD `lambda-function`: contar pelo id do catálogo não acharia nada.
    expect(buildServiceCatalog(FIXTURE, counts({ 'lambda-function': 3 })).find(entry => entry.id === 'lambda')?.instanceCount).toBe(3);
    expect(buildServiceCatalog(FIXTURE, counts({ lambda: 3 })).find(entry => entry.id === 'lambda')?.state).toBe('available');
  });

  it('distingue zero, não lido e não lido em geral - os três são afirmações diferentes', () => {
    const zero = buildServiceCatalog(FIXTURE, counts({ 'lambda-function': 0 })).find(entry => entry.id === 'lambda');
    expect(zero?.state).toBe('available');
    expect(zero?.instanceCount).toBe(0);

    const oneFailed = buildServiceCatalog(FIXTURE, counts({ 'lambda-function': null })).find(entry => entry.id === 'lambda');
    expect(oneFailed?.state).toBe('unknown');
    expect(oneFailed?.instanceCount).toBeNull();

    const allFailed = buildServiceCatalog(FIXTURE, { counts: null });
    expect(allFailed.every(entry => entry.state === 'unknown')).toBe(true);
  });

  it('sem leitura nenhuma, NADA é marcado como disponível nem como adicionado', () => {
    const entries = buildServiceCatalog(FIXTURE);
    expect(entries).toHaveLength(FIXTURE.length);
    expect(entries.some(entry => entry.state === 'added')).toBe(false);
    // Este é o defeito que o estado unknown remove: o lifecycle do arquivo não vaza como estado.
    expect(entries.some(entry => entry.state === 'available')).toBe(false);
  });

  it('reports a live capability that has no catalog file instead of dropping it silently', () => {
    expect(unmatchedCapabilityKeys(FIXTURE, counts({ 'kagent-declarative': 1, 'lambda-function': 1 }))).toEqual(['kagent-declarative']);
    expect(unmatchedCapabilityKeys(FIXTURE, counts({ 'lambda-function': 1 }))).toEqual([]);
    // Sem leitura não há como afirmar que algo está fora do catálogo.
    expect(unmatchedCapabilityKeys(FIXTURE, { counts: null })).toEqual([]);
  });

  it('resolve a capability live de volta para o catálogo, e recusa o que não é do catálogo', () => {
    expect(capabilityForLiveId(FIXTURE, 'lambda-function')?.id).toBe('lambda');
    expect(capabilityForLiveId(FIXTURE, 'lambda')?.id).toBe('lambda');
    expect(capabilityForLiveId(FIXTURE, 's3/buckets')).toBeNull();
    expect(capabilityForLiveId(FIXTURE, '')).toBeNull();
  });
});

describe('search', () => {
  const entries = buildServiceCatalog(FIXTURE, counts({}));

  it('finds by name, by description and by category', () => {
    expect(searchServiceEntries(entries, 'Lambda').map(entry => entry.id)).toEqual(['lambda']);
    expect(searchServiceEntries(entries, 'governed').map(entry => entry.id)).toEqual(['lambda']);
    expect(searchServiceEntries(entries, 'database').map(entry => entry.id).sort()).toEqual(['dynamodb', 'postgres']);
  });

  it('ignores case and accents, so the pt-BR name is reachable from an ASCII keyboard', () => {
    expect(searchServiceEntries(entries, 'funcao').map(entry => entry.id)).toEqual(['lambda']);
    expect(searchServiceEntries(entries, 'FUNÇÃO').map(entry => entry.id)).toEqual(['lambda']);
    expect(searchServiceEntries(entries, 'agendado').map(entry => entry.id)).toEqual(['scheduled']);
  });

  it('returns everything for an empty or blank query rather than nothing', () => {
    expect(searchServiceEntries(entries, '')).toHaveLength(entries.length);
    expect(searchServiceEntries(entries, '   ')).toHaveLength(entries.length);
  });

  it('returns an empty list for a term the catalog does not have', () => {
    expect(searchServiceEntries(entries, 'kubernetes-operator-xyz')).toEqual([]);
  });
});

describe('facets derived from the catalog', () => {
  it('derives categories, states and engines from the entries, with counts that add up', () => {
    const entries = buildServiceCatalog(FIXTURE, counts({ 'lambda-function': 1 }));
    const facets = deriveFacets(entries);
    expect(facets.categories.map(facet => facet.value).sort()).toEqual(['agent', 'compute', 'database']);
    expect(facets.states.map(facet => facet.value).sort()).toEqual(['added', 'available', 'planned', 'preview']);
    expect(facets.engines.map(facet => facet.value).sort()).toEqual(['ack', 'kro']);
    // Each dimension partitions the entries: the parts must sum to the whole, never double-count.
    for (const dimension of [facets.categories, facets.states, facets.engines]) {
      expect(dimension.reduce((total, facet) => total + facet.count, 0)).toBe(entries.length);
    }
  });

  it('drops a category from the facets as soon as the catalog loses it', () => {
    const withoutAgents = FIXTURE.filter(entry => entry.domain !== 'agent');
    const facets = deriveFacets(buildServiceCatalog(withoutAgents, counts({})));
    expect(facets.categories.map(facet => facet.value)).not.toContain('agent');
  });
});

describe('filters and sorting', () => {
  const entries = buildServiceCatalog(FIXTURE, counts({ 'lambda-function': 1 }));

  it('filters by category, state and engine, and combines them with AND', () => {
    expect(filterServiceEntries(entries, { categories: ['database'] }).map(entry => entry.id).sort()).toEqual(['dynamodb', 'postgres']);
    expect(filterServiceEntries(entries, { states: ['added'] }).map(entry => entry.id)).toEqual(['lambda']);
    expect(filterServiceEntries(entries, { engines: ['kro'] }).map(entry => entry.id)).toEqual(['scheduled']);
    expect(filterServiceEntries(entries, { categories: ['database'], states: ['preview'] }).map(entry => entry.id)).toEqual(['dynamodb']);
  });

  it('treats an absent or empty filter as no filter', () => {
    expect(filterServiceEntries(entries, {})).toHaveLength(entries.length);
    expect(filterServiceEntries(entries, { categories: [] })).toHaveLength(entries.length);
  });

  it('sorts by name, category, state and instance count, and reverses on demand', () => {
    expect(sortServiceEntries(entries, 'name').map(entry => entry.displayName)).toEqual(['DynamoDB table', 'Lambda function', 'PostgreSQL database', 'Scheduled agent']);
    expect(sortServiceEntries(entries, 'name', true).map(entry => entry.displayName)).toEqual(['Scheduled agent', 'PostgreSQL database', 'Lambda function', 'DynamoDB table']);
    // State order is usefulness order: what is already added first, what cannot be used last.
    expect(sortServiceEntries(entries, 'state').map(entry => entry.state)).toEqual(['added', 'available', 'preview', 'planned']);
    expect(sortServiceEntries(entries, 'instances', true)[0].id).toBe('lambda');
    expect(sortServiceEntries(entries, 'category').map(entry => entry.category)).toEqual(['agent', 'compute', 'database', 'database']);
  });

  it('breaks ties by display name so grid and table never disagree on order', () => {
    const tied = sortServiceEntries(entries, 'category');
    expect(tied.filter(entry => entry.category === 'database').map(entry => entry.displayName)).toEqual(['DynamoDB table', 'PostgreSQL database']);
  });

  it('does not mutate the list it was given', () => {
    const before = entries.map(entry => entry.id);
    sortServiceEntries(entries, 'name', true);
    expect(entries.map(entry => entry.id)).toEqual(before);
  });

  it('applies search, filters and sorting as one pipeline, so both views show the same set', () => {
    const result = applyCatalogQuery(entries, { query: 'a', filters: { categories: ['database'] }, sortField: 'name' });
    expect(result.map(entry => entry.id)).toEqual(['dynamodb', 'postgres']);
    expect(applyCatalogQuery(entries)).toHaveLength(entries.length);
  });
});

describe('status is never colour alone', () => {
  it('gives every state a distinct label and a distinct indicator type', () => {
    const states = ['added', 'available', 'preview', 'planned', 'deprecated', 'unknown'] as const;
    const labelsEn = states.map(state => stateLabel(state, false));
    const labelsPt = states.map(state => stateLabel(state, true));
    const indicators = states.map(stateIndicator);
    expect(new Set(labelsEn).size).toBe(states.length);
    expect(new Set(labelsPt).size).toBe(states.length);
    expect(new Set(indicators).size).toBe(states.length);
    expect(labelsEn.every(Boolean)).toBe(true);
    expect(labelsPt.every(Boolean)).toBe(true);
  });

  it('o rótulo de unknown não promete disponibilidade, que é o que a falha mostrava antes', () => {
    expect(stateLabel('unknown', true)).toBe('Estado não lido');
    expect(stateLabel('unknown', false)).toBe('State not read');
    expect(stateIndicator('unknown')).toBe('warning');
  });
});

describe('persisted view preference', () => {
  it('round-trips the preference through storage', () => {
    const storage = memoryStorage();
    const wanted: CatalogPreferences = { viewMode: 'table', pageSize: 24, sortField: 'name', descending: true };
    savePreferences(wanted, storage);
    expect(JSON.parse(storage.data[PREFERENCES_KEY])).toEqual(wanted);
    expect(loadPreferences(storage)).toEqual(wanted);
  });

  it('falls back to the default when nothing is stored or no storage exists', () => {
    expect(loadPreferences(memoryStorage())).toEqual(DEFAULT_PREFERENCES);
    expect(loadPreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it('rejects a corrupt or outdated stored value field by field instead of rendering an impossible view', () => {
    expect(loadPreferences(memoryStorage({ [PREFERENCES_KEY]: 'not json' }))).toEqual(DEFAULT_PREFERENCES);
    expect(loadPreferences(memoryStorage({ [PREFERENCES_KEY]: '"a string"' }))).toEqual(DEFAULT_PREFERENCES);
    const partly = loadPreferences(memoryStorage({ [PREFERENCES_KEY]: JSON.stringify({ viewMode: 'kanban', pageSize: 9999, sortField: 'name', descending: 'yes' }) }));
    expect(partly).toEqual({ ...DEFAULT_PREFERENCES, sortField: 'name' });
  });

  it('survives a storage that throws, which is what private mode and a full quota do', () => {
    const hostile: PreferenceStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
    };
    expect(loadPreferences(hostile)).toEqual(DEFAULT_PREFERENCES);
    expect(() => savePreferences(DEFAULT_PREFERENCES, hostile)).not.toThrow();
  });
});

describe('Create carries the capability', () => {
  const entries = buildServiceCatalog(FIXTURE, counts({}));
  const lambda = entries.find(entry => entry.id === 'lambda')!;
  const scheduled = entries.find(entry => entry.id === 'scheduled')!;

  it('derives the wizard kind from the category instead of asking the user again', () => {
    expect(createIntentFor(lambda, 1700)).toEqual({ capability: 'lambda', kind: 'infra', category: 'compute', at: 1700 });
    expect(createIntentFor(scheduled, 1700)).toEqual({ capability: 'scheduled', kind: 'agent', category: 'agent', at: 1700 });
  });

  it('builds the governed wizard hash and the real service route', () => {
    expect(createHref(lambda)).toBe('#provision/lambda');
    // A rota do serviço usa a identidade LIVE: `lambda` compõe o RGD `lambda-function`, e é esse
    // nome que a cluster-api lista. Usar o id aqui abria uma capability inexistente.
    expect(serviceHref(lambda)).toBe('/agent-platform/services/lambda-function');
    expect(createHref(lambda).slice(1).split('/')[0]).toBe('provision');
    expect(serviceHref(lambda).startsWith('/agent-platform/services/')).toBe(true);
    expect(readCapabilityFromHash(createHref(lambda))).toBe('lambda');
    expect(readCapabilityFromHash('#provision')).toBe('');
  });

  it('hands the intent to the wizard once and then forgets it', () => {
    const storage = memoryStorage();
    writeCreateIntent(createIntentFor(scheduled, 42), storage);
    expect(takeCreateIntent(FIXTURE, storage)).toEqual({ capability: 'scheduled', kind: 'agent', category: 'agent', at: 42 });
    // A later visit to the wizard must not be pre-filled by an old click.
    expect(takeCreateIntent(FIXTURE, storage)).toBeNull();
  });

  it('ignores an intent for a capability the catalog no longer has', () => {
    const storage = memoryStorage({ [CREATE_INTENT_KEY]: JSON.stringify({ capability: 'removed-service', kind: 'infra' }) });
    expect(takeCreateIntent(FIXTURE, storage)).toBeNull();
  });

  it('ignores a corrupt intent and the absence of storage', () => {
    expect(takeCreateIntent(FIXTURE, memoryStorage({ [CREATE_INTENT_KEY]: '{' }))).toBeNull();
    expect(takeCreateIntent(FIXTURE, memoryStorage())).toBeNull();
    expect(takeCreateIntent(FIXTURE, null)).toBeNull();
  });

  it('o clique vence a query antiga, e sem clique a query ainda vale', () => {
    const storage = memoryStorage();
    writeCreateIntent(createIntentFor(scheduled, 99), storage);
    const won = resolveCreateCapability({ search: '?capability=dynamodb-table', hash: '#provision/scheduled', capabilities: FIXTURE, storage });
    expect([won.capability?.id, won.source]).toEqual(['scheduled', 'intent']);

    const fromQuery = resolveCreateCapability({ search: '?capability=dynamodb-table&ns=team-a', hash: '#provision', capabilities: FIXTURE, storage: memoryStorage() });
    expect([fromQuery.capability?.id, fromQuery.source, fromQuery.namespace]).toEqual(['dynamodb', 'query', 'team-a']);

    // Sem sinal nenhum cai no fallback declarado, e diz que foi fallback.
    const none = resolveCreateCapability({ search: '', hash: '#provision', capabilities: FIXTURE, storage: memoryStorage(), fallback: lambda.capability });
    expect([none.capability?.id, none.source, none.namespace]).toEqual(['lambda', 'default', 'appmod']);
  });

  it('limpa só os parâmetros consumidos, preservando a view e o resto da query', () => {
    expect(clearedCreateLocation('?capability=web-api&ns=team-a&keep=1', '#provision/lambda'))
      .toEqual({ search: '?keep=1', hash: '#provision', changed: true });
    expect(clearedCreateLocation('', '#catalog')).toEqual({ search: '', hash: '#catalog', changed: false });
  });
});
