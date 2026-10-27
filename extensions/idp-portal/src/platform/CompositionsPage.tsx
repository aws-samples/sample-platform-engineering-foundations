/*
 * Página de Composições: o que o kro-ui mostrava, nativo no portal (backlog kro-native-compositions,
 * fatia 2). Toda ResourceGraphDefinition viva, lida da cluster-api, com estado, instâncias (total e
 * prontas), grafo determinístico, campos do schema (o contrato que o usuário preenche ao pedir) e
 * outputs. Nada aqui é inventado: definição sem plural na discovery aparece "sem listagem", fonte que
 * falhou vira aviso nomeado e nunca zero.
 *
 * Padrão de leitura: tabela em cima, detalhe da seleção embaixo em abas. Todo estado é texto + ícone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import { CompositionGraph } from './CompositionGraph';
import { errorMessage } from './errors';
import { useI18n } from './i18n';
import { ALL_NAMESPACES, CompositionSummary, CompositionsResponse, InventoryError, SchemaField, listCompositions } from './kdpInventoryApi';
import { ConditionsTable, LoadFailure, SourceWarning } from './KdpInventoryParts';
import { gitlabEditUrl, relativeAge } from './kdpInventoryModel';
import { RevisionsTable, RolloutTable } from './CompositionRevisionParts';

export interface CompositionsPageProps {
  /** Abre a lista de instâncias do serviço (a mesma rota de "Meus recursos"). */
  onOpenService(capability: string): void;
  onCreate(): void;
}

type Load =
  | { status: 'loading' }
  | { status: 'ready'; data: CompositionsResponse }
  | { status: 'error'; message: string; httpStatus?: number; sources?: CompositionsResponse['sources'] };

/** Estado da definição como texto + ícone. "Active" é o único valor que o kro publica como saudável. */
export function definitionIndicator(state: string, pt: boolean): { type: 'success' | 'error' | 'pending' | 'info'; text: string } {
  if (state === 'Active') return { type: 'success', text: 'Active' };
  if (state === 'Inactive') return { type: 'error', text: 'Inactive' };
  if (!state || state === 'Unknown') return { type: 'pending', text: pt ? 'Sem estado' : 'No state' };
  return { type: 'info', text: state };
}

/** Texto da coluna de instâncias. Erro de fonte e definição sem listagem são distintos de zero. */
export function instancesText(item: CompositionSummary, pt: boolean): string {
  if (!item.listable || !item.instances) return pt ? 'sem listagem' : 'not listable';
  if (item.instances.error) return pt ? `falha: ${item.instances.error}` : `failed: ${item.instances.error}`;
  const floor = item.instances.truncated ? '+' : '';
  return `${item.instances.ready}/${item.instances.total}${floor} ${pt ? 'prontas' : 'ready'}`;
}

function SchemaTable({ fields, pt }: { fields: SchemaField[]; pt: boolean }): JSX.Element {
  return (
    <Table<SchemaField>
      variant="borderless"
      items={fields}
      trackBy="path"
      wrapLines
      ariaLabels={{ tableLabel: pt ? 'Campos do schema' : 'Schema fields' }}
      columnDefinitions={[
        { id: 'path', header: pt ? 'Campo' : 'Field', isRowHeader: true, cell: row => <code>{row.path}</code> },
        { id: 'type', header: pt ? 'Tipo' : 'Type', cell: row => row.type },
        { id: 'required', header: pt ? 'Obrigatório' : 'Required', cell: row => (row.required ? (pt ? 'sim' : 'yes') : (pt ? 'não' : 'no')) },
        { id: 'default', header: 'Default', cell: row => (row.default === null ? '-' : <code>{row.default}</code>) },
        {
          id: 'description', header: pt ? 'Descrição' : 'Description',
          cell: row => {
            const extra = Object.entries(row.markers).map(([key, value]) => `${key}=${value}`).join(' ');
            return [row.description, extra].filter(Boolean).join(' ') || '-';
          },
        },
      ]}
      empty={<Box textAlign="center" color="text-body-secondary">{pt ? 'A definição não declara campos de entrada.' : 'The definition declares no input fields.'}</Box>}
    />
  );
}

