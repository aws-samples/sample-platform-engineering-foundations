import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Capability } from './catalogLoader';
import {
  CatalogEmptyState,
  CatalogFacetFilters,
  CatalogSearch,
  ServiceCards,
  ServiceDetailSections,
  ServiceStatus,
  ServiceTable,
  ViewModeToggle,
  categoryLabel,
  facetOptions,
  serviceNavigationItems,
  serviceNavigationSection,
} from './ServiceCatalogParts';
import { buildServiceCatalog, createHref, deriveFacets, serviceHref } from './serviceCatalog';

// Cloudscape uses useLayoutEffect; React warns about it under server rendering. Only that warning
// is filtered, so a real console error still surfaces.
const originalError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return;
    originalError(...args);
  });
});
afterAll(() => vi.restoreAllMocks());

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const noop = () => undefined;

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
    liveCapability: partial.liveCapability ?? partial.id,
    ...partial,
  };
}

const FIXTURE: Capability[] = [
  capability({ id: 'lambda', domain: 'compute', liveCapability: 'lambda-function', displayName: 'Lambda function', displayNamePt: 'Função Lambda', description: 'Governed Lambda function.', descriptionPt: 'Função Lambda governada.' }),
  capability({ id: 'dynamodb', domain: 'database', liveCapability: 'dynamodb-table', displayName: 'DynamoDB table', displayNamePt: 'Tabela DynamoDB', lifecycle: 'preview' }),
  capability({ id: 'postgres', domain: 'database', displayName: 'PostgreSQL database', displayNamePt: 'Banco PostgreSQL', lifecycle: 'planned' }),
];

// Contagem live, no formato de `GET /cluster/capabilities?counts=true`: é desta fonte que o estado
// Adicionado sai agora, e a chave é a identidade LIVE da capability.
const COUNTS = { counts: { 'lambda-function': 1, 'dynamodb-table': 0 } };

const entries = buildServiceCatalog(FIXTURE, COUNTS);
const lambda = entries.find(entry => entry.id === 'lambda')!;
const dynamodb = entries.find(entry => entry.id === 'dynamodb')!;
const postgres = entries.find(entry => entry.id === 'postgres')!;

