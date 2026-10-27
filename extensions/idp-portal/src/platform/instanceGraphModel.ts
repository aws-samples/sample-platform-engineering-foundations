/**
 * cross-instance-graph: o grafo entre instâncias desenhado pelo MESMO motor do grafo da composição.
 *
 * `toCompositionGraph` adapta a resposta de GET /cluster/instance-graph ao tipo que `CompositionGraph`
 * já renderiza (SVG + tabela acessível, camadas determinísticas, REF para nó externo, CICLO para o que
 * não coube em camada). Um renderer só, duas fontes de grafo. O id do nó vira o NOME da instância
 * (o SVG mostra o id); kind e namespace ficam na linha secundária via `apiVersion` reaproveitado como
 * texto, porque o renderer imprime `kind · grupo(apiVersion)`.
 */
import type { CompositionGraph, InstanceGraphEdge, InstanceGraphNode, InstanceGraphResponse, InstanceRelation } from './kdpInventoryApi';

export function nodeLabel(node: Pick<InstanceGraphNode, 'name' | 'namespace' | 'external'>): string {
  return node.external ? `${node.namespace}/${node.name}` : node.name;
}

export function toCompositionGraph(graph: Pick<InstanceGraphResponse, 'nodes' | 'edges' | 'layers' | 'cycle'>, title: string): CompositionGraph {
  const label = new Map(graph.nodes.map((node) => [node.id, nodeLabel(node)] as const));
  const named = (id: string) => label.get(id) ?? id;
  return {
    name: title,
    kind: 'InstanceGraph',
    state: graph.cycle.length ? 'Cycle' : 'Active',
    nodes: graph.nodes.map((node) => ({
      id: named(node.id),
      kind: node.kind || (node.external ? 'outside scope' : '-'),
      // O renderer imprime o grupo da apiVersion: aqui vai o namespace, que é o que distingue a cópia promovida.
      apiVersion: `${node.namespace}/v0`,
      external: node.external,
      dependsOn: node.dependsOn.map(named),
      usesSchema: false,
      readyWhen: 0,
      includeWhen: 0,
    })),
    edges: graph.edges.map((edge) => ({ from: named(edge.from), to: named(edge.to) })),
    layers: graph.layers.map((layer) => layer.map(named)),
    cycle: graph.cycle.map(named),
    outputs: [],
    controllerOrder: [],
  };
}

export function relationLabel(relation: InstanceRelation, pt: boolean): string {
  switch (relation) {
    case 'consumes': return pt ? 'consome' : 'consumes';
    case 'declared': return pt ? 'declarada (label)' : 'declared (label)';
    case 'promoted-from': return pt ? 'promovida de' : 'promoted from';
    default: return relation;
  }
}

/** Arestas que tocam uma instância: o que ela consome (dependsOn) e quem a consome (dependents). */
export function edgesAround(graph: Pick<InstanceGraphResponse, 'edges' | 'nodes'>, id: string): { dependsOn: InstanceGraphEdge[]; dependents: InstanceGraphEdge[] } {
  return {
    dependsOn: graph.edges.filter((edge) => edge.to === id),
    dependents: graph.edges.filter((edge) => edge.from === id),
  };
}

export function instanceNodeId(kind: string, namespace: string, name: string): string {
  return `${kind}/${namespace}/${name}`;
}