function CompositionDetail({ item, pt, onOpenService }: { item: CompositionSummary; pt: boolean; onOpenService(capability: string): void }): JSX.Element {
  const indicator = definitionIndicator(item.state, pt);
  const stale = item.generation !== null && item.observedGeneration !== null && item.observedGeneration < item.generation;
  const sourceUrl = gitlabEditUrl(item.source);
  const behind = item.rollout.filter(row => row.rollout.status === 'behind').length;
  const unknown = item.rollout.filter(row => row.rollout.status === 'unknown').length;
  return (
    <Container
      header={(
        <Header
          variant="h2"
          description={`${item.apiVersion} · ${item.kind}`}
          actions={(
            <SpaceBetween direction="horizontal" size="xs">
              {/* Git é o único caminho de escrita: o "upgrade" de uma composição é editar e mergear a RGD. */}
              {sourceUrl && <Button href={sourceUrl} target="_blank" iconAlign="right" iconName="external">{pt ? 'Editar definição no Git' : 'Edit definition in Git'}</Button>}
              {item.listable && <Button onClick={() => onOpenService(item.name)}>{pt ? 'Ver instâncias' : 'View instances'}</Button>}
            </SpaceBetween>
          )}
        >
          {item.name}
        </Header>
      )}
    >
      <SpaceBetween size="m">
        <KeyValuePairs columns={4} items={[
          { label: pt ? 'Estado' : 'State', value: <StatusIndicator type={indicator.type}>{indicator.text}</StatusIndicator> },
          { label: pt ? 'Instâncias' : 'Instances', value: instancesText(item, pt) },
          {
            label: pt ? 'Geração' : 'Generation',
            value: item.generation === null ? '-' : `${item.generation}${stale ? (pt ? ' (status atrasado)' : ' (status stale)') : ''}`,
          },
          { label: pt ? 'Criada há' : 'Created', value: relativeAge(item.created ? (Date.now() - Date.parse(item.created)) / 1000 : null, pt) },
          {
            label: pt ? 'Revisão ativa' : 'Active revision',
            value: item.revisions.error
              ? (pt ? 'não lida' : 'not read')
              : item.revisions.latest
                ? `r${item.revisions.latest.revision}${item.revisions.pending ? (pt ? ` (r${item.revisions.pending.revision} pendente)` : ` (r${item.revisions.pending.revision} pending)`) : ''}`
                : '-',
          },
          {
            label: pt ? 'Rollout nas instâncias' : 'Instance rollout',
            value: item.rollout.length === 0
              ? '-'
              : behind > 0
                ? <StatusIndicator type="warning">{pt ? `${behind} atrás` : `${behind} behind`}</StatusIndicator>
                : unknown === item.rollout.length
                  ? <StatusIndicator type="pending">{pt ? 'não medido' : 'not measured'}</StatusIndicator>
                  : <StatusIndicator type="success">{pt ? `${item.rollout.length - unknown} na revisão atual` : `${item.rollout.length - unknown} on current revision`}</StatusIndicator>,
          },
        ]} />
        <Tabs
          tabs={[
            { id: 'graph', label: pt ? 'Grafo' : 'Graph', content: <CompositionGraph graph={item.graph} pt={pt} /> },
            {
              id: 'revisions',
              label: `${pt ? 'Revisões' : 'Revisions'} (${item.revisions.items.length})`,
              content: (
                <SpaceBetween size="m">
                  <Box color="text-body-secondary">{pt
                    ? 'Cada mudança da definição vira uma GraphRevision imutável e o kro reconcilia toda instância contra a revisão ativa mais recente; o upgrade é editar e mergear a definição no Git. O rollout por instância compara o hash da revisão nos recursos filhos: o kro 0.9.4 ainda não carimba esse hash nos filhos, então ele aparece como "não medido" até uma versão que carimbe.'
                    : 'Every change to the definition becomes an immutable GraphRevision and kro reconciles every instance against the latest active revision; upgrading is editing and merging the definition in Git. The per-instance rollout compares the revision hash on child resources: kro 0.9.4 does not stamp that hash on children yet, so it reads "not measured" until a version that does.'}</Box>
                  <RevisionsTable revisions={item.revisions} pt={pt} />
                  <Box variant="h4">{pt ? `Rollout por instância (${item.rollout.length})` : `Rollout per instance (${item.rollout.length})`}</Box>
                  <RolloutTable rollout={item.rollout} pt={pt} />
                </SpaceBetween>
              ),
            },
            {
              id: 'schema',
              label: `${pt ? 'Schema' : 'Schema'} (${item.schema.spec.length})`,
              content: (
                <SpaceBetween size="s">
                  <Box color="text-body-secondary">{pt
                    ? 'Campos que o usuário preenche ao pedir uma instância (spec.schema.spec da definição). Gerado do simpleschema do kro, sem edição manual.'
                    : 'Fields the user fills when requesting an instance (spec.schema.spec of the definition). Generated from the kro simpleschema, no manual editing.'}</Box>
                  <SchemaTable fields={item.schema.spec} pt={pt} />
                  <Box variant="h4">{pt ? `Outputs publicados em status (${item.schema.status.length})` : `Outputs published in status (${item.schema.status.length})`}</Box>
                  {item.schema.status.length === 0
                    ? <Box color="text-body-secondary">{pt ? 'Nenhum.' : 'None.'}</Box>
                    : <SpaceBetween direction="horizontal" size="xs">{item.schema.status.map(name => <Badge key={name}>{name}</Badge>)}</SpaceBetween>}
                </SpaceBetween>
              ),
            },
            { id: 'conditions', label: `${pt ? 'Condições' : 'Conditions'} (${item.conditions.length})`, content: <ConditionsTable conditions={item.conditions} pt={pt} /> },
          ]}
        />
      </SpaceBetween>
    </Container>
  );
}

