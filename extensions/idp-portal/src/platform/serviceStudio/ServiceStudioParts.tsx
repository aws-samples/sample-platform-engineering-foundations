// Presentational pieces of the Service Owner Studio. Pure props, no fetch, so each one renders in
// a test with renderToStaticMarkup and can be reused by the wizard (SchemaFormPreview) after merge.
// Status is always carried by text and an icon-bearing StatusIndicator, never by color alone.
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Tabs from '@cloudscape-design/components/tabs';
import Textarea from '@cloudscape-design/components/textarea';
import Toggle from '@cloudscape-design/components/toggle';
import { FieldError, FormFieldModel, FormValues } from './schemaForm';
import { ageText, ContractDiff, issueText, PolicyVerdict, Provenance, StatusConfidence, StudioIssue, StudioState } from './serviceStudioModel';

const ERROR_TEXT: Record<FieldError['code'], [string, string]> = {
  required: ['Required.', 'Obrigatório.'],
  pattern: ['Does not match the expected format.', 'Não casa com o formato esperado.'],
  enum: ['Choose one of the options.', 'Escolha uma das opções.'],
  type: ['Wrong type.', 'Tipo errado.'],
  range: ['Out of the allowed range.', 'Fora do intervalo permitido.'],
  unknown_field: ['Not part of this form.', 'Não faz parte deste formulário.'],
};

/** The form the consumer will see. Driven only by the compiled schema.json. */
export function SchemaFormPreview({ fields, values, errors = [], pt, onChange, readOnly = false }: {
  fields: FormFieldModel[]; values: FormValues; errors?: FieldError[]; pt: boolean; readOnly?: boolean;
  onChange?(name: string, value: unknown): void;
}): JSX.Element {
  const set = (name: string, value: unknown) => onChange?.(name, value);
  return <SpaceBetween size="m">
    {fields.map(field => {
      const error = errors.find(e => e.name === field.name);
      const value = values[field.name];
      const common = { label: field.label, description: field.description || undefined, errorText: error ? ERROR_TEXT[error.code][pt ? 1 : 0] : undefined,
        info: field.required ? <Box variant="small">{pt ? 'obrigatório' : 'required'}</Box> : undefined };
      let control: JSX.Element;
      switch (field.control) {
        case 'select':
          control = <Select disabled={readOnly} selectedOption={value === undefined ? null : { label: String(value), value: String(value) }}
            options={field.options.map(o => ({ label: o, value: o }))} onChange={({ detail }) => set(field.name, detail.selectedOption.value)} />;
          break;
        case 'number':
          control = <Input disabled={readOnly} type="number" inputMode="numeric" value={value === undefined ? '' : String(value)} placeholder={field.placeholder}
            onChange={({ detail }) => set(field.name, detail.value === '' ? undefined : Number(detail.value))} />;
          break;
        case 'toggle':
          control = <Toggle disabled={readOnly} checked={value === true} onChange={({ detail }) => set(field.name, detail.checked)}>{field.label}</Toggle>;
          break;
        case 'keyValue':
        case 'list':
          control = <Textarea disabled={readOnly} rows={3} value={value === undefined ? '' : JSON.stringify(value)} placeholder={field.placeholder}
            onChange={({ detail }) => { try { set(field.name, detail.value ? JSON.parse(detail.value) : undefined); } catch { set(field.name, detail.value); } }} />;
          break;
        case 'unsupported':
          control = <StatusIndicator type="warning">{pt ? 'Tipo não suportado pelo renderer' : 'Type not supported by the renderer'}</StatusIndicator>;
          break;
        default:
          control = <Input disabled={readOnly} value={value === undefined ? '' : String(value)} placeholder={field.placeholder}
            onChange={({ detail }) => set(field.name, detail.value === '' ? undefined : detail.value)} />;
      }
      return <FormField key={field.name} {...common} constraintText={field.pattern ? `${pt ? 'Formato' : 'Format'}: ${field.pattern}` : undefined}>{control}</FormField>;
    })}
  </SpaceBetween>;
}

