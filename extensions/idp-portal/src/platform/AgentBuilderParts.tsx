// Peças de apresentação do Agent Builder. Sem rede e sem estado global: recebem dados e callbacks,
// o que permite renderizar e testar cada uma isolada.
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import LiveRegion from '@cloudscape-design/components/live-region';
import PromptInput from '@cloudscape-design/components/prompt-input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Steps from '@cloudscape-design/components/steps';
import Table from '@cloudscape-design/components/table';
import { useState } from 'react';
import type { AgentCondition, AgentDraft, AgentEvent, CatalogTool, DraftIssue, PreviewResult } from './agentBuilderApi';
import { toolCatalog } from './agentBuilderApi';
import { ActionableError, diffStats, DiffLine, draftList, draftSkills, languageLabel, lineDiff, readIssue } from './agentBuilderModel';
import { AgentOp, AgentPhase, presentPhase, stepIndicator, stepStateLabel, timelineFor } from './agentBuilderPhase';
import type { ChatMessage } from './useAgentBuilder';
import './agentBuilder.css';

// ---------------------------------------------------------------- erro acionável

export function ErrorAlert({ error, onRetry, pt }: { error: ActionableError; onRetry?: () => void; pt: boolean }): JSX.Element {
  return (
    <Alert
      type="error"
      header={error.header}
      action={onRetry && error.retryable ? <Button onClick={onRetry}>{pt ? 'Tentar de novo' : 'Try again'}</Button> : undefined}
    >
      <SpaceBetween size="xxs">
        <span>{error.action}</span>
        {error.message && <Box variant="small" color="text-body-secondary">{pt ? 'Resposta do servidor' : 'Server response'}: <code>{error.message}</code></Box>}
      </SpaceBetween>
    </Alert>
  );
}

// ---------------------------------------------------------------- catálogo de tools

export function ToolCatalogCards({ selected, onChange, pt }: { selected: string[]; onChange: (tools: string[]) => void; pt: boolean }): JSX.Element {
  const items = toolCatalog.tools;
  return (
    <Cards<CatalogTool>
      ariaLabels={{
        itemSelectionLabel: (_, item) => (pt ? `Selecionar ${item.name}` : `Select ${item.name}`),
        selectionGroupLabel: pt ? 'Tools read-only do catálogo' : 'Read-only catalog tools',
      }}
      selectionType="multi"
      selectedItems={items.filter(tool => selected.includes(tool.name))}
      onSelectionChange={({ detail }) => onChange(detail.selectedItems.map(tool => tool.name))}
      trackBy="name"
      items={items}
      cardsPerRow={[{ cards: 1 }, { minWidth: 640, cards: 2 }, { minWidth: 1100, cards: 3 }]}
      cardDefinition={{
        header: tool => <code className="ab-tool-name">{tool.name}</code>,
        sections: [
          { id: 'summary', content: tool => (pt ? tool.summaryPt : tool.summary) },
          { id: 'mode', content: tool => <SpaceBetween direction="horizontal" size="xs"><Badge>read-only</Badge>{tool.name === 'k8s_get_pod_logs' && <Badge color="severity-medium">{pt ? 'pode conter dado sensível' : 'may contain sensitive data'}</Badge>}</SpaceBetween> },
        ],
      }}
      empty={<Box textAlign="center">{pt ? 'O catálogo de tools está vazio.' : 'The tool catalog is empty.'}</Box>}
    />
  );
}

// ---------------------------------------------------------------- rascunho legível

