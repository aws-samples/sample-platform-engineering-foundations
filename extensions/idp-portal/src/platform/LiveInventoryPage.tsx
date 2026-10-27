/*
 * Issue #8 - página de objetos live por serviço.
 *
 * A lista vem de GET /cluster/instances a cada leitura. Não existe fixture nem
 * array fixo neste arquivo: se o objeto não está no cluster, ele não aparece, e
 * se a fonte não pôde ser lida, aparece erro e não lista vazia.
 *
 * Três decisões de arquitetura, com o motivo:
 *
 * 1. Namespace, busca, filtros, ordenação e paginação são do SERVIDOR. O backend
 *    aplica o namespace na URL do API server e a autorização antes de ler, então
 *    filtrar no browser seria filtrar um universo que o browser não deveria ter
 *    recebido. Por isso não há useCollection aqui: cada mudança de filtro é uma
 *    consulta nova.
 *
 * 2. Os filtros vivem na URL. É o que faz o Back do browser restaurar a consulta
 *    sem o componente guardar nada: a URL É o estado.
 *
 * 3. O componente de página não conhece o router. Ele recebe estado e callbacks,
 *    e o wrapper no fim do arquivo é o único lugar com hooks de rota. Isso é o
 *    que torna cada estado da tela verificável por render estático.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Pagination from '@cloudscape-design/components/pagination';
import Select, { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import TextFilter from '@cloudscape-design/components/text-filter';
import { getOverview } from './clusterApi';
import { useI18n } from './i18n';
import {
  ALL_NAMESPACES, InstanceRow, InstancesResponse, InventoryError, listInstances,
} from './kdpInventoryApi';
import {
  CursorStack, DEFAULT_LIST_STATE, EMPTY_CURSOR_STACK, ListState, RequestGate, capabilityFromSlug,
  createRequestGate, createRequestPath, cursorForPage, decodeListState, detailPath, encodeListState,
  filtersOnly, kindTabs, nextRefreshDelay, pagesCount, pushCursor, sortFieldOfColumn,
  stateIndicator, syncedIndicator,
} from './kdpInventoryModel';
import {
  EmptyInventory, FreshnessCell, LiveStatus, LoadFailure, SourceWarning,
} from './KdpInventoryParts';
import { ScorecardLevelCell } from './scorecardParts';

/** Opções de filtro que o backend aceita, montadas do que a leitura devolveu. */
function optionsFrom(values: string[], allLabel: string): SelectProps.Option[] {
  return [{ label: allLabel, value: '' }, ...values.map(value => ({ label: value, value }))];
}

const READY_OPTIONS = (pt: boolean): SelectProps.Option[] => [
  { label: pt ? 'Qualquer' : 'Any', value: '' },
  { label: pt ? 'Pronto' : 'Ready', value: 'true' },
  { label: pt ? 'Não pronto' : 'Not ready', value: 'false' },
];

export interface LiveInventoryViewProps {
  capability: string;
  /** Filtros, vindos da URL. Cursor e página NÃO moram aqui (ver filtersOnly). */
  state: ListState;
  /** Muda filtro. O chamador decide se isso vira push ou replace na history. */
  onStateChange: (next: ListState) => void;
  onOpenDetail: (row: InstanceRow) => void;
  onCreate: () => void;
}

/**
 * A tela. Sem router e sem estado global: dá para renderizar em teste e observar
 * carregando, erro, vazio e lista com objeto convergindo ou pronto.
 */