const STATE_TEXT: Record<StudioState, [StatusType, string, string]> = {
  draft: ['pending', 'Draft, not previewed', 'Rascunho, sem preview'],
  generating: ['loading', 'The model is proposing a draft', 'O modelo está propondo um rascunho'],
  proposed: ['info', 'Model proposal ready: preview it', 'Proposta do modelo pronta: faça o preview'],
  validating: ['loading', 'Validating and compiling', 'Validando e compilando'],
  invalid: ['error', 'Blocked by the contract', 'Bloqueado pelo contrato'],
  unauthorized: ['stopped', 'You are not a Service Owner of this team', 'Você não é Service Owner deste time'],
  previewed: ['success', 'Previewed: review the diff and propose', 'Preview pronto: revise o diff e proponha'],
  requested: ['in-progress', 'Request recorded, the MR opens shortly', 'Pedido registrado, o MR abre em instantes'],
  processing: ['in-progress', 'Opening the merge request', 'Abrindo o merge request'],
  mr_open: ['success', 'Merge request open for review', 'Merge request aberto para review'],
  merged: ['success', 'Merged: CI and GitOps publish it', 'Merge feito: CI e GitOps publicam'],
  closed: ['stopped', 'Closed without merge: nothing changed', 'Fechado sem merge: nada mudou'],
  failed: ['error', 'Failed: nothing was published', 'Falhou: nada foi publicado'],
};
type StatusType = 'pending' | 'loading' | 'info' | 'error' | 'stopped' | 'success' | 'in-progress' | 'warning';

/**
 * `confidence: 'stale'` muda o que a tela afirma: um `mr_open` que o CI não reconfirmou vira
 * "último estado lido", com ícone de aviso e texto, nunca "aberto" (o MR pode ter sido fechado).
 */
export function StateBanner({ state, pt, confidence }: { state: StudioState; pt: boolean; confidence?: StatusConfidence }): JSX.Element {
  if (state === 'mr_open' && confidence === 'stale') {
    return <StatusIndicator type="warning">{pt ? 'Último estado lido: MR aberto, não reconfirmado' : 'Last read: MR open, not reconfirmed'}</StatusIndicator>;
  }
  const [type, en, ptText] = STATE_TEXT[state];
  return <StatusIndicator type={type}>{pt ? ptText : en}</StatusIndicator>;
}

/** A frase que acompanha o status de um pedido: de quando é a confirmação e o que fazer se for velha. */
export function requestStatusNote(confidence: StatusConfidence, ageSeconds: number | null, pt: boolean): string {
  if (confidence === 'confirmed' && ageSeconds !== null) {
    // Sem frequência fixa: o schedule do sweep não garante um intervalo exato (design-auto-mr.md, "Schedule").
    return pt ? `Confirmado pelo CI ${ageText(ageSeconds, true)}. O próximo sweep agendado reconfere.`
      : `Confirmed by CI ${ageText(ageSeconds, false)}. The next scheduled sweep rechecks it.`;
  }
  if (confidence === 'stale') {
    const since = ageSeconds === null ? (pt ? 'nunca reconfirmado pelo CI' : 'never reconfirmed by CI')
      : (pt ? `com última confirmação do CI ${ageText(ageSeconds, true)}` : `last confirmed by CI ${ageText(ageSeconds, false)}`);
    return pt ? `Estado ${since}: o MR pode ter sido fechado ou mergeado. Confira no link do MR ou verifique de novo.`
      : `Status ${since}: the MR may have been closed or merged. Check the MR link or check again.`;
  }
  return '';
}

