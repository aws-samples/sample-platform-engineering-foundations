/**
 * Peças de composition-revisions, usadas pela página Composições (por definição) e pelo detalhe da
 * instância (por objeto): tabela de GraphRevisions, indicador de rollout e tabela de filhos.
 *
 * Modelo (kro v0.9.4, medido em 26/10/2026): a instância não fixa revisão; o controller reconcilia
 * contra a GraphRevision ativa mais recente. A única evidência de "atrás" seria o filho levar
 * `kro.run/graph-revision-hash`, e a v0.9.4 só aplica essa label no próprio GraphRevision, não nos
 * filhos: hoje todo rollout sai "não medido", e a comparação passa a valer quando o kro carimbar o
 * hash nos filhos. Por isso o indicador nunca pinta de erro o que não foi medido.
 */
import Box from '@cloudscape-design/components/box';
import Link from '@cloudscape-design/components/link';
import StatusIndicator, { StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import type { ChildResource, CompositionRevision, CompositionRevisions, InstanceRollout, RolloutStatus, RolloutSummary } from './kdpInventoryApi';
import { readyIndicator, relativeAge } from './kdpInventoryModel';

export function rolloutIndicator(status: RolloutStatus, pt: boolean): { type: StatusIndicatorProps.Type; text: string } {
  switch (status) {
    case 'current': return { type: 'success', text: pt ? 'Na revisão atual' : 'On current revision' };
    case 'behind': return { type: 'warning', text: pt ? 'Atrás da definição' : 'Behind the definition' };
    case 'no-children': return { type: 'stopped', text: pt ? 'Sem recursos filhos' : 'No child resources' };
    default: return { type: 'pending', text: pt ? 'Revisão não medida' : 'Revision not measured' };
  }
}

/** Resumo em uma linha: "2 de 3 filhos na revisão 4; 1 sem hash". */
export function rolloutText(summary: RolloutSummary, pt: boolean): string {
  if (summary.children === 0) return pt ? 'nenhum filho listado' : 'no children listed';
  const parts = [pt
    ? `${summary.onLatest} de ${summary.children} filho(s) na revisão ${summary.latestRevision ?? '?'}`
    : `${summary.onLatest} of ${summary.children} child(ren) on revision ${summary.latestRevision ?? '?'}`];
  const unknown = summary.children - summary.withHash;
  if (unknown > 0) parts.push(pt ? `${unknown} sem hash de revisão` : `${unknown} without a revision hash`);
  return parts.join('; ');
}

export function RolloutBadge({ summary, pt }: { summary: RolloutSummary; pt: boolean }): JSX.Element {
  const indicator = rolloutIndicator(summary.status, pt);
  return <StatusIndicator type={indicator.type}>{indicator.text}</StatusIndicator>;
}

export function RevisionsTable({ revisions, pt }: { revisions: CompositionRevisions; pt: boolean }): JSX.Element {
  if (revisions.error) {
    return <Box color="text-status-error">{pt ? `Revisões não lidas (${revisions.error}).` : `Revisions not read (${revisions.error}).`}</Box>;
  }
  if (revisions.items.length === 0) {
    return <Box color="text-body-secondary">{pt
      ? 'Nenhuma GraphRevision para esta definição (kro anterior a 0.9 ou definição ainda não compilada).'
      : 'No GraphRevision for this definition (kro before 0.9 or definition not compiled yet).'}</Box>;
  }
  const latest = revisions.latest?.revision ?? null;
  return (
    <Table<CompositionRevision>
      variant="borderless"
      items={revisions.items}
      trackBy={row => String(row.revision)}
      columnDefinitions={[
        {
          id: 'revision', header: pt ? 'Revisão' : 'Revision', isRowHeader: true,
          cell: row => <span>{row.revision ?? '-'}{row.revision !== null && row.revision === latest ? <Box variant="span" color="text-status-success"> {pt ? '(ativa)' : '(active)'}</Box> : null}</span>,
        },
        { id: 'generation', header: pt ? 'Geração da definição' : 'Definition generation', cell: row => row.generation ?? '-' },
        {
          id: 'ready', header: pt ? 'Compilada' : 'Compiled',
          cell: row => <StatusIndicator type={row.ready ? 'success' : 'pending'}>{row.ready ? (pt ? 'pronta' : 'ready') : (pt ? 'pendente' : 'pending')}</StatusIndicator>,
        },
        { id: 'resources', header: pt ? 'Recursos' : 'Resources', cell: row => row.resources },
        { id: 'created', header: pt ? 'Criada há' : 'Created', cell: row => relativeAge(row.created ? (Date.now() - Date.parse(row.created)) / 1000 : null, pt) },
        { id: 'hash', header: 'Hash', cell: row => (row.hash ? <code>{row.hash.slice(0, 12)}</code> : '-') },
      ]}
    />
  );
}

export function RolloutTable({ rollout, pt, onOpenInstance }: {
  rollout: InstanceRollout[]; pt: boolean; onOpenInstance?(row: InstanceRollout): void;
}): JSX.Element {
  if (rollout.length === 0) return <Box color="text-body-secondary">{pt ? 'Nenhuma instância listada.' : 'No instance listed.'}</Box>;
  return (
    <Table<InstanceRollout>
      variant="borderless"
      items={rollout}
      trackBy={row => `${row.namespace}/${row.name}`}
      columnDefinitions={[
        {
          id: 'name', header: pt ? 'Instância' : 'Instance', isRowHeader: true,
          cell: row => (onOpenInstance ? <Link onFollow={event => { event.preventDefault(); onOpenInstance(row); }} href="#">{row.name}</Link> : row.name),
        },
        { id: 'namespace', header: 'Namespace', cell: row => row.namespace },
        { id: 'status', header: pt ? 'Rollout' : 'Rollout', cell: row => <RolloutBadge summary={row.rollout} pt={pt} /> },
        { id: 'detail', header: pt ? 'Filhos' : 'Children', cell: row => rolloutText(row.rollout, pt) },
      ]}
    />
  );
}

export function ChildrenTable({ children, pt }: { children: ChildResource[]; pt: boolean }): JSX.Element {
  if (children.length === 0) return <Box color="text-body-secondary">{pt ? 'Nenhum recurso filho listado para esta instância.' : 'No child resource listed for this instance.'}</Box>;
  return (
    <Table<ChildResource>
      variant="borderless"
      items={children}
      trackBy={row => `${row.apiVersion}/${row.kind}/${row.namespace}/${row.name}`}
      columnDefinitions={[
        { id: 'node', header: pt ? 'Nó do grafo' : 'Graph node', isRowHeader: true, cell: row => <code>{row.node ?? '-'}</code> },
        { id: 'kind', header: 'Kind', cell: row => row.kind },
        { id: 'name', header: pt ? 'Nome' : 'Name', cell: row => row.name },
        {
          id: 'ready', header: 'Ready',
          cell: row => { const indicator = readyIndicator(row, pt); return <StatusIndicator type={indicator.type}>{indicator.text}</StatusIndicator>; },
        },
        {
          id: 'policy', header: pt ? 'Política de deleção' : 'Deletion policy',
          cell: row => (row.deletionPolicy ? <code>{row.deletionPolicy}</code> : <Box color="text-body-secondary">{pt ? 'não declarada' : 'not declared'}</Box>),
        },
        {
          id: 'revision', header: pt ? 'Revisão' : 'Revision',
          cell: row => (row.onLatest === null
            ? <StatusIndicator type="pending">{pt ? 'sem hash' : 'no hash'}</StatusIndicator>
            : <StatusIndicator type={row.onLatest ? 'success' : 'warning'}>{row.onLatest ? (pt ? 'atual' : 'current') : (pt ? 'antiga' : 'old')}</StatusIndicator>),
        },
      ]}
    />
  );
}
