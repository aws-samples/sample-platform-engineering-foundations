/*
 * Service Catalog page (issue #7): the entry point of the Agent Platform.
 *
 * Data flow, deliberately one-directional:
 *   platform/catalog/**\/capability.yaml       -> catalogLoader -> buildServiceCatalog
 *   cluster-api /cluster/capabilities?counts=true -> live counts -> added state
 *
 * The added state used to come from the AWS Tagging API through the platform-api, which answers a
 * different question (tagged AWS resources, not platform objects) and, on failure, degraded to the
 * file lifecycle: every service flashed "Available" the moment the API was down. Now the count has
 * three distinct outcomes -- read, not readable, zero -- and the page renders all three as
 * themselves.
 *
 * `counts` can be passed in by a parent that already loaded them (the shell does, to feed the side
 * navigation) or left out, in which case the page loads them itself. There is no third source and
 * no hardcoded deployed flag.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { capabilities as allCapabilities } from './catalogLoader';
import { InventoryError, listCapabilities } from './kdpInventoryApi';
import { useI18n } from './i18n';
import {
  CatalogFilters,
  CatalogPreferences,
  LiveCounts,
  ServiceEntry,
  SortField,
  applyCatalogQuery,
  buildServiceCatalog,
  createHref,
  createIntentFor,
  deriveFacets,
  loadPreferences,
  savePreferences,
  unmatchedCapabilityKeys,
  writeCreateIntent,
} from './serviceCatalog';
import {
  CatalogEmptyState,
  CatalogFacetFilters,
  CatalogSearch,
  ServiceCards,
  ServiceDetailSections,
  ServiceTable,
  ViewModeToggle,
  categoryLabel,
  description,
  name,
} from './ServiceCatalogParts';

export interface ServiceCatalogPageProps {
  /** Live instance counts per LIVE capability. Omit to let the page load them itself. */
  counts?: LiveCounts;
  /** Capability id to open directly when the host does not provide route navigation. */
  initialServiceId?: string;
  /**
   * Called when the user presses Create. The page has already recorded the capability (hash and
   * storage); a host that navigates here keeps the SPA intact instead of reloading.
   */
  onCreate?(capabilityId: string): void;
  /** Opens the capability inventory in the platform shell. */
  onOpenService?(capabilityId: string): void;
  /** Navigates to a `#view` inside the shell without a page reload. */
  onNavigateView?(view: string): void;
}

const SORT_FIELDS: SortField[] = ['state', 'name', 'category', 'instances'];