export function LiveInventoryView({ capability, state, onStateChange, onOpenDetail, onCreate }: LiveInventoryViewProps): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [response, setResponse] = useState<InstancesResponse | null>(null);
  const [failure, setFailure] = useState<InventoryError | null>(null);
  const [loading, setLoading] = useState(true);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [cursors, setCursors] = useState<CursorStack>(EMPTY_CURSOR_STACK);
  const [search, setSearch] = useState(state.search);
  /*
   * Posição na paginação é estado do componente, não da URL: o cursor é preso ao
   * digest da consulta no backend, e um cursor em URL compartilhada envelheceria
   * e levaria 400 na próxima leitura.
   */
  const [position, setPosition] = useState<{ cursor: string; page: number }>({ cursor: '', page: 1 });
  // Guarda a consulta efetivamente feita, para o refresh automático repetir a
  // MESMA consulta em vez de uma que o usuário já abandonou.
  const queried = useRef<ListState>(state);
  /*
   * Porteiro das leituras concorrentes (ver `createRequestGate`): filtro trocado duas vezes em
   * sequência deixa duas leituras no ar, e sem porteiro a mais LENTA é a que pinta a tabela - o
   * usuário via a lista do filtro anterior com o filtro novo selecionado.
   */
  const gate = useRef<RequestGate>(createRequestGate());

  useEffect(() => { setSearch(state.search); }, [state.search]);

  const load = useCallback(async (target: ListState, quiet: boolean) => {
    queried.current = target;
    const { token, signal } = gate.current.begin();
    if (!quiet) setLoading(true);
    try {
      const page = await listInstances({
        capability, kind: target.kind || undefined, namespace: target.namespace,
        search: target.search || undefined, state: target.state || undefined,
        synced: target.synced || undefined, ready: target.ready || undefined,
        sort: target.sort, order: target.order, limit: target.limit,
        cursor: target.cursor || undefined,
      }, signal);
      if (!gate.current.isCurrent(token)) return;
      setResponse(page);
      setFailure(null);
      setCursors(current => pushCursor(current, target.page, page.page.nextCursor));
    } catch (cause) {
      // Cancelamento próprio: a leitura que o substituiu é que decide a tela.
      if (cause instanceof InventoryError && cause.aborted) return;
      if (!gate.current.isCurrent(token)) return;
      if (cause instanceof InventoryError && cause.status === 400 && target.cursor) {
        // Cursor envelhecido (a consulta mudou de digest): volta à primeira
        // página em vez de deixar a tela num erro que o usuário não causou.
        setPosition({ cursor: '', page: 1 });
        return;
      }
      // Invariante I-A no browser: a falha substitui a lista, nunca a esvazia.
      setFailure(cause instanceof InventoryError ? cause : new InventoryError(0, String(cause)));
      setResponse(null);
    } finally {
      if (gate.current.isCurrent(token)) setLoading(false);
    }
  }, [capability]);

  // Desmontar aborta o que estava no ar: a resposta não tem mais tela para atualizar.
  useEffect(() => () => { gate.current.abort(); }, []);

  /*
   * A dependência é a consulta SERIALIZADA, não o objeto: `state` é recriado a
   * cada render a partir da query string, então depender da identidade dele
   * refaria a leitura em loop.
   */
  const queryKey = `${encodeListState(filtersOnly(state))}|${position.page}|${position.cursor}`;
  useEffect(() => {
    void load({ ...state, ...position }, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, queryKey]);

  // Filtro novo recomeça a paginação: a página 3 da consulta anterior não existe
  // na consulta nova, e o cursor dela seria recusado pelo backend.
  const filterKey = encodeListState(filtersOnly(state));
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    setPosition({ cursor: '', page: 1 });
    setCursors(EMPTY_CURSOR_STACK);
  }, [filterKey]);

  useEffect(() => {
    getOverview().then(overview => setNamespaces(overview.namespaces ?? [])).catch(() => setNamespaces([]));
  }, []);

  /*
   * Atualização automática: um objeto criado aparece sem reload manual (issue
   * #8). A cadência segue o que a lista mostra - rápida enquanto algo converge,
   * lenta quando tudo assentou - e o refresh é silencioso para não piscar a
   * tabela nem mexer no scroll.
   */
  useEffect(() => {
    const delay = nextRefreshDelay({ items: response?.items ?? [], partial: response?.partial });
    const timer = window.setInterval(() => void load(queried.current, true), delay);
    return () => window.clearInterval(timer);
  }, [load, response]);

  const update = (patch: Partial<ListState>) => onStateChange({ ...state, ...patch, cursor: '', page: 1 });
  const items = response?.items ?? [];
  const tabs = kindTabs(response, pt);
  const filtered = Boolean(state.search || state.state || state.synced || state.ready || state.namespace !== ALL_NAMESPACES);
  const totalPages = Math.max(pagesCount(cursors), position.page);

  const table = (
    <Table
      items={items}
      loading={loading}
      loadingText={pt ? 'Lendo o cluster…' : 'Reading the cluster…'}
      variant="embedded"
      sortingColumn={{ sortingField: state.sort }}
      sortingDescending={state.order === 'desc'}
      onSortingChange={({ detail }) => update({
        sort: sortFieldOfColumn(detail.sortingColumn.sortingField),
        order: detail.isDescending ? 'desc' : 'asc',
      })}
      columnDefinitions={[
        {
          id: 'name', header: pt ? 'Nome' : 'Name', sortingField: 'name',
          cell: row => <Button variant="inline-link" onClick={() => onOpenDetail(row)}>{row.name}</Button>,
        },
        { id: 'kind', header: 'Kind', sortingField: 'kind', cell: row => row.kind },
        { id: 'namespace', header: 'Namespace', sortingField: 'namespace', cell: row => row.namespace },
        { id: 'state', header: 'State', sortingField: 'state', cell: row => <LiveStatus indicator={stateIndicator(row, pt)} /> },
        { id: 'synced', header: 'Synced', cell: row => <LiveStatus indicator={syncedIndicator(row.synced, pt)} /> },
        { id: 'scorecard', header: 'Scorecard', cell: row => <ScorecardLevelCell card={row.scorecard} pt={pt} /> },
        { id: 'freshness', header: pt ? 'Atualização' : 'Freshness', cell: row => <FreshnessCell freshness={row.freshness} pt={pt} /> },
        {
          id: 'actions', header: pt ? 'Ações' : 'Actions',
          cell: row => <Button variant="inline-link" onClick={() => onOpenDetail(row)}>{pt ? 'Abrir detalhe' : 'Open detail'}</Button>,
        },
      ]}
      empty={<EmptyInventory capability={capability} namespace={state.namespace} filtered={filtered} pt={pt}
        onCreate={onCreate} onClearFilters={() => onStateChange({ ...DEFAULT_LIST_STATE, kind: state.kind })} />}
      filter={
        <SpaceBetween direction="horizontal" size="xs">
          <TextFilter
            filteringText={search}
            filteringPlaceholder={pt ? 'Buscar por nome, namespace ou kind' : 'Find by name, namespace or kind'}
            filteringAriaLabel={pt ? 'Buscar objetos' : 'Find objects'}
            countText={response ? `${response.total}` : ''}
            onChange={({ detail }) => setSearch(detail.filteringText)}
            onDelayedChange={({ detail }) => update({ search: detail.filteringText })}
          />
          <FormField label="Namespace">
            <Select
              selectedOption={{ label: state.namespace === ALL_NAMESPACES ? (pt ? 'Todos os namespaces' : 'All namespaces') : state.namespace, value: state.namespace }}
              options={[{ label: pt ? 'Todos os namespaces' : 'All namespaces', value: ALL_NAMESPACES }, ...namespaces.map(value => ({ label: value, value }))]}
              filteringType="auto"
              onChange={({ detail }) => update({ namespace: String(detail.selectedOption.value ?? ALL_NAMESPACES) })}
            />
          </FormField>
          <FormField label="State">
            <Select
              selectedOption={{ label: state.state || (pt ? 'Qualquer' : 'Any'), value: state.state }}
              options={optionsFrom([...new Set(items.map(row => row.state))].sort(), pt ? 'Qualquer' : 'Any')}
              onChange={({ detail }) => update({ state: String(detail.selectedOption.value ?? '') })}
            />
          </FormField>
          <FormField label="Synced">
            <Select
              selectedOption={{ label: state.synced || (pt ? 'Qualquer' : 'Any'), value: state.synced }}
              options={optionsFrom(['True', 'False', 'Unknown'], pt ? 'Qualquer' : 'Any')}
              onChange={({ detail }) => update({ synced: String(detail.selectedOption.value ?? '') })}
            />
          </FormField>
          <FormField label={pt ? 'Pronto' : 'Ready'}>
            <Select
              selectedOption={READY_OPTIONS(pt).find(option => option.value === state.ready) ?? READY_OPTIONS(pt)[0]}
              options={READY_OPTIONS(pt)}
              onChange={({ detail }) => update({ ready: String(detail.selectedOption.value ?? '') })}
            />
          </FormField>
        </SpaceBetween>
      }
      pagination={
        <Pagination
          currentPageIndex={position.page}
          pagesCount={totalPages}
          openEnd={Boolean(response?.page.nextCursor)}
          ariaLabels={{ nextPageLabel: pt ? 'Próxima página' : 'Next page', previousPageLabel: pt ? 'Página anterior' : 'Previous page', pageLabel: index => `${pt ? 'Página' : 'Page'} ${index}` }}
          onChange={({ detail }) => {
            const cursor = cursorForPage(cursors, detail.currentPageIndex);
            // Página sem cursor conhecido não é navegável: o backend prende o
            // cursor à consulta e sintetizar um seria inventar um 400.
            if (cursor === null) return;
            setPosition({ cursor, page: detail.currentPageIndex });
          }}
        />
      }
      header={
        <Header
          counter={response ? `(${response.total})` : undefined}
          description={pt
            ? 'Objetos lidos do cluster agora. A lista se atualiza sozinha enquanto algo converge.'
            : 'Objects read from the cluster now. The list refreshes itself while anything is converging.'}
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button iconName="refresh" loading={loading} onClick={() => void load({ ...state, ...position }, false)}>{pt ? 'Atualizar' : 'Refresh'}</Button>
              <Button variant="primary" iconName="add-plus" onClick={onCreate}>{pt ? 'Criar' : 'Create'}</Button>
            </SpaceBetween>
          }
        >{capability}</Header>
      }
    />
  );

  return (
    <ContentLayout
      header={<Header variant="h1"
        description={pt
          ? 'Inventário live deste serviço, derivado do cluster e não de lista fixa no portal.'
          : 'Live inventory for this service, derived from the cluster and not from a fixed list in the portal.'}>
        {capability}
      </Header>}
    >
      <SpaceBetween size="l">
        {failure
          ? <LoadFailure message={failure.message} status={failure.status} sources={failure.sources} pt={pt} onRetry={() => void load({ ...state, ...position }, false)} />
          : <SourceWarning partial={Boolean(response?.partial)} sources={response?.sources} truncatedSources={response?.truncatedSources} pt={pt} />}
        {response?.truncated && (
          <Box variant="small">{pt
            ? 'O cluster devolveu mais objetos do que o limite de leitura por fonte; refine o namespace ou a busca.'
            : 'The cluster returned more objects than the per-source read limit; narrow the namespace or the search.'}</Box>
        )}
        {failure ? null : tabs.length > 0
          ? <Tabs activeTabId={state.kind} onChange={({ detail }) => update({ kind: detail.activeTabId })}
              tabs={tabs.map(tab => ({ id: tab.id, label: tab.label, content: tab.id === state.kind ? table : <Box /> }))} />
          : table}
      </SpaceBetween>
    </ContentLayout>
  );
}