export function DraftSummary({ draft, pt }: { draft: Partial<AgentDraft>; pt: boolean }): JSX.Element {
  const instructions = draftList(draft, 'instructions');
  const tools = draftList(draft, 'tools');
  const skills = draftSkills(draft);
  const language = draft.language === 'pt-BR' || draft.language === 'en-US' || draft.language === 'es' ? languageLabel(draft.language, pt) : String(draft.language ?? '-');
  return (
    <SpaceBetween size="m">
      <KeyValuePairs
        columns={3}
        items={[
          { label: pt ? 'Nome de exibição' : 'Display name', value: draft.displayName || '-' },
          { label: pt ? 'Nome técnico' : 'Technical name', value: draft.name ? <code>{draft.name}</code> : '-' },
          { label: pt ? 'Idioma das respostas' : 'Answer language', value: language },
        ]}
      />
      <div>
        <Box variant="awsui-key-label">{pt ? 'Descrição' : 'Description'}</Box>
        <div>{draft.description || '-'}</div>
      </div>
      <ColumnLayout columns={2} variant="text-grid">
        <div>
          <Box variant="awsui-key-label">{pt ? `Como ele trabalha (${instructions.length})` : `How it works (${instructions.length})`}</Box>
          {instructions.length ? <ol className="ab-list">{instructions.map((step, i) => <li key={i}>{step}</li>)}</ol> : <Box color="text-status-inactive">{pt ? 'Sem instruções.' : 'No instructions.'}</Box>}
        </div>
        <div>
          <Box variant="awsui-key-label">{pt ? `Tools (${tools.length})` : `Tools (${tools.length})`}</Box>
          {tools.length
            ? <ul className="ab-list">{tools.map(tool => <li key={tool}><code>{tool}</code></li>)}</ul>
            : <Box color="text-status-inactive">{pt ? 'Nenhuma: responde só pela conversa.' : 'None: answers only from the conversation.'}</Box>}
        </div>
      </ColumnLayout>
      <div>
        <Box variant="awsui-key-label">{pt ? `Skills anunciadas no A2A (${skills.length})` : `Skills advertised over A2A (${skills.length})`}</Box>
        {skills.length ? (
          <ul className="ab-list">
            {skills.map((skill, i) => (
              <li key={skill.id ?? i}>
                <strong>{skill.name}</strong> <code>{skill.id}</code>: {skill.description}
                {Array.isArray(skill.examples) && skill.examples.length > 0 && <div className="ab-muted">{pt ? 'Exemplo' : 'Example'}: “{skill.examples[0]}”</div>}
              </li>
            ))}
          </ul>
        ) : <Box color="text-status-inactive">{pt ? 'Nenhuma skill.' : 'No skills.'}</Box>}
      </div>
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- veredito da policy

function IssueList({ issues, kind, pt }: { issues: (DraftIssue | string)[]; kind: 'error' | 'warning'; pt: boolean }): JSX.Element {
  return (
    <ul className="ab-issues" aria-label={kind === 'error' ? (pt ? 'Erros' : 'Errors') : (pt ? 'Avisos' : 'Warnings')}>
      {issues.map((issue, i) => {
        const r = readIssue(issue, pt);
        return (
          <li key={`${r.path}-${r.code}-${i}`}>
            <StatusIndicator type={kind === 'error' ? 'error' : 'warning'}>{kind === 'error' ? (pt ? 'Erro' : 'Error') : (pt ? 'Aviso' : 'Warning')}</StatusIndicator>{' '}
            <strong>{r.field}</strong>: {r.message}
            {r.hint && <div className="ab-muted">{pt ? 'Como resolver' : 'How to fix'}: {r.hint}</div>}
            {r.code && <div className="ab-muted"><code>{r.code}</code>{r.path && <> {pt ? 'em' : 'at'} <code>{r.path}</code></>}</div>}
          </li>
        );
      })}
    </ul>
  );
}

export function PolicyVerdict({ valid, errors, warnings, pt }: { valid: boolean; errors: (DraftIssue | string)[]; warnings: (DraftIssue | string)[]; pt: boolean }): JSX.Element {
  if (!valid) {
    return (
      <Alert type="error" header={pt ? `Bloqueado pela policy: ${errors.length} erro(s)` : `Blocked by policy: ${errors.length} error(s)`}>
        <SpaceBetween size="s">
          <span>{pt ? 'Nada foi enviado. Corrija os campos abaixo, editando o JSON ou pedindo um ajuste ao modelo.' : 'Nothing was sent. Fix the fields below by editing the JSON or asking the model for a change.'}</span>
          <IssueList issues={errors} kind="error" pt={pt} />
          {warnings.length > 0 && <IssueList issues={warnings} kind="warning" pt={pt} />}
        </SpaceBetween>
      </Alert>
    );
  }
  return (
    <Alert type={warnings.length ? 'warning' : 'success'} header={warnings.length ? (pt ? `Aprovado pela policy, com ${warnings.length} aviso(s)` : `Approved by policy, with ${warnings.length} warning(s)`) : (pt ? 'Aprovado pela policy' : 'Approved by policy')}>
      <SpaceBetween size="s">
        <span>{pt ? 'Schema, catálogo read-only e regras de nome conferidos pelo servidor. Avisos não bloqueiam o envio.' : 'Schema, read-only catalog and naming rules checked by the server. Warnings do not block submission.'}</span>
        {warnings.length > 0 && <IssueList issues={warnings} kind="warning" pt={pt} />}
      </SpaceBetween>
    </Alert>
  );
}

export function PreviewFacts({ preview, pt }: { preview: PreviewResult; pt: boolean }): JSX.Element | null {
  if (!preview.summary) return null;
  const s = preview.summary;
  return (
    <KeyValuePairs
      columns={3}
      items={[
        { label: pt ? 'Arquivo no Git' : 'Git file', value: <code>{preview.path}</code> },
        { label: 'Namespace', value: <code>{s.namespace}</code> },
        { label: 'ModelConfig', value: <code>{s.modelConfig}</code> },
        { label: pt ? 'Idioma' : 'Language', value: s.language },
        { label: 'Tools', value: s.tools.length ? s.tools.map(t => <div key={t}><code>{t}</code></div>) : (pt ? 'nenhuma' : 'none') },
        { label: 'Compiler', value: <code>{preview.compiler}</code> },
        { label: 'draft-sha256', value: <code title={preview.draftSha256}>{preview.draftSha256?.slice(0, 12)}…</code> },
      ]}
    />
  );
}

// ---------------------------------------------------------------- diff do manifest

const MARK: Record<DiffLine['kind'], string> = { add: '+', del: '-', same: ' ' };

export function ManifestDiff({ before, after, pt }: { before: string | null; after: string; pt: boolean }): JSX.Element {
  const [changesOnly, setChangesOnly] = useState(before !== null);
  const lines = lineDiff(before, after);
  const { added, removed } = diffStats(lines);
  const shown = changesOnly ? lines.filter(line => line.kind !== 'same') : lines;
  const summary = before === null
    ? (pt ? `Arquivo novo: ${added} linha(s) adicionada(s).` : `New file: ${added} line(s) added.`)
    : added + removed === 0
      ? (pt ? 'Sem mudança desde o último preview.' : 'No change since the last preview.')
      : (pt ? `Desde o último preview: ${added} linha(s) adicionada(s), ${removed} removida(s).` : `Since the last preview: ${added} line(s) added, ${removed} removed.`);
  return (
    <SpaceBetween size="xs">
      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
        <Box variant="p">{summary}</Box>
        {before !== null && added + removed > 0 && (
          <Button variant="inline-link" onClick={() => setChangesOnly(v => !v)} ariaExpanded={!changesOnly}>
            {changesOnly ? (pt ? 'Ver o manifest inteiro' : 'Show the whole manifest') : (pt ? 'Ver só as mudanças' : 'Show changes only')}
          </Button>
        )}
      </SpaceBetween>
      <div className="ab-diff" role="region" aria-label={pt ? 'Diff do manifest' : 'Manifest diff'} tabIndex={0}>
        <table>
          <caption className="ab-sr-only">{summary} {pt ? 'Legenda: + linha adicionada, - linha removida.' : 'Legend: + added line, - removed line.'}</caption>
          <tbody>
            {shown.map((line, i) => (
              <tr key={i} className={`ab-diff-${line.kind}`}>
                <td className="ab-diff-no" aria-hidden="true">{line.newNo ?? line.oldNo}</td>
                <td className="ab-diff-mark">
                  <span aria-hidden="true">{MARK[line.kind]}</span>
                  <span className="ab-sr-only">{line.kind === 'add' ? (pt ? 'adicionada' : 'added') : line.kind === 'del' ? (pt ? 'removida' : 'removed') : ''}</span>
                </td>
                <td className="ab-diff-text"><code>{line.text || ' '}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SpaceBetween>
  );
}

// ---------------------------------------------------------------- fase e trilha

export function PhaseBanner({ phase, pt }: { phase: AgentPhase; pt: boolean }): JSX.Element {
  const p = presentPhase(phase, pt);
  return (
    <div className="ab-phase" data-phase={phase}>
      <LiveRegion>
        <StatusIndicator type={p.indicator}>{p.label}</StatusIndicator>
      </LiveRegion>
      <Box variant="p" color="text-body-secondary">{p.detail}</Box>
    </div>
  );
}

export function LifecycleTimeline({ op, phase, pt }: { op: AgentOp; phase: AgentPhase; pt: boolean }): JSX.Element {
  const steps = timelineFor(op, phase, pt);
  return (
    <Steps
      ariaLabel={pt ? 'Etapas até o agent operacional' : 'Steps until the agent is operational'}
      steps={steps.map(step => ({
        status: stepIndicator(step.state),
        statusIconAriaLabel: stepStateLabel(step.state, pt),
        header: <span data-step={step.key} data-state={step.state}>{step.label} <span className="ab-muted">({stepStateLabel(step.state, pt)})</span></span>,
      }))}
    />
  );
}

export function ConditionPill({ label, condition, pt }: { label: string; condition: AgentCondition | undefined; pt: boolean }): JSX.Element {
  const status = condition?.status ?? 'Unknown';
  const type = status === 'True' ? 'success' : status === 'False' ? 'error' : 'pending';
  const word = status === 'True' ? (pt ? 'sim' : 'yes') : status === 'False' ? (pt ? 'não' : 'no') : (pt ? 'desconhecido' : 'unknown');
  return (
    <div>
      <StatusIndicator type={type}>{`${label}: ${word} (${status})`}</StatusIndicator>
      {(condition?.reason || condition?.message) && <div className="ab-muted">{[condition?.reason, condition?.message].filter(Boolean).join(': ')}</div>}
    </div>
  );
}

export function EventsTable({ events, pt }: { events: AgentEvent[]; pt: boolean }): JSX.Element {
  return (
    <Table<AgentEvent>
      variant="embedded"
      items={events}
      columnDefinitions={[
        { id: 'type', header: pt ? 'Tipo' : 'Type', cell: e => <StatusIndicator type={e.type === 'Warning' ? 'warning' : 'info'}>{e.type ?? '-'}</StatusIndicator> },
        { id: 'reason', header: pt ? 'Motivo' : 'Reason', cell: e => e.reason ?? '-' },
        { id: 'message', header: pt ? 'Mensagem' : 'Message', cell: e => e.message ?? '-' },
        { id: 'last', header: pt ? 'Último' : 'Last', cell: e => e.last ?? '-' },
      ]}
      empty={<Box textAlign="center" color="text-status-inactive">{pt ? 'Nenhum evento recente.' : 'No recent events.'}</Box>}
    />
  );
}

// ---------------------------------------------------------------- chat de teste A2A

export function A2AChat({ agentLabel, messages, running, disabled, disabledReason, onSend, pt }: {
  agentLabel: string;
  messages: ChatMessage[];
  running: boolean;
  disabled: boolean;
  disabledReason?: string;
  onSend: (text: string) => void;
  pt: boolean;
}): JSX.Element {
  const [text, setText] = useState('');
  const suggestion = pt ? 'Em uma frase, diga quem você é e quais tools pode usar.' : 'In one sentence, say who you are and which tools you can use.';
  const tooLong = text.length > 500;
  const send = (value: string) => {
    if (disabled || running || value.length > 500) return;
    onSend(value);
    setText('');
  };
  const speaker = (role: ChatMessage['role']) => (role === 'user' ? (pt ? 'Você' : 'You') : role === 'agent' ? agentLabel : (pt ? 'Portal' : 'Portal'));
  return (
    <SpaceBetween size="s">
      <div className="ab-chat" role="log" aria-live="polite" aria-label={pt ? 'Conversa de teste A2A' : 'A2A test conversation'} tabIndex={0}>
        {messages.length === 0 && (
          <Box color="text-status-inactive" padding="s">
            {pt ? 'Nenhuma mensagem ainda. A pergunta vai pelo protocolo A2A até o agent, pela cluster-api; nada além do texto chega ao controller.' : 'No messages yet. The question goes over A2A to the agent through the cluster-api; nothing but the text reaches the controller.'}
          </Box>
        )}
        {messages.map(message => (
          <div key={message.id} className={`ab-msg ab-msg-${message.role}`}>
            <div className="ab-msg-who">{speaker(message.role)}{message.state && <span className="ab-muted"> · {message.state}</span>}</div>
            <div className="ab-msg-text">{message.text}</div>
          </div>
        ))}
        {running && <div className="ab-msg ab-msg-system"><StatusIndicator type="loading">{pt ? 'Aguardando a resposta do agent (consulta a cada 2 s, até 60 s)' : 'Waiting for the agent (checking every 2 s, up to 60 s)'}</StatusIndicator></div>}
      </div>
      {disabled && disabledReason && <Box color="text-status-inactive">{disabledReason}</Box>}
      <PromptInput
        value={text}
        onChange={({ detail }) => setText(detail.value)}
        onAction={({ detail }) => send(detail.value)}
        placeholder={suggestion}
        actionButtonIconName="send"
        actionButtonAriaLabel={pt ? 'Enviar pergunta de teste' : 'Send test question'}
        ariaLabel={pt ? 'Pergunta para o agent' : 'Question for the agent'}
        disabled={disabled}
        disableActionButton={running || disabled || tooLong}
        invalid={tooLong}
        maxRows={4}
        secondaryActions={<Button variant="inline-link" disabled={disabled || running} onClick={() => send(suggestion)}>{pt ? 'Usar a pergunta sugerida' : 'Use the suggested question'}</Button>}
      />
      <Box variant="small" color="text-body-secondary">{pt ? `Enter envia, Shift+Enter quebra linha. ${text.length}/500 caracteres.` : `Enter sends, Shift+Enter adds a line. ${text.length}/500 characters.`}{tooLong && (pt ? ' Encurte a pergunta para enviar.' : ' Shorten the question to send it.')}</Box>
    </SpaceBetween>
  );
}
