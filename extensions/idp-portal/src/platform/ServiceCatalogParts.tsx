/*
 * Presentational parts of the Service Catalog (issue #7). Every part takes `pt` as a prop instead
 * of reading the i18n context, which is what lets the DOM tests render them with
 * renderToStaticMarkup (the same pattern AgentBuilderParts uses).
 *
 * Accessibility: status is always an icon PLUS its label, and the added state additionally shows
 * the instance count as text. Nothing here is distinguishable by colour alone.
 */
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Multiselect from '@cloudscape-design/components/multiselect';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import { SideNavigationProps } from '@cloudscape-design/components/side-navigation';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import {
  CatalogFacets,
  CatalogFilters,
  ServiceEntry,
  SortField,
  ViewMode,
  createHref,
  serviceHref,
  stateIndicator,
  stateLabel,
} from './serviceCatalog';

const CATEGORY_PT: Record<string, string> = {
  agent: 'Agents',
  app: 'Aplicações',
  cache: 'Cache',
  compute: 'Compute',
  database: 'Banco de dados',
  entrypoint: 'Entrada',
  frontend: 'Frontend',
  messaging: 'Mensageria',
  storage: 'Armazenamento',
};

/** Unknown categories fall through to their own name, so a new capability domain needs no code change. */
export function categoryLabel(category: string, pt: boolean): string {
  return pt ? (CATEGORY_PT[category] ?? category) : category.charAt(0).toUpperCase() + category.slice(1);
}

export function name(entry: ServiceEntry, pt: boolean): string {
  return pt ? entry.displayNamePt : entry.displayName;
}

export function description(entry: ServiceEntry, pt: boolean): string {
  return pt ? entry.descriptionPt : entry.description;
}

/**
 * The "Serviços" side-navigation section: one entry per capability that has live instances, each
 * pointing at that service's own page.
 *
 * This lives here rather than in the page because the side navigation is owned by the host shell.
 * A host adds the section by spreading the result into its own item list, so promoting an added
 * capability into the menu needs no change to this file or to the host's hardcoded sections.
 * Returns an empty array while nothing is added, so the section can be dropped entirely.
 */
export function serviceNavigationItems(entries: ServiceEntry[], pt: boolean): SideNavigationProps.Item[] {
  return entries
    .filter(entry => entry.state === 'added')
    .sort((a, b) => name(a, pt).localeCompare(name(b, pt)))
    .map(entry => ({
      type: 'link' as const,
      text: name(entry, pt),
      href: serviceHref(entry),
      info: <Badge color="green">{String(entry.instanceCount ?? '?')}</Badge>,
    }));
}

/** The whole section, or null when no service is added yet. */
export function serviceNavigationSection(entries: ServiceEntry[], pt: boolean): SideNavigationProps.Section | null {
  const items = serviceNavigationItems(entries, pt);
  return items.length ? { type: 'section', text: pt ? 'Serviços' : 'Services', items } : null;
}

/**
 * Status as icon + text. For an added service the instance count is part of the label, so the
 * difference between "added" and "available" survives a greyscale screenshot and a screen reader.
 * An unknown count says so in words; it never borrows the file lifecycle, because "Available" when
 * the live read failed is a claim nobody verified.
 */
export function ServiceStatus({ entry, pt }: { entry: ServiceEntry; pt: boolean }): JSX.Element {
  const count = entry.instanceCount;
  const suffix = entry.state === 'added' && count !== null
    ? ` · ${count} ${pt ? (count === 1 ? 'instância' : 'instâncias') : count === 1 ? 'instance' : 'instances'}`
    : '';
  return <StatusIndicator type={stateIndicator(entry.state)}>{stateLabel(entry.state, pt)}{suffix}</StatusIndicator>;
}

export interface FacetsProps {
  facets: CatalogFacets;
  filters: CatalogFilters;
  pt: boolean;
  onChange(filters: CatalogFilters): void;
}

function options(values: { value: string; count: number }[], label: (value: string) => string) {
  return values.map(facet => ({ value: facet.value, label: `${label(facet.value)} (${facet.count})` }));
}

function selected(values: string[] | undefined, all: { value: string; count: number }[], label: (value: string) => string) {
  const chosen = new Set(values ?? []);
  return options(all, label).filter(option => chosen.has(option.value));
}

export interface FacetOption {
  value: string;
  label: string;
}

/**
 * The option lists for the three facet selects. Exported because Cloudscape renders a closed
 * dropdown with an empty option list on the server, so this is the only place the label and the
 * count can actually be asserted.
 */