export function ServiceCatalogPage({ counts, initialServiceId, onCreate, onOpenService, onNavigateView }: ServiceCatalogPageProps): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';

  const [loaded, setLoaded] = useState<LiveCounts>({ counts: null });
  const [loading, setLoading] = useState(!counts);
  const [liveError, setLiveError] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<CatalogFilters>({});
  const [preferences, setPreferences] = useState<CatalogPreferences>(() => loadPreferences());
  const [openId, setOpenId] = useState(initialServiceId ?? '');
  const inFlight = useRef<AbortController | null>(null);

  // Only fetch when the parent did not supply the counts; a parent-owned read stays the single
  // source. The abort keeps a slow answer from landing on an unmounted page.
  useEffect(() => {
    if (counts) return;
    const controller = new AbortController();
    inFlight.current?.abort();
    inFlight.current = controller;
    listCapabilities({ counts: true }, controller.signal)
      .then(response => {
        const map: Record<string, number | null> = {};
        for (const capability of response.capabilities) {
          // `instances` is absent when the backend was not asked to count, and null when that
          // one source failed. Both are "unknown" for this capability, never zero.
          map[capability.capability] = capability.instances === undefined ? null : capability.instances;
        }
        setLoaded({ counts: map });
        setLiveError('');
      })
      .catch(cause => {
        if (cause instanceof InventoryError && cause.aborted) return;
        // The whole read failed: counts stay null, so every entry renders `unknown` instead of
        // inheriting the file lifecycle.
        setLoaded({ counts: null });
        setLiveError(cause instanceof Error && cause.message ? cause.message : 'cluster-api unavailable');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [counts]);

  const live = counts ?? loaded;
  const effectiveLoading = counts?.loading ?? loading;
  const effectiveError = counts?.error ?? liveError;
  const entries = useMemo(() => buildServiceCatalog(allCapabilities, live), [live]);
  const facets = useMemo(() => deriveFacets(entries), [entries]);
  const visible = useMemo(
    () => applyCatalogQuery(entries, { query, filters, sortField: preferences.sortField, descending: preferences.descending }),
    [entries, query, filters, preferences.sortField, preferences.descending],
  );
  const unmatched = useMemo(() => unmatchedCapabilityKeys(allCapabilities, live), [live]);
  const open = useMemo(() => entries.find(entry => entry.id === openId) ?? null, [entries, openId]);

  const update = useCallback((next: Partial<CatalogPreferences>) => {
    setPreferences(current => {
      const merged = { ...current, ...next };
      savePreferences(merged);
      return merged;
    });
  }, []);

  const goToView = useCallback((view: string) => {
    if (onNavigateView) onNavigateView(view);
    // No host callback (standalone render): the hash is still the view, and writing it is a
    // same-document change, not a reload.
    else window.location.hash = view;
  }, [onNavigateView]);

  const goToProvision = useCallback((entry: ServiceEntry) => {
    // Record the capability both ways: the hash survives a reload and a shared link, the storage
    // copy survives the lazy chunk load between this click and the wizard mounting. The intent
    // carries its timestamp, which is what lets it outrank a stale `?capability=` in the query.
    writeCreateIntent(createIntentFor(entry));
    goToView(createHref(entry).slice(1));
    onCreate?.(entry.id);
  }, [goToView, onCreate]);

  const openService = useCallback((entry: ServiceEntry) => {
    if (onOpenService) onOpenService(entry.id);
    else setOpenId(entry.id);
  }, [onOpenService]);

  const clearFilters = useCallback(() => { setQuery(''); setFilters({}); }, []);

  const empty = (
    <CatalogEmptyState
      filtered={Boolean(query) || Boolean(filters.categories?.length || filters.states?.length || filters.engines?.length)}
      pt={pt}
      onClear={clearFilters}
      onProvision={() => goToView('provision')}
    />
  );

  if (open) {
    return (
      <ContentLayout
        header={
          <Header
            variant="h1"
            description={description(open, pt)}
            actions={<Button onClick={() => setOpenId('')}>{pt ? 'Voltar ao catálogo' : 'Back to catalog'}</Button>}
            info={<Badge>{categoryLabel(open.category, pt)}</Badge>}
          >
            {name(open, pt)}
          </Header>
        }
      >
        <ServiceDetailSections entry={open} pt={pt} onCreate={goToProvision} onOpenService={onOpenService ? openService : undefined} />
      </ContentLayout>
    );
  }

  const sortOptions = SORT_FIELDS.map(field => ({
    value: field,
    label: pt
      ? ({ state: 'Estado', name: 'Nome', category: 'Categoria', instances: 'Instâncias' }[field])
      : ({ state: 'State', name: 'Name', category: 'Category', instances: 'Instances' }[field]),
  }));

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          counter={`(${visible.length}/${entries.length})`}
          description={pt
            ? 'Todo serviço da plataforma em um lugar. O catálogo vem dos arquivos em platform/catalog e o estado adicionado vem da contagem live da cluster-api.'
            : 'Every platform service in one place. The catalog comes from the files in platform/catalog and the added state comes from the cluster-api live count.'}
          actions={<Button variant="primary" href="#provision" onFollow={event => { event.preventDefault(); goToView('provision'); }}>{pt ? 'Provisionar' : 'Provision'}</Button>}
        >
          {pt ? 'Catálogo de serviços' : 'Service catalog'}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {effectiveLoading && (
          <StatusIndicator type="loading">
            {pt ? 'Lendo as capabilities live do cluster' : 'Reading the live capabilities from the cluster'}
          </StatusIndicator>
        )}
        {!!effectiveError && (
          <Alert type="error" header={pt ? 'Estado adicionado indisponível' : 'Added state unavailable'}>
            {pt
              ? `A cluster-api não respondeu: ${effectiveError}. O catálogo continua navegável, e cada serviço mostra "Estado não lido" - nenhum é marcado como disponível ou adicionado sem leitura.`
              : `The cluster-api did not respond: ${effectiveError}. The catalog stays browsable and every service reads "State not read" - none is marked available or added without a live read.`}
          </Alert>
        )}
        {unmatched.length > 0 && (
          <Alert type="info" header={pt ? 'Capabilities live fora do catálogo' : 'Live capabilities outside the catalog'}>
            {pt
              ? `A cluster-api reporta ${unmatched.length} capability sem arquivo em platform/catalog (${unmatched.join(', ')}). Elas não entram nas contagens acima.`
              : `The cluster-api reports ${unmatched.length} capability with no file in platform/catalog (${unmatched.join(', ')}). They are not part of the counts above.`}
          </Alert>
        )}
        <SpaceBetween size="s">
          <CatalogSearch query={query} count={visible.length} pt={pt} onChange={setQuery} />
          <CatalogFacetFilters facets={facets} filters={filters} pt={pt} onChange={setFilters} />
          <SpaceBetween direction="horizontal" size="s" alignItems="center">
            <ViewModeToggle viewMode={preferences.viewMode} pt={pt} onChange={viewMode => update({ viewMode })} />
            <Box variant="awsui-key-label">{pt ? 'Ordenar por' : 'Sort by'}</Box>
            <Select
              selectedOption={sortOptions.find(option => option.value === preferences.sortField) ?? sortOptions[0]}
              options={sortOptions}
              onChange={({ detail }) => update({ sortField: String(detail.selectedOption.value) as SortField })}
              ariaLabel={pt ? 'Ordenar por' : 'Sort by'}
            />
            <Button
              iconName={preferences.descending ? 'caret-down-filled' : 'caret-up-filled'}
              onClick={() => update({ descending: !preferences.descending })}
            >
              {preferences.descending ? (pt ? 'Decrescente' : 'Descending') : (pt ? 'Crescente' : 'Ascending')}
            </Button>
            {effectiveLoading && <StatusIndicator type="loading">{pt ? 'Lendo contagem live' : 'Reading live count'}</StatusIndicator>}
          </SpaceBetween>
        </SpaceBetween>
        {preferences.viewMode === 'grid'
          ? <ServiceCards entries={visible} pt={pt} empty={empty} onOpen={openService} onCreate={goToProvision} />
          : (
            <ServiceTable
              entries={visible}
              pt={pt}
              empty={empty}
              sortField={preferences.sortField}
              descending={preferences.descending}
              onOpen={openService}
              onCreate={goToProvision}
              onSort={(sortField, descending) => update({ sortField, descending })}
            />
          )}
      </SpaceBetween>
    </ContentLayout>
  );
}

export default ServiceCatalogPage;
