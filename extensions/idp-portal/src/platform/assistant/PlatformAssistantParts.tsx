// Peças de apresentação do Platform Assistant. Sem rede e sem estado global: recebem dados e
// callbacks, então cada uma renderiza e é testada isolada contra as fixtures do backend.
// Estado nunca depende só de cor: StatusIndicator traz ícone e texto, e "default" é um rótulo.
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import {
  actorLabel, canRetry, CompensationPreview, confirmable, displayValue, isReference, PlanIssue, PlanPreview, PlanRun,
  PreviewStep, runStatus, safeMrUrl, stepStatus, timelineRows,
} from './assistantModel';
import { openMrNowUrl } from '../platformApi';

function IssueList({ issues, kind, pt }: { issues: PlanIssue[]; kind: 'error' | 'warning'; pt: boolean }): JSX.Element | null {
  if (!issues.length) return null;
  const title = kind === 'error' ? (pt ? `Bloqueado antes de qualquer MR: ${issues.length} erro(s)` : `Blocked before any MR: ${issues.length} error(s)`)
    : (pt ? `${issues.length} aviso(s)` : `${issues.length} warning(s)`);
  return (
    <Alert type={kind} header={title}>
      <ul aria-label={kind === 'error' ? (pt ? 'Erros' : 'Errors') : (pt ? 'Avisos' : 'Warnings')}>
        {issues.map((issue) => <li key={`${issue.path}-${issue.code}`}>{issue.message} <code>{issue.code}</code> {pt ? 'em' : 'at'} <code>{issue.path}</code></li>)}
      </ul>
    </Alert>
  );
}

export function PlanIssues({ preview, pt }: { preview: PlanPreview; pt: boolean }): JSX.Element {
  return (
    <SpaceBetween size="s">
      <IssueList issues={preview.errors} kind="error" pt={pt} />
      <IssueList issues={preview.warnings} kind="warning" pt={pt} />
    </SpaceBetween>
  );
}

export function ExecutorFacts({ preview, pt }: { preview: PlanPreview; pt: boolean }): JSX.Element {
  return (
    <KeyValuePairs columns={2} items={[
      { label: pt ? 'Pedido por' : 'Requested by', value: actorLabel(preview.executor.requestedBy) },
      { label: pt ? 'Executado por' : 'Executed by', value: actorLabel(preview.executor.executedBy) },
      { label: pt ? 'Projeto e namespace' : 'Project and namespace', value: `${preview.project} / ${preview.namespace}` },
      { label: pt ? 'Caminho de escrita' : 'Write path', value: preview.executor.writePath },
      { label: 'Secrets', value: pt ? 'Nunca aparecem aqui: use o retrieval autorizado de cada capability.' : preview.secrets },
    ]} />
  );
}

/** Inputs de um passo: o que o usuário escolheu, o que veio por default e o que depende de outro passo. */
export function StepInputs({ step, editable, onEdit, pt }: {
  step: PreviewStep; editable: boolean; onEdit?: (ref: string, field: string, value: string) => void; pt: boolean;
}): JSX.Element {
  const defaults = new Map(step.defaults.map((d) => [d.field, d]));
  const rows = Object.keys(step.inputs).sort().map((field) => ({ field, value: step.inputs[field] }));
  return (
    <Table
      variant="embedded"
      ariaLabels={{ tableLabel: pt ? `Inputs de ${step.ref}` : `Inputs of ${step.ref}` }}
      items={rows}
      columnDefinitions={[
        { id: 'field', header: pt ? 'Campo' : 'Field', cell: (row) => <code>{row.field}</code> },
        {
          id: 'value', header: pt ? 'Valor' : 'Value', cell: (row) => (
            editable && !isReference(row.value) && typeof row.value !== 'object' && onEdit
              ? <Input value={String(row.value)} ariaLabel={`${step.ref}.${row.field}`} onChange={({ detail }) => onEdit(step.ref, row.field, detail.value)} />
              : <span>{displayValue(row.value, pt)}</span>
          ),
        },
        {
          id: 'origin', header: pt ? 'Origem' : 'Origin', cell: (row) => (
            isReference(row.value) ? <Badge>{pt ? `depende de ${row.value.fromRef}` : `from ${row.value.fromRef}`}</Badge>
              : defaults.has(row.field) ? <Badge color="blue">{pt ? `default (${defaults.get(row.field)?.basis === 'item name' ? 'nome do item' : 'schema'})` : `default (${defaults.get(row.field)?.basis})`}</Badge>
                : <span>{pt ? 'escolhido' : 'chosen'}</span>
          ),
        },
      ]}
    />
  );
}