export function facetOptions(facets: CatalogFacets, pt: boolean): { categories: FacetOption[]; states: FacetOption[]; engines: FacetOption[] } {
  return {
    categories: options(facets.categories, value => categoryLabel(value, pt)),
    states: options(facets.states, value => stateLabel(value as ServiceEntry['state'], pt)),
    engines: options(facets.engines, value => value),
  };
}

/** Facets are rendered from the counts handed in, never from a hardcoded list of categories. */
export function CatalogFacetFilters({ facets, filters, pt, onChange }: FacetsProps): JSX.Element {
  const stateText = (value: string) => stateLabel(value as ServiceEntry['state'], pt);
  const all = facetOptions(facets, pt);
  const empty = pt ? 'Todas' : 'All';
  return (
    <ColumnLayout columns={3}>
      <Multiselect
        selectedOptions={selected(filters.categories, facets.categories, value => categoryLabel(value, pt))}
        options={all.categories}
        onChange={({ detail }) => onChange({ ...filters, categories: detail.selectedOptions.map(option => String(option.value)) })}
        placeholder={pt ? 'Categoria' : 'Category'}
        ariaLabel={pt ? 'Filtrar por categoria' : 'Filter by category'}
        selectedAriaLabel={pt ? 'Selecionado' : 'Selected'}
        empty={empty}
      />
      <Multiselect
        selectedOptions={selected(filters.states, facets.states, stateText)}
        options={all.states}
        onChange={({ detail }) => onChange({ ...filters, states: detail.selectedOptions.map(option => String(option.value)) })}
        placeholder={pt ? 'Estado' : 'State'}
        ariaLabel={pt ? 'Filtrar por estado' : 'Filter by state'}
        selectedAriaLabel={pt ? 'Selecionado' : 'Selected'}
        empty={empty}
      />
      <Multiselect
        selectedOptions={selected(filters.engines, facets.engines, value => value)}
        options={all.engines}
        onChange={({ detail }) => onChange({ ...filters, engines: detail.selectedOptions.map(option => String(option.value)) })}
        placeholder={pt ? 'Engine' : 'Engine'}
        ariaLabel={pt ? 'Filtrar por engine' : 'Filter by engine'}
        selectedAriaLabel={pt ? 'Selecionado' : 'Selected'}
        empty={empty}
      />
    </ColumnLayout>
  );
}

export function CatalogSearch({ query, count, pt, onChange }: { query: string; count: number; pt: boolean; onChange(value: string): void }): JSX.Element {
  return (
    <TextFilter
      filteringText={query}
      onChange={({ detail }) => onChange(detail.filteringText)}
      filteringPlaceholder={pt ? 'Buscar por nome, descrição ou categoria' : 'Search by name, description or category'}
      filteringAriaLabel={pt ? 'Buscar serviços' : 'Search services'}
      countText={`${count} ${pt ? (count === 1 ? 'resultado' : 'resultados') : count === 1 ? 'match' : 'matches'}`}
    />
  );
}

export function ViewModeToggle({ viewMode, pt, onChange }: { viewMode: ViewMode; pt: boolean; onChange(mode: ViewMode): void }): JSX.Element {
  return (
    <SegmentedControl
      selectedId={viewMode}
      onChange={({ detail }) => onChange(detail.selectedId as ViewMode)}
      label={pt ? 'Modo de exibição' : 'View mode'}
      options={[
        { id: 'grid', text: pt ? 'Grade' : 'Grid', iconName: 'view-full' },
        { id: 'table', text: pt ? 'Tabela' : 'Table', iconName: 'list-view' },
      ]}
    />
  );
}

/**
 * The empty state always offers the provisioning CTA, including when a filter emptied the list: a
 * dead end is the one thing an entry point cannot afford.
 */
export function CatalogEmptyState({ filtered, pt, onClear, onProvision }: { filtered: boolean; pt: boolean; onClear(): void; onProvision(): void }): JSX.Element {
  return (
    <Box textAlign="center" padding={{ vertical: 'l' }}>
      <SpaceBetween size="s">
        <Box variant="strong">{filtered ? (pt ? 'Nenhum serviço casa com esse filtro' : 'No service matches this filter') : (pt ? 'Nenhum serviço no catálogo' : 'No service in the catalog')}</Box>
        <Box variant="small" color="text-body-secondary">
          {filtered
            ? (pt ? 'Limpe os filtros ou provisione o serviço que você precisa.' : 'Clear the filters or provision the service you need.')
            : (pt ? 'O catálogo vem de platform/catalog. Abra um MR para adicionar uma capability.' : 'The catalog comes from platform/catalog. Open an MR to add a capability.')}
        </Box>
        <SpaceBetween direction="horizontal" size="xs">
          {filtered && <Button onClick={onClear}>{pt ? 'Limpar filtros' : 'Clear filters'}</Button>}
          <Button variant="primary" onClick={onProvision}>{pt ? 'Provisionar um serviço' : 'Provision a service'}</Button>
        </SpaceBetween>
      </SpaceBetween>
    </Box>
  );
}