describe('status never depends on colour alone', () => {
  it('writes the state as text next to its icon, in both locales', () => {
    const added = renderToStaticMarkup(<ServiceStatus entry={lambda} pt />);
    expect(text(added)).toContain('Adicionado');
    expect(added).toContain('<svg');
    expect(text(renderToStaticMarkup(<ServiceStatus entry={lambda} pt={false} />))).toContain('Added');
    expect(text(renderToStaticMarkup(<ServiceStatus entry={dynamodb} pt />))).toContain('Preview');
    expect(text(renderToStaticMarkup(<ServiceStatus entry={postgres} pt />))).toContain('Planejado');
  });

  it('spells out the instance count, so added and available differ in words and not only in icon', () => {
    expect(text(renderToStaticMarkup(<ServiceStatus entry={lambda} pt />))).toContain('1 instância');
    expect(text(renderToStaticMarkup(<ServiceStatus entry={lambda} pt={false} />))).toContain('1 instance');
    const twice = buildServiceCatalog(FIXTURE, { counts: { 'lambda-function': 2 } });
    expect(text(renderToStaticMarkup(<ServiceStatus entry={twice[0]} pt />))).toContain('2 instâncias');
    // An available service carries no count, so the two states are never confusable.
    expect(text(renderToStaticMarkup(<ServiceStatus entry={dynamodb} pt />))).not.toContain('instância');
  });

  it('diz que o estado não foi lido em vez de herdar o lifecycle quando a contagem falha', () => {
    const unread = buildServiceCatalog(FIXTURE, { counts: null })[0];
    const html = text(renderToStaticMarkup(<ServiceStatus entry={unread} pt />));
    expect(html).toContain('Estado não lido');
    // O defeito era exatamente este: a tela dizia Disponível sem ninguém ter lido o cluster.
    expect(html).not.toContain('Disponível');
    expect(html).not.toContain('instância');
  });

  it('gives each state a distinct icon shape, not just a distinct colour', () => {
    const icons = [lambda, dynamodb, postgres].map(entry => {
      const html = renderToStaticMarkup(<ServiceStatus entry={entry} pt={false} />);
      return (html.match(/<svg[^>]*class="[^"]*"/) ?? [''])[0] + (html.match(/<path[^>]*d="[^"]{0,40}/) ?? [''])[0];
    });
    expect(new Set(icons).size).toBe(3);
  });
});

describe('search and facets reflect the real catalog', () => {
  it('reports the match count as text while a search is active', () => {
    expect(text(renderToStaticMarkup(<CatalogSearch query="lambda" count={1} pt onChange={noop} />))).toContain('1 resultado');
    expect(text(renderToStaticMarkup(<CatalogSearch query="lambda" count={3} pt onChange={noop} />))).toContain('3 resultados');
    expect(text(renderToStaticMarkup(<CatalogSearch query="lambda" count={3} pt={false} onChange={noop} />))).toContain('3 matches');
    expect(text(renderToStaticMarkup(<CatalogSearch query="lambda" count={1} pt={false} onChange={noop} />))).toContain('1 match');
  });

  it('offers a search placeholder that names the three searchable fields', () => {
    const html = renderToStaticMarkup(<CatalogSearch query="" count={3} pt onChange={noop} />);
    expect(html).toContain('nome');
    expect(html).toContain('descri');
    expect(html).toContain('categoria');
  });

  it('builds one facet option per derived value, with its count, and no invented category', () => {
    // Cloudscape renders the dropdown closed with an empty option list on the server, so the
    // labels are asserted on the option builder the select is given.
    const all = facetOptions(deriveFacets(entries), false);
    expect(all.categories.map(option => option.label).sort()).toEqual(['Compute (1)', 'Database (2)']);
    expect(all.states.map(option => option.label).sort()).toEqual(['Added (1)', 'Planned (1)', 'Preview (1)']);
    expect(all.engines.map(option => option.label)).toEqual(['ack (3)']);
    expect(all.categories.map(option => option.value)).not.toContain('messaging');
    expect(facetOptions(deriveFacets(entries), true).categories.map(option => option.label).sort()).toEqual(['Banco de dados (2)', 'Compute (1)']);
  });

  it('renders the three facet selects, each with its own accessible label', () => {
    const html = renderToStaticMarkup(<CatalogFacetFilters facets={deriveFacets(entries)} filters={{}} pt={false} onChange={noop} />);
    expect(html).toContain('Filter by category');
    expect(html).toContain('Filter by state');
    expect(html).toContain('Filter by engine');
    expect(renderToStaticMarkup(<CatalogFacetFilters facets={deriveFacets(entries)} filters={{}} pt onChange={noop} />)).toContain('Filtrar por categoria');
  });

  it('labels an unknown category by its own name rather than hiding it', () => {
    expect(categoryLabel('probe', true)).toBe('probe');
    expect(categoryLabel('compute', true)).toBe('Compute');
    expect(categoryLabel('compute', false)).toBe('Compute');
    expect(categoryLabel('agent', true)).toBe('Agents');
  });

  it('exposes grid and table as labelled, keyboard-reachable choices', () => {
    const html = renderToStaticMarkup(<ViewModeToggle viewMode="grid" pt onChange={noop} />);
    expect(text(html)).toContain('Grade');
    expect(text(html)).toContain('Tabela');
  });
});

describe('the card opens the service and Create carries the capability', () => {
  const cards = renderToStaticMarkup(
    <ServiceCards entries={entries} pt={false} empty={<span>none</span>} onOpen={noop} onCreate={noop} />,
  );

  it('links the card title to that service page, not to a generic screen', () => {
    expect(cards).toContain(`href="${serviceHref(lambda)}"`);
    expect(cards).toContain(`href="${serviceHref(dynamodb)}"`);
    expect(cards).not.toContain('href="#inventory"');
    expect(cards).not.toContain('href="#overview"');
  });

  it('points every Create at the provisioning wizard with the capability id in the hash', () => {
    expect(cards).toContain(`href="${createHref(lambda)}"`);
    expect(cards).toContain('href="#provision/dynamodb"');
    expect(createHref(lambda)).toBe('#provision/lambda');
  });

  it('shows category, provider, lifecycle and state on the card', () => {
    const content = text(cards);
    expect(content).toContain('Lambda function');
    expect(content).toContain('Governed Lambda function.');
    expect(content).toContain('Compute');
    expect(content).toContain('Database');
    expect(content).toContain('ack');
    expect(content).toContain('kro + ACK');
    expect(content).toContain('GP-X1');
    expect(content).toContain('Added');
  });

  it('renders the pt-BR name and description when the locale is pt-BR', () => {
    const pt = text(renderToStaticMarkup(<ServiceCards entries={[lambda]} pt empty={<span>none</span>} onOpen={noop} onCreate={noop} />));
    expect(pt).toContain('Função Lambda');
    expect(pt).toContain('Função Lambda governada.');
    expect(pt).toContain('Abrir serviço');
  });

  it('offers no Create for a planned capability, because there is nothing to provision yet', () => {
    const planned = renderToStaticMarkup(<ServiceCards entries={[postgres]} pt={false} empty={<span>none</span>} onOpen={noop} onCreate={noop} />);
    expect(planned).toContain('disabled');
    expect(text(planned)).toContain('Planned');
  });
});

describe('table view shows the same data with sorting', () => {
  const table = renderToStaticMarkup(
    <ServiceTable entries={entries} pt={false} empty={<span>none</span>} sortField="name" descending={false} onOpen={noop} onCreate={noop} onSort={noop} />,
  );

  it('lists every entry with its category, state, instance count and provider', () => {
    const content = text(table);
    for (const entry of entries) expect(content).toContain(entry.displayName);
    expect(content).toContain('Compute');
    expect(content).toContain('Added');
    expect(content).toContain('ack');
  });

  it('marks the sortable columns, so ordering works in the table as well as the grid', () => {
    expect(table).toContain('aria-sort');
    expect(text(table)).toContain('Instances');
    expect(text(table)).toContain('State');
    expect(text(table)).toContain('Category');
  });

  it('keeps the same service and Create links the grid uses', () => {
    expect(table).toContain(`href="${serviceHref(lambda)}"`);
    expect(table).toContain(`href="${createHref(lambda)}"`);
  });
});

describe('an added capability is promoted to the Serviços menu', () => {
  it('lists only added services, each linking to its own service page', () => {
    const items = serviceNavigationItems(entries, false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'link', text: 'Lambda function', href: serviceHref(lambda) });
    // Available and planned services are not menu entries: the menu reflects what exists.
    expect(items.map(item => 'text' in item && item.text)).not.toContain('DynamoDB table');
  });

  it('uses the pt-BR name in the menu when the locale is pt-BR', () => {
    expect(serviceNavigationItems(entries, true).map(item => 'text' in item && item.text)).toEqual(['Função Lambda']);
  });

  it('grows as soon as another capability gets an instance, with no hardcoded menu', () => {
    const twoAdded = buildServiceCatalog(FIXTURE, { counts: { 'lambda-function': 1, 'dynamodb-table': 1 } });
    const items = serviceNavigationItems(twoAdded, false);
    expect(items.map(item => 'text' in item && item.text)).toEqual(['DynamoDB table', 'Lambda function']);
    // O href é a identidade LIVE, que é por onde a cluster-api lista.
    expect(items.map(item => 'href' in item && item.href)).toEqual(['/agent-platform/services/dynamodb-table', '/agent-platform/services/lambda-function']);
  });

  it('wraps the entries in a Serviços section, and returns nothing while no service is added', () => {
    const section = serviceNavigationSection(entries, true);
    expect(section?.type).toBe('section');
    expect(section?.text).toBe('Serviços');
    expect(section?.items).toHaveLength(1);
    expect(serviceNavigationSection(buildServiceCatalog(FIXTURE, { counts: {} }), true)).toBeNull();
    expect(serviceNavigationItems(buildServiceCatalog(FIXTURE, { counts: {} }), true)).toEqual([]);
    // Contagem não lida também não promove serviço nenhum ao menu.
    expect(serviceNavigationSection(buildServiceCatalog(FIXTURE, { counts: null }), true)).toBeNull();
  });
});

describe('empty state always offers a way forward', () => {
  it('offers the provisioning CTA when the catalog itself is empty', () => {
    const html = renderToStaticMarkup(<CatalogEmptyState filtered={false} pt onClear={noop} onProvision={noop} />);
    expect(text(html)).toContain('Provisionar um serviço');
    expect(text(html)).toContain('platform/catalog');
    expect(text(html)).not.toContain('Limpar filtros');
  });

  it('offers both clearing the filter and provisioning when a filter emptied the list', () => {
    const html = renderToStaticMarkup(<CatalogEmptyState filtered pt onClear={noop} onProvision={noop} />);
    expect(text(html)).toContain('Limpar filtros');
    expect(text(html)).toContain('Provisionar um serviço');
  });
});

describe('service page reports the live instances behind the added state', () => {
  it('reporta a contagem live e a fonte dela, e nomeia a capability do cluster', () => {
    const content = text(renderToStaticMarkup(<ServiceDetailSections entry={lambda} pt onCreate={noop} />));
    expect(content).toContain('Instâncias live');
    expect(content).toContain('/cluster/capabilities?counts=true');
    expect(content).toContain('(1)');
    expect(content).toContain('Adicionado');
    // A identidade live aparece na tela: é ela que a rota e a contagem usam.
    expect(content).toContain('lambda-function');
    // E a antiga tabela de ARNs não voltou por acidente.
    expect(content).not.toContain('AWS Tagging API');
    expect(content).not.toContain('auto-delete: no');
  });

  it('não afirma contagem quando a leitura live falhou', () => {
    const unread = buildServiceCatalog(FIXTURE, { counts: null }).find(entry => entry.id === 'lambda')!;
    const content = text(renderToStaticMarkup(<ServiceDetailSections entry={unread} pt onCreate={noop} />));
    expect(content).toContain('não foi lida');
    expect(content).not.toContain('(0)');
  });

  it('oferece abrir o inventário live quando o host sabe navegar', () => {
    const content = text(renderToStaticMarkup(<ServiceDetailSections entry={lambda} pt onCreate={noop} onOpenService={noop} />));
    expect(content).toContain('Abrir inventário live');
  });

  it('shows identity, provider and golden path for the service', () => {
    const content = text(renderToStaticMarkup(<ServiceDetailSections entry={lambda} pt={false} onCreate={noop} />));
    expect(content).toContain('Service identity');
    expect(content).toContain('Compute');
    expect(content).toContain('ack');
    expect(content).toContain('GP-X1');
    expect(content).toContain('v1');
  });

  it('explains the absence and keeps the CTA when the service has no instance yet', () => {
    const content = text(renderToStaticMarkup(<ServiceDetailSections entry={dynamodb} pt onCreate={noop} />));
    expect(content).toContain('Nenhuma instância ainda');
    expect(content).toContain('Create');
    expect(content).toContain('(0)');
  });
});