export function IssuesAlert({ errors, warnings, pt }: { errors: StudioIssue[]; warnings: StudioIssue[]; pt: boolean }): JSX.Element | null {
  if (!errors.length && !warnings.length) return null;
  return <SpaceBetween size="xs">
    {errors.length > 0 && <Alert type="error" header={pt ? `Bloqueado: ${errors.length} erro(s)` : `Blocked: ${errors.length} error(s)`}>
      <ul>{errors.map(e => <li key={`${e.path}-${e.code}`}>{issueText(e, pt)}</li>)}</ul></Alert>}
    {warnings.length > 0 && <Alert type="warning" header={pt ? `${warnings.length} aviso(s)` : `${warnings.length} warning(s)`}>
      <ul>{warnings.map(w => <li key={`${w.path}-${w.code}`}>{issueText(w, pt)}</li>)}</ul></Alert>}
  </SpaceBetween>;
}

const show = (value: unknown) => value === undefined || value === null ? '-' : typeof value === 'string' ? value : JSON.stringify(value);

export function ContractDiffView({ diff, pt }: { diff: ContractDiff; pt: boolean }): JSX.Element {
  const line = (label: string, items: string[]) => <div><Box variant="awsui-key-label">{label} ({items.length})</Box>{items.length ? items.join(', ') : '-'}</div>;
  return <Container header={<Header variant="h3">{pt ? 'Diff do contrato' : 'Contract diff'} ({diff.op})</Header>}>
    <SpaceBetween size="s">
      <ColumnLayout columns={3} variant="text-grid">
        {line(pt ? '+ Campos adicionados' : '+ Fields added', diff.fieldsAdded)}
        {line(pt ? '- Campos removidos' : '- Fields removed', diff.fieldsRemoved)}
        {line(pt ? '~ Campos alterados' : '~ Fields changed', diff.fieldsChanged.map(c => c.name))}
      </ColumnLayout>
      {diff.fieldsChanged.flatMap(c => c.changes.map(ch => <Box key={`${c.name}.${ch.key}`}>~ {c.name}.{ch.key}: {show(ch.before)} → {show(ch.after)}</Box>))}
      {diff.metadataChanged.map(m => <Box key={m.key}>~ {m.key}: {show(m.before)} → {show(m.after)}</Box>)}
    </SpaceBetween>
  </Container>;
}

export function PolicyVerdictView({ policy, pt }: { policy: PolicyVerdict; pt: boolean }): JSX.Element {
  const elevated = policy.verdict === 'elevated_review';
  return <Alert type={elevated ? 'warning' : 'info'} header={elevated ? (pt ? 'Review elevado: platform reviewer obrigatório' : 'Elevated review: platform reviewer required')
    : (pt ? 'Review padrão do owner team' : 'Standard owner-team review')}>
    <SpaceBetween size="xxs">
      <span>{pt ? 'Nenhuma mudança é aplicada aqui: o MR é o único caminho, com CI e GitOps.' : 'Nothing is applied here: the MR is the only path, with CI and GitOps.'}</span>
      {policy.reasons.map(r => <span key={r}>⚠ {r}</span>)}
    </SpaceBetween>
  </Alert>;
}

export function ProvenanceView({ provenance, pt }: { provenance: Provenance; pt: boolean }): JSX.Element {
  return <KeyValuePairs columns={3} items={[
    { label: pt ? 'Solicitante' : 'Requester', value: provenance.requester },
    { label: 'Owner team', value: provenance.owner },
    { label: pt ? 'Origem' : 'Origin', value: provenance.origin },
    { label: pt ? 'Fontes' : 'Sources', value: provenance.sources.length ? provenance.sources.join(', ') : '-' },
    { label: 'Compiler', value: provenance.compiler },
    { label: 'Draft SHA-256', value: provenance.draftSha256.slice(0, 12) },
  ]} />;
}

export function ArtifactTabs({ artifacts }: { artifacts: Record<string, string> }): JSX.Element {
  const entries = Object.entries(artifacts);
  return <Tabs tabs={entries.map(([path, text]) => ({ id: path, label: path.split('/').slice(-2).join('/'),
    content: <Box variant="pre">{text}</Box> }))} />;
}