export interface ServiceListProps {
  entries: ServiceEntry[];
  pt: boolean;
  empty: JSX.Element;
  onOpen(entry: ServiceEntry): void;
  onCreate(entry: ServiceEntry): void;
}

/** Grid view. The card title is the link to that service's own page (criterion: the card opens the service). */
export function ServiceCards({ entries, pt, empty, onOpen, onCreate }: ServiceListProps): JSX.Element {
  return (
    <Cards
      items={entries}
      trackBy="id"
      ariaLabels={{
        cardsLabel: pt ? 'Serviços do catálogo' : 'Catalog services',
        selectionGroupLabel: pt ? 'Seleção de serviço' : 'Service selection',
        itemSelectionLabel: (_data, item) => name(item, pt),
      }}
      cardDefinition={{
        header: entry => (
          <Link
            fontSize="heading-m"
            href={serviceHref(entry)}
            onFollow={event => { event.preventDefault(); onOpen(entry); }}
          >
            {name(entry, pt)}
          </Link>
        ),
        sections: [
          { id: 'description', content: entry => description(entry, pt) },
          { id: 'category', header: pt ? 'Categoria' : 'Category', content: entry => <Badge>{categoryLabel(entry.category, pt)}</Badge> },
          { id: 'state', header: pt ? 'Estado' : 'State', content: entry => <ServiceStatus entry={entry} pt={pt} /> },
          {
            id: 'provider',
            header: pt ? 'Provider e lifecycle' : 'Provider and lifecycle',
            content: entry => `${entry.engine} · ${entry.pattern} · ${entry.goldenPath || '-'} · ${entry.version}`,
          },
          {
            id: 'actions',
            content: entry => (
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={() => onOpen(entry)}>{pt ? 'Abrir serviço' : 'Open service'}</Button>
                <Button
                  variant="primary"
                  href={createHref(entry)}
                  disabled={entry.lifecycle === 'planned'}
                  onFollow={event => { event.preventDefault(); onCreate(entry); }}
                >
                  Create
                </Button>
              </SpaceBetween>
            ),
          },
        ],
      }}
      cardsPerRow={[{ cards: 1 }, { minWidth: 700, cards: 2 }, { minWidth: 1100, cards: 3 }]}
      empty={empty}
    />
  );
}

const SORT_COLUMN: Record<SortField, string> = { name: 'name', category: 'category', state: 'state', instances: 'instances' };

export interface ServiceTableProps extends ServiceListProps {
  sortField: SortField;
  descending: boolean;
  onSort(field: SortField, descending: boolean): void;
}

/** Table view over the same entries, with the same sort state, so the two views cannot disagree. */
export function ServiceTable({ entries, pt, empty, sortField, descending, onOpen, onCreate, onSort }: ServiceTableProps): JSX.Element {
  const columnDefinitions = [
    {
      id: 'name',
      header: pt ? 'Serviço' : 'Service',
      sortingField: SORT_COLUMN.name,
      cell: (entry: ServiceEntry) => (
        <Link href={serviceHref(entry)} onFollow={event => { event.preventDefault(); onOpen(entry); }}>{name(entry, pt)}</Link>
      ),
    },
    { id: 'category', header: pt ? 'Categoria' : 'Category', sortingField: SORT_COLUMN.category, cell: (entry: ServiceEntry) => categoryLabel(entry.category, pt) },
    { id: 'state', header: pt ? 'Estado' : 'State', sortingField: SORT_COLUMN.state, cell: (entry: ServiceEntry) => <ServiceStatus entry={entry} pt={pt} /> },
    { id: 'instances', header: pt ? 'Instâncias' : 'Instances', sortingField: SORT_COLUMN.instances, cell: (entry: ServiceEntry) => entry.instanceCount === null ? (pt ? 'não lido' : 'not read') : String(entry.instanceCount) },
    { id: 'engine', header: 'Provider', cell: (entry: ServiceEntry) => entry.engine },
    { id: 'pattern', header: pt ? 'Padrão' : 'Pattern', cell: (entry: ServiceEntry) => entry.pattern },
    {
      id: 'actions',
      header: pt ? 'Ações' : 'Actions',
      cell: (entry: ServiceEntry) => (
        <Button
          variant="inline-link"
          href={createHref(entry)}
          disabled={entry.lifecycle === 'planned'}
          onFollow={event => { event.preventDefault(); onCreate(entry); }}
        >
          Create
        </Button>
      ),
    },
  ];
  return (
    <Table
      items={entries}
      trackBy="id"
      variant="borderless"
      columnDefinitions={columnDefinitions}
      sortingColumn={{ sortingField: SORT_COLUMN[sortField] }}
      sortingDescending={descending}
      onSortingChange={({ detail }) => onSort((detail.sortingColumn.sortingField ?? 'name') as SortField, Boolean(detail.isDescending))}
      empty={empty}
      ariaLabels={{ tableLabel: pt ? 'Serviços do catálogo' : 'Catalog services' }}
    />
  );
}

