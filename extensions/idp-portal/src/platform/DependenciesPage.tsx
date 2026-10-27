/*
 * Página Dependências (backlog cross-instance-graph): quem consome output de quem, entre instâncias
 * vivas do escopo. O grafo da composição cobre UMA definição; este cruza instâncias.
 *
 * Nada é inferido no cliente: GET /cluster/instance-graph deriva cada aresta de evidência observável
 * (valor do spec igual a output publicado ou ao nome de outra instância; label
 * `platform.appmod/depends-on`; annotation `platform.appmod/promoted-from`) e devolve o caminho
 * exato em `evidence`. Fonte que falhou aparece nomeada; grafo vazio diz que leu e não achou aresta.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { CompositionGraph } from './CompositionGraph';
import { errorMessage } from './errors';
import { useI18n } from './i18n';
import { nodeLabel, relationLabel, toCompositionGraph } from './instanceGraphModel';
import { ALL_NAMESPACES, InstanceGraphEdge, InstanceGraphNode, InstanceGraphResponse, InventoryError, getInstanceGraph } from './kdpInventoryApi';
import { detailPath } from './kdpInventoryModel';
import { LoadFailure, SourceWarning } from './KdpInventoryParts';

export interface DependenciesPageProps {
  onOpenDetail(path: string): void;
}

type Load =
  | { status: 'loading' }
  | { status: 'ready'; data: InstanceGraphResponse }
  | { status: 'error'; message: string; httpStatus?: number; sources?: InstanceGraphResponse['sources'] };

const REFRESH_MS = 60_000;

function Kpi({ label, value }: { label: string; value: string | number }): JSX.Element {
  return <div><Box variant="awsui-key-label">{label}</Box><Box fontSize="display-l" fontWeight="bold">{value}</Box></div>;
}

export function DependenciesPage({ onOpenDetail }: DependenciesPageProps): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const gate = useRef(new AbortController());

  useEffect(() => {
    gate.current.abort();
    const controller = new AbortController();
    gate.current = controller;
    let active = true;
    const read = async () => {
      try {
        const data = await getInstanceGraph(ALL_NAMESPACES, controller.signal);
        if (!active) return;
        setLoad({ status: 'ready', data });
      } catch (cause) {
        if (!active || (cause instanceof InventoryError && cause.aborted)) return;
        setLoad({ status: 'error', message: errorMessage(cause, 'cluster-api unavailable'),
          httpStatus: cause instanceof InventoryError ? cause.status : undefined,
          sources: cause instanceof InventoryError ? cause.sources : undefined });
      }
    };
    void read();
    const interval = window.setInterval(() => void read(), REFRESH_MS);
    return () => { active = false; controller.abort(); window.clearInterval(interval); };
  }, [nonce]);

  const retry = useCallback(() => { setLoad({ status: 'loading' }); setNonce(value => value + 1); }, []);

  const header = (
    <Header
      variant="h1"
      counter={load.status === 'ready' ? `(${load.data.nodes.length})` : undefined}
      description={pt
        ? 'Quem consome o que, entre as instâncias do escopo. Cada aresta vem de evidência observável no cluster (valor do spec igual a um output publicado ou ao nome de outra instância, label platform.appmod/depends-on, annotation platform.appmod/promoted-from) e a tabela diz exatamente qual. O portal não inventa dependência.'
        : 'Who consumes what, across the instances in scope. Every edge comes from observable evidence in the cluster (a spec value equal to a published output or to another instance name, the platform.appmod/depends-on label, the platform.appmod/promoted-from annotation) and the table states exactly which. The portal never invents a dependency.'}
      actions={<Button iconName="refresh" onClick={retry}>{pt ? 'Ler de novo' : 'Read again'}</Button>}
    >
      {pt ? 'Dependências' : 'Dependencies'}
    </Header>
  );

  if (load.status === 'loading') {
    return <ContentLayout header={header}><StatusIndicator type="loading">{pt ? 'Cruzando as instâncias do escopo' : 'Crossing the instances in scope'}</StatusIndicator></ContentLayout>;
  }
  if (load.status === 'error') {
    return <ContentLayout header={header}><LoadFailure message={load.message} status={load.httpStatus} sources={load.sources} pt={pt} onRetry={retry} /></ContentLayout>;
  }

  const { data } = load;
  const byId = new Map(data.nodes.map((node) => [node.id, node] as const));
  const openNode = (node: InstanceGraphNode | undefined) => {
    if (node && !node.external) onOpenDetail(detailPath({ capability: node.capability, namespace: node.namespace, name: node.name, kind: node.kind }));
  };
  const nodeLink = (id: string) => {
    const node = byId.get(id);
    if (!node || node.external) return <span>{node ? nodeLabel(node) : id}{node?.external && <> <Badge color="grey">{pt ? 'fora do escopo' : 'outside scope'}</Badge></>}</span>;
    return <Link onFollow={(event) => { event.preventDefault(); openNode(node); }} href="#">{nodeLabel(node)}</Link>;
  };

  return (
    <ContentLayout header={header}>
      <SpaceBetween size="l">
        <SourceWarning partial={data.partial} sources={data.sources} pt={pt} />
        <Container>
          <ColumnLayout columns={4} variant="text-grid">
            <Kpi label={pt ? 'Instâncias' : 'Instances'} value={data.nodes.filter((node) => !node.external).length} />
            <Kpi label={pt ? 'Consome output ou nome' : 'Consumes output or name'} value={data.relations.consumes} />
            <Kpi label={pt ? 'Declaradas (label)' : 'Declared (label)'} value={data.relations.declared} />
            <Kpi label={pt ? 'Promovidas de' : 'Promoted from'} value={data.relations['promoted-from']} />
          </ColumnLayout>
        </Container>
        <Container header={<Header variant="h2" description={pt ? 'Camadas: uma instância só aparece depois de tudo o que consome. Nó tracejado com REF está fora do escopo.' : 'Layers: an instance only appears after everything it consumes. A dashed node with REF is outside the scope.'}>{pt ? 'Grafo' : 'Graph'}</Header>}>
          {data.edges.length === 0 && data.nodes.length > 0 && (
            <Box color="text-body-secondary" margin={{ bottom: 's' }} data-testid="no-edges">
              {pt
                ? `${data.nodes.length} instâncias lidas e nenhuma aresta encontrada: nenhum spec referencia output ou nome de outra instância, e não há label depends-on nem promoção.`
                : `${data.nodes.length} instances read and no edge found: no spec references another instance's output or name, and there is no depends-on label nor promotion.`}
            </Box>
          )}
          <CompositionGraph graph={toCompositionGraph(data, pt ? 'Dependências' : 'Dependencies')} pt={pt} />
        </Container>
        <Table<InstanceGraphEdge>
          header={<Header variant="h2" counter={`(${data.edges.length})`}>{pt ? 'Arestas e evidência' : 'Edges and evidence'}</Header>}
          items={data.edges}
          trackBy={(edge) => `${edge.from}>${edge.to}:${edge.relation}`}
          variant="container"
          empty={<Box textAlign="center" color="text-body-secondary">{pt ? 'Nenhuma aresta no escopo.' : 'No edge in scope.'}</Box>}
          columnDefinitions={[
            { id: 'to', header: pt ? 'Instância' : 'Instance', cell: (edge) => nodeLink(edge.to) },
            { id: 'relation', header: pt ? 'Relação' : 'Relation', cell: (edge) => <Badge color={edge.relation === 'promoted-from' ? 'blue' : 'grey'}>{relationLabel(edge.relation, pt)}</Badge> },
            { id: 'from', header: pt ? 'Depende de' : 'Depends on', cell: (edge) => nodeLink(edge.from) },
            { id: 'evidence', header: pt ? 'Evidência' : 'Evidence', cell: (edge) => <code>{edge.evidence}</code> },
          ]}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
