/*
 * Grafo da composição kro, nativo no portal.
 *
 * Duas coisas são provadas aqui: o layout é determinístico (coordenadas exatas a partir das
 * camadas do servidor), e o render carrega as DUAS superfícies do mesmo dado: o SVG com descrição
 * textual completa e a tabela com camada, dependências e marcas. Um ciclo aparece como erro e como
 * coluna própria, nunca como nó que sumiu.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CompositionGraph as Graph } from './kdpInventoryApi';
import { COLUMN_GAP, NODE_HEIGHT, NODE_WIDTH, PADDING, ROW_GAP, apiGroup, describeComposition, layoutComposition } from './compositionLayout';
import { CompositionGraph } from './CompositionGraph';

const originalError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return;
    originalError(...args);
  });
});
afterAll(() => vi.restoreAllMocks());

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const graph = (patch: Partial<Graph> = {}): Graph => ({
  name: 'static-web-app', kind: 'StaticWebApp', state: 'Active',
  nodes: [
    { id: 'distribution', kind: 'Distribution', apiVersion: 'cloudfront.services.k8s.aws/v1alpha1', external: false, dependsOn: ['bucket', 'oac'], usesSchema: false, readyWhen: 1, includeWhen: 0 },
    { id: 'bucket', kind: 'Bucket', apiVersion: 's3.services.k8s.aws/v1alpha1', external: false, dependsOn: [], usesSchema: true, readyWhen: 0, includeWhen: 0 },
    { id: 'oac', kind: 'OriginAccessControl', apiVersion: 'cloudfront.services.k8s.aws/v1alpha1', external: false, dependsOn: [], usesSchema: true, readyWhen: 0, includeWhen: 1 },
    { id: 'bucketPolicy', kind: 'BucketPolicy', apiVersion: 's3.services.k8s.aws/v1alpha1', external: false, dependsOn: ['bucket', 'distribution'], usesSchema: false, readyWhen: 0, includeWhen: 0 },
  ],
  edges: [
    { from: 'bucket', to: 'distribution' }, { from: 'oac', to: 'distribution' },
    { from: 'bucket', to: 'bucketPolicy' }, { from: 'distribution', to: 'bucketPolicy' },
  ],
  layers: [['bucket', 'oac'], ['distribution'], ['bucketPolicy']],
  cycle: [],
  outputs: [{ name: 'bucketName', from: ['bucket'] }, { name: 'url', from: ['distribution'] }],
  controllerOrder: [],
  ...patch,
});

describe('layoutComposition', () => {
  it('coloca cada camada numa coluna e cada nó numa linha, com coordenadas exatas', () => {
    const layout = layoutComposition(graph());
    const at = (id: string) => layout.nodes.find(node => node.id === id)!;
    expect(at('bucket')).toMatchObject({ x: PADDING, y: PADDING, layer: 0, inCycle: false });
    expect(at('oac')).toMatchObject({ x: PADDING, y: PADDING + NODE_HEIGHT + ROW_GAP, layer: 0 });
    expect(at('distribution')).toMatchObject({ x: PADDING + NODE_WIDTH + COLUMN_GAP, y: PADDING, layer: 1 });
    expect(at('bucketPolicy')).toMatchObject({ x: PADDING + 2 * (NODE_WIDTH + COLUMN_GAP), layer: 2 });
    expect(layout.columns).toBe(3);
    expect(layout.width).toBe(PADDING * 2 + 3 * NODE_WIDTH + 2 * COLUMN_GAP);
    expect(layout.height).toBe(PADDING * 2 + 2 * NODE_HEIGHT + ROW_GAP);
    // Determinismo: a ordem dos nós no payload não muda nada.
    const reversed = layoutComposition(graph({ nodes: [...graph().nodes].reverse() }));
    expect(reversed.nodes.map(n => [n.id, n.x, n.y])).toEqual(expect.arrayContaining(layout.nodes.map(n => [n.id, n.x, n.y])));
  });

  it('desenha a aresta da borda direita da origem até a borda esquerda do destino', () => {
    const layout = layoutComposition(graph());
    const edge = layout.edges.find(e => e.from === 'bucket' && e.to === 'distribution')!;
    expect(edge.path.startsWith(`M ${PADDING + NODE_WIDTH} ${PADDING + NODE_HEIGHT / 2} C`)).toBe(true);
    expect(edge.path.endsWith(` ${PADDING + NODE_WIDTH + COLUMN_GAP} ${PADDING + NODE_HEIGHT / 2}`)).toBe(true);
    expect(layout.edges).toHaveLength(4);
  });

  it('dá ao ciclo uma coluna própria e ignora aresta para nó desconhecido', () => {
    const layout = layoutComposition(graph({
      layers: [['bucket', 'oac']], cycle: ['bucketPolicy', 'distribution'],
      edges: [...graph().edges, { from: 'ghost', to: 'bucket' }],
    }));
    const cycleNodes = layout.nodes.filter(node => node.inCycle).map(node => node.id);
    expect(cycleNodes).toEqual(['bucketPolicy', 'distribution']);
    expect(layout.columns).toBe(2);
    expect(layout.edges.some(e => e.from === 'ghost')).toBe(false);
  });

  it('descreve o grafo em uma frase por nó, na ordem das camadas', () => {
    const described = describeComposition(graph(), true);
    expect(described.startsWith('4 recursos em 3 camadas. bucket (Bucket) sem dependências. oac (OriginAccessControl) sem dependências. distribution (Distribution) depende de bucket, oac.')).toBe(true);
    expect(describeComposition(graph({ layers: [['bucket', 'oac']], cycle: ['bucketPolicy', 'distribution'] }), false)).toContain('; cycle in bucketPolicy, distribution.');
    expect(apiGroup('s3.services.k8s.aws/v1alpha1')).toBe('s3.services.k8s.aws');
    expect(apiGroup('v1')).toBe('v1');
    expect(apiGroup('')).toBe('-');
  });
});

describe('CompositionGraph', () => {
  it('renderiza o SVG descrito, um nó por recurso e a tabela com camada e dependências', () => {
    const html = renderToStaticMarkup(<CompositionGraph graph={graph()} pt />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="4 recursos em 3 camadas.');
    for (const id of ['bucket', 'oac', 'distribution', 'bucketPolicy']) expect(html).toContain(`data-node="${id}"`);
    expect((html.match(/data-edge=/g) ?? []).length).toBe(4);
    const body = text(html);
    expect(body).toContain('Recursos da composição');
    expect(body).toContain('bucket, oac');
    expect(body).toContain('lê o pedido');
    expect(body).toContain('readyWhen 1');
    expect(body).toContain('includeWhen 1');
    expect(body).toContain('bucketName ← bucket');
    expect(html).not.toContain('Dependência circular');
  });

  it('marca referência externa sem depender só de cor e mostra o ciclo como erro', () => {
    const external = graph({
      nodes: graph().nodes.map(node => node.id === 'bucket' ? { ...node, external: true } : node),
      layers: [['bucket', 'oac']], cycle: ['bucketPolicy', 'distribution'],
    });
    const html = renderToStaticMarkup(<CompositionGraph graph={external} pt={false} />);
    expect(html).toContain('stroke-dasharray="6 4"');
    expect(html).toContain('>REF<');
    expect(html).toContain('>CYCLE<');
    expect(text(html)).toContain('Circular dependency in the definition');
    expect(text(html)).toContain('external ref');
  });

  it('diz quando a definição não declara recursos', () => {
    expect(text(renderToStaticMarkup(<CompositionGraph graph={graph({ nodes: [], edges: [], layers: [], outputs: [] })} pt />)))
      .toContain('A definição não declara recursos.');
  });
});
