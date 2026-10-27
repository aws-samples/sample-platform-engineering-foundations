/*
 * Layout determinístico do grafo da composição kro.
 *
 * O servidor já entrega as camadas topológicas (`layers`); aqui só se atribui geometria. Nada é
 * aleatório e nada depende do browser, então o mesmo grafo produz sempre o mesmo desenho e o
 * teste compara coordenadas exatas. Nós em ciclo ganham uma coluna própria no fim, com marca
 * explícita: um ciclo no spec é um defeito do RGD, e sumir com o nó esconderia o defeito.
 */
import type { CompositionGraph, CompositionNode } from './kdpInventoryApi';

export const NODE_WIDTH = 188;
export const NODE_HEIGHT = 58;
export const COLUMN_GAP = 72;
export const ROW_GAP = 22;
export const PADDING = 16;

export interface PlacedNode extends CompositionNode {
  x: number;
  y: number;
  layer: number;
  inCycle: boolean;
}

export interface PlacedEdge {
  from: string;
  to: string;
  /** Path SVG, cúbico, da borda direita da origem até a borda esquerda do destino. */
  path: string;
}

export interface CompositionLayout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  columns: number;
}

export function layoutComposition(graph: CompositionGraph): CompositionLayout {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const columns: { ids: string[]; cycle: boolean }[] = graph.layers.map(ids => ({ ids, cycle: false }));
  if (graph.cycle.length > 0) columns.push({ ids: graph.cycle, cycle: true });

  const nodes: PlacedNode[] = [];
  const position = new Map<string, { x: number; y: number }>();
  columns.forEach((column, layer) => {
    column.ids.forEach((id, row) => {
      const node = byId.get(id);
      if (!node) return;
      const x = PADDING + layer * (NODE_WIDTH + COLUMN_GAP);
      const y = PADDING + row * (NODE_HEIGHT + ROW_GAP);
      position.set(id, { x, y });
      nodes.push({ ...node, x, y, layer, inCycle: column.cycle });
    });
  });

  const edges: PlacedEdge[] = graph.edges
    .filter(edge => position.has(edge.from) && position.has(edge.to))
    .map(edge => {
      const a = position.get(edge.from)!;
      const b = position.get(edge.to)!;
      const x1 = a.x + NODE_WIDTH;
      const y1 = a.y + NODE_HEIGHT / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_HEIGHT / 2;
      // Aresta que volta (ciclo) sai pela direita e entra pela direita, para não cruzar o nó.
      const forward = x2 >= x1;
      const bend = forward ? Math.max(24, (x2 - x1) / 2) : COLUMN_GAP;
      const path = forward
        ? `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
        : `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 + NODE_WIDTH + bend} ${y2}, ${x2 + NODE_WIDTH} ${y2}`;
      return { from: edge.from, to: edge.to, path };
    });

  const rows = Math.max(1, ...columns.map(column => column.ids.length));
  return {
    columns: columns.length,
    width: PADDING * 2 + Math.max(1, columns.length) * NODE_WIDTH + Math.max(0, columns.length - 1) * COLUMN_GAP,
    height: PADDING * 2 + rows * NODE_HEIGHT + (rows - 1) * ROW_GAP,
    nodes,
    edges,
  };
}

/** Texto curto de um apiVersion: `s3.services.k8s.aws/v1alpha1` -> `s3.services.k8s.aws`. */
export function apiGroup(apiVersion: string): string {
  const group = apiVersion.split('/')[0];
  return group && group !== apiVersion ? group : apiVersion || '-';
}

/** Resumo para leitor de tela e para o teste: uma frase por nó, na ordem das camadas. */
export function describeComposition(graph: CompositionGraph, pt: boolean): string {
  const order = [...graph.layers.flat(), ...graph.cycle];
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const parts = order.map(id => {
    const node = byId.get(id);
    if (!node) return id;
    const deps = node.dependsOn.length === 0
      ? (pt ? 'sem dependências' : 'no dependencies')
      : (pt ? `depende de ${node.dependsOn.join(', ')}` : `depends on ${node.dependsOn.join(', ')}`);
    return `${id} (${node.kind || '-'}) ${deps}`;
  });
  const head = pt
    ? `${graph.nodes.length} recursos em ${graph.layers.length} camadas`
    : `${graph.nodes.length} resources in ${graph.layers.length} layers`;
  const cycle = graph.cycle.length > 0
    ? (pt ? `; ciclo em ${graph.cycle.join(', ')}` : `; cycle in ${graph.cycle.join(', ')}`)
    : '';
  return `${head}${cycle}. ${parts.join('. ')}.`;
}