/**
 * Wrapper de rota: o único lugar deste arquivo que conhece o router.
 *
 * Mudança de filtro entra na history com push, para que o Back do browser
 * desfaça um filtro por vez; só a paginação vai na URL como replace, porque
 * `filtersOnly` tira cursor e página antes de escrever.
 */
export function LiveInventoryRoute(): JSX.Element {
  const { capabilitySlug: slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const capability = capabilityFromSlug(slug);
  const state = decodeListState(params);
  const current = encodeListState(filtersOnly(state));
  return (
    <LiveInventoryView
      capability={capability}
      state={state}
      onStateChange={next => {
        const query = encodeListState(filtersOnly(next));
        /*
         * Consulta IDÊNTICA vira replace, nunca push. Sem isto, cada evento que reemite o mesmo
         * filtro (TextFilter com debounce, reset para o default já ativo, remonta do Tabs)
         * empilhava uma entrada igual na history: o Back parava de voltar porque voltava para a
         * mesma URL, e o usuário ficava preso clicando Back.
         */
        setParams(query, { replace: query === current });
      }}
      onOpenDetail={row => navigate(detailPath(row, filtersOnly(state)))}
      // Navegação interna pelo router. `window.location.assign` recarregava toda a aplicação.
      onCreate={() => navigate(createRequestPath(capability, state.namespace))}
    />
  );
}

export default LiveInventoryRoute;
