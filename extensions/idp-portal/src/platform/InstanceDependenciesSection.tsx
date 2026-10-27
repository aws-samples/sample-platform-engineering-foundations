/**
 * Seção "Dependências" do detalhe da instância (cross-instance-graph): o que esta instância consome e
 * quem a consome, lidos do mesmo GET /cluster/instance-graph da página Dependências, filtrados aqui.
 * Falha de leitura é dita; vazio é "nenhuma aresta", nunca silêncio.
 */
import { useEffect, useState } from 'react';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { errorMessage } from './errors';
import { edgesAround, instanceNodeId, nodeLabel, relationLabel } from './instanceGraphModel';
import { InstanceGraphEdge, InstanceGraphResponse, InventoryError, getInstanceGraph } from './kdpInventoryApi';
import { detailPath } from './kdpInventoryModel';

type Load = { status: 'loading' } | { status: 'ready'; data: InstanceGraphResponse } | { status: 'error'; message: string };

export function InstanceDependenciesSection({ kind, namespace, name, pt, onOpenDetail }: {
  kind: string; namespace: string; name: string; pt: boolean; onOpenDetail(path: string): void;
}): JSX.Element {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    getInstanceGraph(namespace, controller.signal)
      .then((data) => { if (active) setLoad({ status: 'ready', data }); })
      .catch((cause) => {
        if (!active || (cause instanceof InventoryError && cause.aborted)) return;
        setLoad({ status: 'error', message: errorMessage(cause, 'cluster-api unavailable') });
      });
    return () => { active = false; controller.abort(); };
  }, [kind, namespace, name]);

  const header = <Header variant="h2" description={pt ? 'Arestas derivadas de evidência no cluster; a página Dependências mostra o grafo inteiro do escopo.' : 'Edges derived from evidence in the cluster; the Dependencies page shows the whole graph of the scope.'}>{pt ? 'Dependências' : 'Dependencies'}</Header>;
  if (load.status === 'loading') return <Container header={header}><StatusIndicator type="loading">{pt ? 'Cruzando instâncias' : 'Crossing instances'}</StatusIndicator></Container>;
  if (load.status === 'error') return <Container header={header}><StatusIndicator type="error">{pt ? `Grafo não lido: ${load.message}` : `Graph not read: ${load.message}`}</StatusIndicator></Container>;

  const id = instanceNodeId(kind, namespace, name);
  const { dependsOn, dependents } = edgesAround(load.data, id);
  const byId = new Map(load.data.nodes.map((node) => [node.id, node] as const));
  const render = (edge: InstanceGraphEdge, other: string) => {
    const node = byId.get(other);
    const label = node ? nodeLabel(node) : other;
    return (
      <li key={`${edge.from}>${edge.to}:${edge.relation}`}>
        <SpaceBetween direction="horizontal" size="xs">
          {node && !node.external
            ? <Link href="#" onFollow={(event) => { event.preventDefault(); onOpenDetail(detailPath({ capability: node.capability, namespace: node.namespace, name: node.name, kind: node.kind })); }}>{label}</Link>
            : <span>{label} {node?.external && <Badge color="grey">{pt ? 'fora do escopo' : 'outside scope'}</Badge>}</span>}
          <Badge color={edge.relation === 'promoted-from' ? 'blue' : 'grey'}>{relationLabel(edge.relation, pt)}</Badge>
          <code>{edge.evidence}</code>
        </SpaceBetween>
      </li>
    );
  };
  return (
    <Container header={header}>
      <SpaceBetween size="s">
        <div>
          <Box variant="awsui-key-label">{pt ? 'Consome' : 'Consumes'}</Box>
          {dependsOn.length ? <ul>{dependsOn.map((edge) => render(edge, edge.from))}</ul> : <Box color="text-body-secondary">{pt ? 'Nenhuma aresta: o spec não referencia output nem nome de outra instância.' : 'No edge: the spec references no other instance output or name.'}</Box>}
        </div>
        <div>
          <Box variant="awsui-key-label">{pt ? 'Consumida por' : 'Consumed by'}</Box>
          {dependents.length ? <ul>{dependents.map((edge) => render(edge, edge.to))}</ul> : <Box color="text-body-secondary">{pt ? 'Nenhuma instância do escopo consome esta.' : 'No instance in scope consumes this one.'}</Box>}
        </div>
      </SpaceBetween>
    </Container>
  );
}