export function CompositionsPage({ onOpenService, onCreate }: CompositionsPageProps): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const gate = useRef(new AbortController());

  const fetchAll = useCallback(async () => {
    gate.current.abort();
    const controller = new AbortController();
    gate.current = controller;
    setLoad({ status: 'loading' });
    try {
      const data = await listCompositions(ALL_NAMESPACES, controller.signal);
      if (controller.signal.aborted) return;
      setLoad({ status: 'ready', data });
    } catch (cause) {
      if (cause instanceof InventoryError && cause.aborted) return;
      if (cause instanceof InventoryError) setLoad({ status: 'error', message: cause.message, httpStatus: cause.status, sources: cause.sources });
      else setLoad({ status: 'error', message: errorMessage(cause, 'cluster API unavailable') });
    }
  }, []);

  useEffect(() => { void fetchAll(); }, [fetchAll]);
  useEffect(() => () => { gate.current.abort(); }, []);

  const items = load.status === 'ready' ? load.data.items : [];
  // Seleção segue a primeira definição quando nada foi escolhido ainda ou o escolhido sumiu.
  const selected = useMemo(() => items.find(item => item.name === selectedName) ?? items[0] ?? null, [items, selectedName]);

  const totals = useMemo(() => {
    const counted = items.filter(item => item.instances && !item.instances.error && item.instances.total !== null);
    return {
      definitions: items.length,
      active: items.filter(item => item.state === 'Active').length,
      instances: counted.reduce((sum, item) => sum + (item.instances?.total ?? 0), 0),
      ready: counted.reduce((sum, item) => sum + (item.instances?.ready ?? 0), 0),
      unknown: items.length - counted.length,
      counted: counted.length,
    };
  }, [items]);

  return (
    <ContentLayout
      header={(
        <Header
          variant="h1"
          counter={load.status === 'ready' ? `(${load.data.total})` : undefined}
          description={pt
            ? 'Toda ResourceGraphDefinition do cluster: o contrato que o usuário preenche, os recursos que o kro cria em ordem, e quantas instâncias estão prontas. É o que o kro-ui mostrava, lido direto do cluster.'
            : 'Every ResourceGraphDefinition in the cluster: the contract the user fills, the resources kro creates in order, and how many instances are ready. What kro-ui showed, read straight from the cluster.'}
          actions={(
            <SpaceBetween direction="horizontal" size="xs">
              <Button iconName="refresh" onClick={() => { void fetchAll(); }} loading={load.status === 'loading'}>{pt ? 'Atualizar' : 'Refresh'}</Button>
              <Button variant="primary" onClick={onCreate}>{pt ? 'Pedir uma instância' : 'Request an instance'}</Button>
            </SpaceBetween>
          )}
        >
          {pt ? 'Composições' : 'Compositions'}
        </Header>
      )}
    >
      <SpaceBetween size="l">
        {load.status === 'error' && (
          <LoadFailure message={load.message} status={load.httpStatus} sources={load.sources} pt={pt} onRetry={() => { void fetchAll(); }} />
        )}
        {load.status === 'ready' && (
          <SourceWarning partial={load.data.partial} sources={load.data.sources} pt={pt} />
        )}
        <Container>
          <KeyValuePairs columns={4} items={[
            { label: pt ? 'Definições' : 'Definitions', value: load.status === 'ready' ? String(totals.definitions) : '-' },
            { label: 'Active', value: load.status === 'ready' ? String(totals.active) : '-' },
            {
              label: pt ? 'Instâncias (prontas/total)' : 'Instances (ready/total)',
              value: load.status === 'ready'
                ? `${totals.counted === 0 ? '-' : `${totals.ready}/${totals.instances}`}${totals.unknown > 0 ? (pt ? ` · ${totals.unknown} sem contagem` : ` · ${totals.unknown} uncounted`) : ''}`
                : '-',
            },
            { label: pt ? 'Lido há' : 'Read', value: load.status === 'ready' ? relativeAge(Date.now() / 1000 - load.data.readAt, pt) : '-' },
          ]} />
        </Container>
        <Table<CompositionSummary>
          variant="container"
          header={<Header variant="h2" counter={load.status === 'ready' ? `(${items.length})` : undefined}>{pt ? 'Definições' : 'Definitions'}</Header>}
          items={items}
          trackBy="name"
          loading={load.status === 'loading'}
          loadingText={pt ? 'Lendo as definições do cluster' : 'Reading definitions from the cluster'}
          selectionType="single"
          selectedItems={selected ? [selected] : []}
          onSelectionChange={({ detail }) => setSelectedName(detail.selectedItems[0]?.name ?? null)}
          ariaLabels={{
            tableLabel: pt ? 'Definições de composição' : 'Composition definitions',
            selectionGroupLabel: pt ? 'Seleção de definição' : 'Definition selection',
            itemSelectionLabel: (_, item) => item.name,
          }}
          columnDefinitions={[
            {
              id: 'name', header: pt ? 'Definição' : 'Definition', isRowHeader: true,
              cell: row => <Link href="#compositions" onFollow={event => { event.preventDefault(); setSelectedName(row.name); }}>{row.name}</Link>,
            },
            { id: 'kind', header: 'Kind', cell: row => row.kind },
            {
              id: 'state', header: pt ? 'Estado' : 'State',
              cell: row => { const indicator = definitionIndicator(row.state, pt); return <StatusIndicator type={indicator.type}>{indicator.text}</StatusIndicator>; },
            },
            { id: 'resources', header: pt ? 'Recursos' : 'Resources', cell: row => `${row.graph.nodes.length}${row.graph.cycle.length ? (pt ? ' (ciclo)' : ' (cycle)') : ''}` },
            { id: 'layers', header: pt ? 'Camadas' : 'Layers', cell: row => String(row.graph.layers.length) },
            { id: 'fields', header: pt ? 'Campos' : 'Fields', cell: row => String(row.schema.spec.length) },
            { id: 'instances', header: pt ? 'Instâncias' : 'Instances', cell: row => instancesText(row, pt) },
          ]}
          empty={load.status === 'ready'
            ? <Box textAlign="center" color="text-body-secondary">{pt ? 'Nenhuma ResourceGraphDefinition no cluster.' : 'No ResourceGraphDefinition in the cluster.'}</Box>
            : <Box textAlign="center" color="text-body-secondary">{pt ? 'Sem leitura.' : 'Not read.'}</Box>}
        />
        {selected && <CompositionDetail item={selected} pt={pt} onOpenService={onOpenService} />}
      </SpaceBetween>
    </ContentLayout>
  );
}