export function PlanSteps({ preview, editable, onEdit, pt }: {
  preview: PlanPreview; editable: boolean; onEdit?: (ref: string, field: string, value: string) => void; pt: boolean;
}): JSX.Element {
  return (
    <SpaceBetween size="m">
      {preview.steps.map((step) => (
        <ExpandableSection key={step.ref} defaultExpanded variant="container" headerText={
          `${step.order}. ${pt ? step.displayNamePt : step.displayName}: ${step.name}`
        } headerDescription={
          (step.dependsOn.length ? (pt ? `Depois de: ${step.dependsOn.join(', ')}. ` : `After: ${step.dependsOn.join(', ')}. `) : '')
          + (pt ? `Cria ${step.path} (${step.kind}, ${step.capability}, ${step.lifecycle}).` : `Creates ${step.path} (${step.kind}, ${step.capability}, ${step.lifecycle}).`)
        }>
          <SpaceBetween size="s">
            <StepInputs step={step} editable={editable} onEdit={onEdit} pt={pt} />
            <KeyValuePairs columns={3} items={[
              { label: 'Deletion policy', value: step.deletionPolicy },
              { label: pt ? 'Ready quando' : 'Ready when', value: step.readyCondition || '-' },
              { label: pt ? 'Custo estimado' : 'Estimated cost', value: step.cost == null ? (pt ? 'não publicado para esta capability' : 'not published for this capability') : String(step.cost) },
            ]} />
            {step.manifest && (
              <div role="region" aria-label={pt ? `Manifest de ${step.ref} (arquivo novo)` : `Manifest of ${step.ref} (new file)`} tabIndex={0}>
                <Box variant="small">{pt ? 'Diff: arquivo novo, todas as linhas adicionadas.' : 'Diff: new file, every line added.'}</Box>
                <pre className="pa-manifest">{step.manifest.split('\n').filter(Boolean).map((line) => `+ ${line}`).join('\n')}</pre>
              </div>
            )}
          </SpaceBetween>
        </ExpandableSection>
      ))}
    </SpaceBetween>
  );
}

export function ConfirmPanel({ preview, acknowledged, onAcknowledge, onSubmit, busy, pt }: {
  preview: PlanPreview; acknowledged: boolean; onAcknowledge: (value: boolean) => void; onSubmit: () => void; busy: boolean; pt: boolean;
}): JSX.Element {
  return (
    <SpaceBetween size="s">
      <Checkbox checked={acknowledged} disabled={!preview.valid} onChange={({ detail }) => onAcknowledge(detail.checked)}>
        {pt ? `Revisei os ${preview.steps.length} recurso(s), os defaults e a ordem. Plano ${preview.planSha256?.slice(0, 12) ?? '-'}.`
          : `I reviewed the ${preview.steps.length} resource(s), the defaults and the order. Plan ${preview.planSha256?.slice(0, 12) ?? '-'}.`}
      </Checkbox>
      <Button variant="primary" loading={busy} disabled={!confirmable(preview, acknowledged)} onClick={onSubmit}>
        {pt ? 'Confirmar e abrir os pedidos' : 'Confirm and open the requests'}
      </Button>
      <Box variant="small">{pt ? 'Cada recurso vira um merge request revisado. Nada é aplicado direto no cluster.' : 'Each resource becomes a reviewed merge request. Nothing is applied to the cluster directly.'}</Box>
    </SpaceBetween>
  );
}

const REQUEST_ID = /^[0-9a-f]{32}$/;

/** MR do passo; antes dele, o mesmo "abrir agora" do wizard: sem o clique, o passo espera o sweep agendado. */
function MrCell({ step, pt }: { step: PlanRun['steps'][string]; pt: boolean }): JSX.Element | string {
  const url = safeMrUrl(step.mrUrl);
  if (url) return <a href={url} target="_blank" rel="noopener noreferrer">MR</a>;
  if (step.state === 'submitted' && step.requestId && REQUEST_ID.test(step.requestId)) {
    return <a href={openMrNowUrl(step.requestId)} target="_blank" rel="noopener noreferrer">{pt ? 'Abrir agora' : 'Open now'}</a>;
  }
  return '-';
}