/**
 * The in-catalog service panel. It reports the service identity and the LIVE instance count, and
 * sends the user to that capability's own inventory page for the objects themselves.
 *
 * It used to render a table of tagged AWS ARNs from the platform-api. That table is gone: the ARNs
 * answer "which AWS resources carry this tag", which is not the same question as "which platform
 * objects exist" (a kro capability with no AWS resource is still added, and a leftover tagged ARN
 * is not), so the two disagreed with the service page the user opened next. The live inventory is
 * the one place that lists objects, and `onOpenService` takes the user there.
 */
export function ServiceDetailSections({ entry, pt, onCreate, onOpenService }: {
  entry: ServiceEntry;
  pt: boolean;
  onCreate(entry: ServiceEntry): void;
  onOpenService?(entry: ServiceEntry): void;
}): JSX.Element {
  const count = entry.instanceCount;
  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2">{pt ? 'Identidade do serviço' : 'Service identity'}</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          <div><Box variant="awsui-key-label">{pt ? 'Categoria' : 'Category'}</Box>{categoryLabel(entry.category, pt)}</div>
          <div><Box variant="awsui-key-label">{pt ? 'Estado' : 'State'}</Box><ServiceStatus entry={entry} pt={pt} /></div>
          <div><Box variant="awsui-key-label">Provider</Box>{entry.engine}</div>
          <div><Box variant="awsui-key-label">{pt ? 'Padrão da plataforma' : 'Platform pattern'}</Box>{entry.pattern}</div>
          <div><Box variant="awsui-key-label">Golden path</Box>{entry.goldenPath || '-'}</div>
          <div><Box variant="awsui-key-label">{pt ? 'Versão' : 'Version'}</Box>{entry.version}</div>
          {/* A identidade live é o que a rota e a contagem usam: mostrá-la torna a divergência
              id != RGD auditável em vez de invisível. */}
          <div><Box variant="awsui-key-label">{pt ? 'Capability no cluster' : 'Cluster capability'}</Box>{entry.liveCapability}</div>
        </ColumnLayout>
      </Container>
      <Container
        header={
          <Header
            variant="h2"
            counter={count === null ? undefined : `(${count})`}
            description={pt
              ? 'Fonte live: GET /cluster/capabilities?counts=true na cluster-api. Os objetos ficam na página do serviço, que lê o cluster na hora.'
              : 'Live source: GET /cluster/capabilities?counts=true on the cluster-api. The objects live on the service page, which reads the cluster on open.'}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {onOpenService && (
                  <Button href={serviceHref(entry)} onFollow={event => { event.preventDefault(); onOpenService(entry); }}>
                    {pt ? 'Abrir inventário live' : 'Open live inventory'}
                  </Button>
                )}
                <Button variant="primary" onClick={() => onCreate(entry)} disabled={entry.lifecycle === 'planned'}>Create</Button>
              </SpaceBetween>
            }
          >
            {pt ? 'Instâncias live' : 'Live instances'}
          </Header>
        }
      >
        <Box padding={{ vertical: 's' }}>
          {count === null
            ? <StatusIndicator type="warning">{pt
                ? 'A contagem live não foi lida. Nada aqui é snapshot: sem resposta da cluster-api, não afirmamos quantas instâncias existem.'
                : 'The live count was not read. Nothing here is a snapshot: with no cluster-api answer we do not claim an instance count.'}</StatusIndicator>
            : count === 0
              ? <SpaceBetween size="xs">
                  <Box variant="strong">{pt ? 'Nenhuma instância ainda' : 'No instance yet'}</Box>
                  <Box variant="small" color="text-body-secondary">
                    {pt ? 'Este serviço está disponível no catálogo e ainda não foi adicionado.' : 'This service is available in the catalog and has not been added yet.'}
                  </Box>
                </SpaceBetween>
              : <StatusIndicator type="success">{pt
                  ? `${count} ${count === 1 ? 'instância' : 'instâncias'} no cluster agora`
                  : `${count} ${count === 1 ? 'instance' : 'instances'} in the cluster right now`}</StatusIndicator>}
        </Box>
      </Container>
    </SpaceBetween>
  );
}
