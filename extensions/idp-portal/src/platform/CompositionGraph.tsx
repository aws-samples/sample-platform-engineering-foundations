/*
 * Grafo da composição kro, nativo no portal (o que o kro-ui mostra, sem sair do portal).
 *
 * Duas superfícies do MESMO dado: o SVG, para quem enxerga o desenho, e a tabela, para teclado,
 * leitor de tela e para quem prefere ler. O SVG é `role="img"` com descrição textual completa, e
 * nenhum estado depende só de cor: recurso externo tem borda tracejada e rótulo "ref", nó em ciclo
 * tem borda dupla e rótulo "ciclo", camada aparece como número.
 */
import { useId } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import {
  colorBackgroundContainerContent, colorBorderDividerDefault, colorTextBodyDefault,
  colorTextBodySecondary, colorTextLinkDefault, colorTextStatusError,
} from '@cloudscape-design/design-tokens';
import type { CompositionGraph as Graph } from './kdpInventoryApi';
import { NODE_HEIGHT, NODE_WIDTH, apiGroup, describeComposition, layoutComposition } from './compositionLayout';

export interface CompositionGraphProps {
  graph: Graph;
  pt: boolean;
}

export function CompositionGraph({ graph, pt }: CompositionGraphProps): JSX.Element {
  const layout = layoutComposition(graph);
  const markerId = useId();
  const description = describeComposition(graph, pt);

  if (graph.nodes.length === 0) {
    return <Box color="text-body-secondary">{pt ? 'A definição não declara recursos.' : 'The definition declares no resources.'}</Box>;
  }

  const rows = layout.nodes.map(node => ({ ...node, layerLabel: node.inCycle ? (pt ? 'ciclo' : 'cycle') : String(node.layer + 1) }));

  return (
    <SpaceBetween size="m">
      {graph.cycle.length > 0 && (
        <Alert type="error" statusIconAriaLabel={pt ? 'Erro' : 'Error'}
          header={pt ? 'Dependência circular na definição' : 'Circular dependency in the definition'}>
          {pt
            ? `${graph.cycle.join(', ')}: estes recursos dependem uns dos outros em círculo. O kro não consegue ordená-los; corrija o spec da RGD.`
            : `${graph.cycle.join(', ')}: these resources depend on each other in a loop. kro cannot order them; fix the RGD spec.`}
        </Alert>
      )}
      <KeyValuePairs columns={4} items={[
        { label: pt ? 'Recursos' : 'Resources', value: String(graph.nodes.length) },
        { label: pt ? 'Camadas' : 'Layers', value: String(graph.layers.length) },
        { label: pt ? 'Dependências' : 'Dependencies', value: String(graph.edges.length) },
        { label: pt ? 'Estado da definição' : 'Definition state', value: graph.state },
      ]} />

      <div data-testid="composition-svg" style={{ overflowX: 'auto', border: `1px solid ${colorBorderDividerDefault}`, borderRadius: 8, background: colorBackgroundContainerContent }}>
        <svg role="img" aria-label={description} width={layout.width} height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`} style={{ display: 'block', fontFamily: 'inherit' }}>
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={colorTextBodySecondary} />
            </marker>
          </defs>
          {layout.edges.map(edge => (
            <path key={`${edge.from}->${edge.to}`} d={edge.path} fill="none" stroke={colorTextBodySecondary}
              strokeWidth={1.5} markerEnd={`url(#${markerId})`} data-edge={`${edge.from}->${edge.to}`} />
          ))}
          {layout.nodes.map(node => (
            <g key={node.id} transform={`translate(${node.x} ${node.y})`} data-node={node.id} data-layer={node.layer}>
              <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={6}
                fill={colorBackgroundContainerContent}
                stroke={node.inCycle ? colorTextStatusError : colorTextLinkDefault}
                strokeWidth={node.inCycle ? 3 : 1.5}
                strokeDasharray={node.external ? '6 4' : undefined} />
              <text x={12} y={22} fontSize={14} fontWeight={700} fill={colorTextBodyDefault}>{truncate(node.id, 20)}</text>
              <text x={12} y={42} fontSize={12} fill={colorTextBodySecondary}>{truncate(`${node.kind || '-'} · ${apiGroup(node.apiVersion)}`, 28)}</text>
              {(node.external || node.inCycle) && (
                <text x={NODE_WIDTH - 10} y={16} fontSize={10} textAnchor="end" fontWeight={700}
                  fill={node.inCycle ? colorTextStatusError : colorTextBodySecondary}>
                  {node.inCycle ? (pt ? 'CICLO' : 'CYCLE') : 'REF'}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>

      <Table
        variant="embedded"
        header={<Box variant="h3">{pt ? 'Recursos da composição' : 'Composition resources'}</Box>}
        items={rows}
        trackBy="id"
        ariaLabels={{ tableLabel: pt ? 'Recursos da composição' : 'Composition resources' }}
        columnDefinitions={[
          { id: 'layer', header: pt ? 'Camada' : 'Layer', cell: row => row.inCycle
            ? <Badge color="red">{row.layerLabel}</Badge> : <Badge color="grey">{row.layerLabel}</Badge> },
          { id: 'id', header: 'Id', cell: row => <Box fontWeight="bold">{row.id}</Box> },
          { id: 'kind', header: 'Kind', cell: row => `${row.kind || '-'} · ${apiGroup(row.apiVersion)}` },
          { id: 'deps', header: pt ? 'Depende de' : 'Depends on', cell: row => row.dependsOn.join(', ') || (pt ? 'nada' : 'none') },
          { id: 'flags', header: pt ? 'Marcas' : 'Flags', cell: row => (
            <SpaceBetween direction="horizontal" size="xxs">
              {row.external && <Badge color="grey">{pt ? 'referência externa' : 'external ref'}</Badge>}
              {row.usesSchema && <Badge color="blue">{pt ? 'lê o pedido' : 'reads request'}</Badge>}
              {row.readyWhen > 0 && <Badge color="green">{`readyWhen ${row.readyWhen}`}</Badge>}
              {row.includeWhen > 0 && <Badge color="grey">{`includeWhen ${row.includeWhen}`}</Badge>}
            </SpaceBetween>
          ) },
        ]}
      />

      {graph.outputs.length > 0 && (
        <Box>
          <Box variant="h3">{pt ? 'Outputs e de onde vêm' : 'Outputs and their sources'}</Box>
          <Box color="text-body-secondary" fontSize="body-s">
            {graph.outputs.map(output => `${output.name} ← ${output.from.join(', ') || (pt ? 'constante' : 'constant')}`).join(' · ')}
          </Box>
        </Box>
      )}
    </SpaceBetween>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