export function RunSteps({ run, onRetry, busy, pt }: { run: PlanRun; onRetry?: (ref: string, attempt: number) => void; busy?: boolean; pt: boolean }): JSX.Element {
  const overall = runStatus(run.state, pt);
  return (
    <SpaceBetween size="s">
      <StatusIndicator type={overall.type}>{overall.label}</StatusIndicator>
      <Table
        variant="embedded"
        ariaLabels={{ tableLabel: pt ? 'Recursos do plano' : 'Plan resources' }}
        items={run.order.map((ref) => ({ ref, step: run.steps[ref] }))}
        columnDefinitions={[
          { id: 'ref', header: 'Ref', cell: (row) => <code>{row.ref}</code> },
          { id: 'state', header: pt ? 'Estado' : 'State', cell: (row) => { const s = stepStatus(row.step.state, pt); return <StatusIndicator type={s.type}>{s.label}</StatusIndicator>; } },
          { id: 'attempt', header: pt ? 'Tentativa' : 'Attempt', cell: (row) => String(row.step.attempt) },
          { id: 'mr', header: 'MR', cell: (row) => <MrCell step={row.step} pt={pt} /> },
          { id: 'detail', header: pt ? 'Detalhe' : 'Detail', cell: (row) => row.step.error || String(row.step.lastDetail?.message ?? row.step.lastDetail?.reason ?? '') || '-' },
          {
            id: 'action', header: pt ? 'Ação' : 'Action', cell: (row) => canRetry(run, row.ref) && onRetry
              ? <Button disabled={busy} onClick={() => onRetry(row.ref, row.step.attempt)}>{pt ? 'Tentar de novo' : 'Retry'}</Button> : '-',
          },
        ]}
      />
    </SpaceBetween>
  );
}

export function RunTimeline({ run, pt }: { run: PlanRun; pt: boolean }): JSX.Element {
  return (
    <Table
      variant="embedded"
      ariaLabels={{ tableLabel: pt ? 'Linha do tempo do plano' : 'Plan timeline' }}
      items={timelineRows(run, pt)}
      columnDefinitions={[
        { id: 'at', header: pt ? 'Quando (UTC)' : 'When (UTC)', cell: (row) => row.at },
        { id: 'ref', header: 'Ref', cell: (row) => row.ref },
        { id: 'what', header: pt ? 'O que' : 'What', cell: (row) => <StatusIndicator type={row.type}>{row.what}</StatusIndicator> },
        { id: 'source', header: pt ? 'Fonte' : 'Source', cell: (row) => row.source },
        { id: 'actor', header: pt ? 'Quem' : 'Who', cell: (row) => row.actor },
        { id: 'link', header: 'Link', cell: (row) => row.link ? <a href={row.link} target="_blank" rel="noopener noreferrer">MR</a> : '-' },
      ]}
    />
  );
}

export function CompensationPanel({ preview, acknowledged, onAcknowledge, onConfirm, busy, pt }: {
  preview: CompensationPreview; acknowledged: boolean; onAcknowledge: (value: boolean) => void; onConfirm: () => void; busy: boolean; pt: boolean;
}): JSX.Element {
  return (
    <SpaceBetween size="s">
      {preview.blocking.map((b) => <Alert key={b.code} type="info" header={pt ? 'Rollback indisponível agora' : 'Rollback not available now'}>{b.message} <code>{b.code}</code></Alert>)}
      {preview.targets.length > 0 && (
        <Table
          variant="embedded"
          ariaLabels={{ tableLabel: pt ? 'O rollback remove, nesta ordem' : 'The rollback removes, in this order' }}
          header={<Box variant="h4">{pt ? 'Remove, nesta ordem (dependentes primeiro)' : 'Removes, in this order (dependents first)'}</Box>}
          items={preview.targets}
          columnDefinitions={[
            { id: 'ref', header: 'Ref', cell: (t) => <code>{t.ref}</code> },
            { id: 'path', header: pt ? 'Arquivo' : 'File', cell: (t) => <code>{t.path}</code> },
            { id: 'effect', header: pt ? 'Efeito' : 'Effect', cell: (t) => t.effect },
          ]}
        />
      )}
      {preview.untouched.length > 0 && (
        <Box>
          <strong>{pt ? 'Não toca:' : 'Leaves untouched:'}</strong>
          <ul>{preview.untouched.map((u) => <li key={u.ref}><code>{u.name}</code>: {u.reason}</li>)}</ul>
        </Box>
      )}
      <Checkbox checked={acknowledged} disabled={!preview.allowed} onChange={({ detail }) => onAcknowledge(detail.checked)}>
        {pt ? `Entendi o que será removido. Rollback ${preview.compensationSha256.slice(0, 12)}.` : `I understand what will be removed. Rollback ${preview.compensationSha256.slice(0, 12)}.`}
      </Checkbox>
      <Button disabled={!preview.allowed || !acknowledged} loading={busy} onClick={onConfirm}>
        {pt ? 'Confirmar rollback' : 'Confirm rollback'}
      </Button>
    </SpaceBetween>
  );
}
