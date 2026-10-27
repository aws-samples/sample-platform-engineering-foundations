// Service Owner Studio (issue #11). A Service Owner describes a capability, imports an RGD/CRD or
// starts from an existing package, reviews the compiled form, the contract diff, the policy
// verdict and the provenance, and proposes. Proposing records a request; the CI opens the MR.
// Nothing here applies to the cluster or writes to Git.
//
// Isolable: the page takes its API and its starting points as props. The shell mounts it at
// `#studio` through ServiceStudioPage (devPlatformPages.tsx), passing nothing (defaults are real).
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Autosuggest from '@cloudscape-design/components/autosuggest';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import Select, { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import { useI18n } from '../i18n';
import { errorMessage } from '../errors';
import { formModelFromSchema, FormValues, initialValues, validateValues } from './schemaForm';
import { serviceStudioApi, ServiceRequest, ServiceStudioApi } from './serviceStudioApi';
import {
  canPropose, draftFromPackage, DraftOrigin, emptyDraft, goldenPathOptions, GoldenPathOption, importFromCrd, importFromRgd, isBusy,
  issueAt, PreviewResponse, ServiceDraft, POLL_BOUND_MS, pollStart, PollStart, statusConfidence, StudioIssue, StudioOp, StudioState,
  suggestedGoldenPath, transition,
} from './serviceStudioModel';
import {
  ArtifactTabs, ContractDiffView, IssuesAlert, PolicyVerdictView, ProvenanceView, requestStatusNote, SchemaFormPreview, StateBanner,
} from './ServiceStudioParts';

const compositionFiles = import.meta.glob('../../../platform/compositions/*-rgd.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const capabilityFiles = import.meta.glob('../../../platform/catalog/**/capability.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const schemaFiles = import.meta.glob('../../../platform/catalog/**/schema.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface StartingPoint { id: string; label: string; origin: DraftOrigin; build(current: ServiceDraft): { draft: ServiceDraft; base?: ServiceDraft; source: string; skipped: string[] } }

export function bundledStartingPoints(): StartingPoint[] {
  const points: StartingPoint[] = [];
  for (const [path, text] of Object.entries(compositionFiles)) {
    const ref = `platform/compositions/${path.split('/').pop()}`;
    points.push({ id: `rgd:${ref}`, label: `RGD ${ref.split('/').pop()}`, origin: 'import-rgd', build: current => {
      const imported = importFromRgd(text, ref);
      return { draft: { ...current, rgdRef: ref, fields: imported.fields, pattern: current.pattern || `kro ${imported.kind}` }, source: imported.source, skipped: imported.skipped };
    } });
  }
  for (const [path, text] of Object.entries(capabilityFiles)) {
    const schemaPath = path.replace(/capability\.yaml$/, 'schema.json');
    if (!schemaFiles[schemaPath] || path.includes('/catalog/agent/')) continue;
    const id = path.split('/catalog/')[1].replace(/\/capability\.yaml$/, '');
    points.push({ id: `pkg:${id}`, label: `Catalog ${id}`, origin: 'catalog', build: () => {
      const base = draftFromPackage(text, JSON.parse(schemaFiles[schemaPath]));
      return { draft: structuredClone(base), base, source: `catalog:platform/catalog/${id}`, skipped: [] };
    } });
  }
  return points.sort((a, b) => a.label.localeCompare(b.label));
}

/** As sugestões de golden path, com a da composition escolhida primeiro. */
function orderedGoldenPaths(options: GoldenPathOption[], rgdRef: string | undefined) {
  const suggested = suggestedGoldenPath(options, rgdRef);
  return [...options].sort((a, b) => Number(b.value === suggested) - Number(a.value === suggested))
    .map(option => ({ value: option.value, label: option.label }));
}

/** Diz de onde vem a sugestão; o valor só entra no draft quando o Dev escolhe. */
function goldenPathHint(options: GoldenPathOption[], draft: ServiceDraft, pt: boolean): string | undefined {
  const suggested = suggestedGoldenPath(options, draft.rgdRef);
  if (!suggested || draft.goldenPath === suggested) return undefined;
  return pt ? `Sugerido pela composition: ${suggested}` : `Suggested by the composition: ${suggested}`;
}

const DOMAINS = ['app', 'cache', 'compute', 'database', 'entrypoint', 'frontend', 'messaging', 'storage'];

// Um client e uma lista por módulo: um default novo a cada render reiniciava o polling (e o prazo).
const defaultApi = serviceStudioApi();
let defaultPoints: StartingPoint[] | null = null;
let defaultGoldenPaths: GoldenPathOption[] | null = null;

/**
 * `requestId` vem da rota `#studio/<requestId>`: no mount (reload, deep link) o pedido é relido com
 * `status()` e o acompanhamento continua. `onRequested` é chamado depois de um pedido gravado, para
 * o shell escrever esse id na URL.
 */
export function ServiceOwnerStudio({ api: apiProp, startingPoints: pointsProp, goldenPaths: goldenPathsProp, requestId, onRequested }: {
  api?: ServiceStudioApi; startingPoints?: StartingPoint[]; goldenPaths?: GoldenPathOption[]; requestId?: string | null; onRequested?(requestId: string): void;
}): JSX.Element {
  const api = useMemo(() => apiProp ?? defaultApi, [apiProp]);
  const startingPoints = useMemo(() => pointsProp ?? (defaultPoints ??= bundledStartingPoints()), [pointsProp]);
  const goldenPaths = useMemo(() => goldenPathsProp ?? (defaultGoldenPaths ??= goldenPathOptions(Object.values(capabilityFiles))), [goldenPathsProp]);
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [state, dispatch] = useReducer(transition, 'draft' as StudioState);
  const [draft, setDraft] = useState<ServiceDraft>(emptyDraft());
  const [base, setBase] = useState<ServiceDraft | undefined>(undefined);
  const [origin, setOrigin] = useState<DraftOrigin>('form');
  const [sources, setSources] = useState<string[]>([]);
  const [prompt, setPrompt] = useState(pt ? 'Uma tabela DynamoDB para eventos de pedido, com chave de partição configurável.' : 'A DynamoDB table for order events, with a configurable partition key.');
  const [json, setJson] = useState(() => JSON.stringify(emptyDraft(), null, 2));
  const [issues, setIssues] = useState<{ errors: StudioIssue[]; warnings: StudioIssue[] }>({ errors: [], warnings: [] });
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [request, setRequest] = useState<ServiceRequest | null>(null);
  // Quando o status foi lido do servidor, e um relógio que só redesenha: a idade da confirmação
  // continua crescendo depois que o polling para, e a tela tem de deixar de afirmar "aberto".
  const [readAt, setReadAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [pollEpoch, setPollEpoch] = useState(0);
  const [notice, setNotice] = useState('');
  const [values, setValues] = useState<FormValues>({});
  const op: StudioOp = base ? 'evolve' : 'create';

  const fields = useMemo(() => preview?.form ? formModelFromSchema(preview.form) : [], [preview?.form]);
  useEffect(() => { setValues(initialValues(fields)); }, [fields]);

  const replaceDraft = (next: ServiceDraft, nextOrigin: DraftOrigin = origin) => {
    setDraft(next); setJson(JSON.stringify(next, null, 2)); setOrigin(nextOrigin); setPreview(null); dispatch({ type: 'edit' });
  };
  // The JSON editor and the inputs edit the same object: merge into what the JSON says now, so an
  // advanced edit is never lost by touching a metadata input.
  const current = (): ServiceDraft => { try { return JSON.parse(json) as ServiceDraft; } catch { return draft; } };
  const patch = (changes: Partial<ServiceDraft>) => replaceDraft({ ...current(), ...changes });

  const generate = async () => {
    dispatch({ type: 'generate' }); setNotice('');
    try {
      const result = await api.generate(prompt, pt ? 'pt-BR' : 'en-US', draft.name ? draft : undefined);
      setDraft(result.draft); setJson(JSON.stringify(result.draft, null, 2)); setOrigin('model'); setPreview(null);
      setSources(result.provenance.sources ?? []);
      setIssues({ errors: result.validation.errors, warnings: result.validation.warnings });
      dispatch({ type: 'generated', valid: result.validation.valid });
    } catch (cause) {
      setNotice(errorMessage(cause, pt ? 'O modelo não respondeu. Nada foi alterado.' : 'The model did not answer. Nothing changed.'));
      dispatch({ type: 'generationFailed' });
    }
  };

  const runPreview = async () => {
    let parsed: ServiceDraft;
    try { parsed = JSON.parse(json) as ServiceDraft; } catch {
      setIssues({ errors: [{ path: '', code: 'type', message: 'The draft is not valid JSON.', messagePt: 'O draft não é um JSON válido.' }], warnings: [] });
      return;
    }
    dispatch({ type: 'preview' }); setNotice('');
    try {
      const result = await api.preview({ op: op === 'evolve' ? 'evolve' : 'create', draft: parsed, base, origin, sources });
      setDraft(parsed); setPreview(result.state === 'previewed' ? result : null);
      setIssues({ errors: result.errors ?? [], warnings: result.warnings ?? [] });
      dispatch({ type: 'previewed', state: result.state });
    } catch (cause) {
      setNotice(errorMessage(cause, pt ? 'Preview indisponível.' : 'Preview unavailable.'));
      dispatch({ type: 'previewFailed' });
    }
  };

  const propose = async () => {
    if (!preview?.draftSha256 || !canPropose(state)) return;
    dispatch({ type: 'propose' });
    try {
      const recorded = await api.request({ op, draft, base, origin, sources, previewSha256: preview.draftSha256 });
      setRequest(recorded);
      onRequested?.(recorded.requestId);
    } catch (cause) {
      setNotice(errorMessage(cause, pt ? 'O pedido não foi registrado.' : 'The request was not recorded.'));
      dispatch({ type: 'requestFailed' });
    }
  };

  const read = (found: ServiceRequest) => { setRequest(found); setReadAt(Date.now()); setNow(Date.now()); };

  // Reload ou deep link de `#studio/<requestId>`: relê o pedido do servidor, que é a fonte.
  useEffect(() => {
    if (!requestId || request?.requestId === requestId) return undefined;
    let active = true;
    api.status(requestId)
      .then(found => { if (active) { read(found); dispatch({ type: 'restored', status: found.status }); } })
      .catch(cause => { if (active) setNotice(errorMessage(cause, pt ? 'Pedido não encontrado.' : 'Request not found.')); });
    return () => { active = false; };
  }, [api, requestId]);

  // Poll until the CI settles the request. The 30-minute bound counts from the FIRST poll of this
  // requestId: a re-render or a state change (requested -> processing -> mr_open) keeps the start.
  // `pollEpoch` opens a NEW window: "Verificar de novo" and coming back to the tab bump it.
  const pollStarted = useRef<PollStart | null>(null);
  useEffect(() => {
    if (!request || !['requested', 'processing', 'mr_open'].includes(state)) return undefined;
    const started = pollStart(pollStarted.current, `${request.requestId}#${pollEpoch}`, Date.now());
    pollStarted.current = started;
    const timer = window.setInterval(async () => {
      if (Date.now() - started.at > POLL_BOUND_MS) { window.clearInterval(timer); return; }
      try { const next = await api.status(request.requestId); read(next); dispatch({ type: 'status', status: next.status }); } catch { /* transient */ }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [api, request?.requestId, state, pollEpoch]);

  // Quem fecha o MR no GitLab volta para esta aba: relê na volta e reabre a janela de polling.
  useEffect(() => {
    if (!request || !['requested', 'processing', 'mr_open'].includes(state)) return undefined;
    const onVisible = () => { if (document.visibilityState === 'visible') setPollEpoch(epoch => epoch + 1); };
    document.addEventListener('visibilitychange', onVisible);
    const tick = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.clearInterval(tick); };
  }, [request?.requestId, state]);

  const checkAgain = async () => {
    if (!request) return;
    try { const next = await api.status(request.requestId); read(next); dispatch({ type: 'status', status: next.status }); setPollEpoch(epoch => epoch + 1); }
    catch (cause) { setNotice(errorMessage(cause, pt ? 'Não foi possível reler o pedido.' : 'Could not read the request again.')); }
  };
  const freshness = request ? statusConfidence(request, readAt, now) : null;

  const startFrom = (option: SelectProps.Option | null) => {
    const point = startingPoints.find(p => p.id === option?.value);
    if (!point) return;
    try {
      const built = point.build(current());
      setBase(built.base); setSources([built.source]); replaceDraft(built.draft, point.origin);
      setNotice(built.skipped.length ? `${pt ? 'Campos não importados (tipo não suportado)' : 'Fields not imported (unsupported type)'}: ${built.skipped.join(', ')}` : '');
    } catch (cause) { setNotice(errorMessage(cause, pt ? 'Não foi possível importar.' : 'Could not import.')); }
  };

  const importCrd = (text: string) => {
    try {
      const imported = importFromCrd(text);
      setBase(undefined); setSources([imported.source]);
      replaceDraft({ ...current(), rgdRef: undefined, lifecycle: 'planned', fields: imported.fields, pattern: draft.pattern || `CRD ${imported.kind}` }, 'import-crd');
    } catch (cause) { setNotice(errorMessage(cause, pt ? 'CRD inválida.' : 'Invalid CRD.')); }
  };

  const valueErrors = validateValues(fields, values);
  const busy = isBusy(state);

  return <SpaceBetween size="l">
    <Container header={<Header variant="h2" description={pt ? 'Descreva, importe ou evolua uma capability. O modelo só propõe; o contrato decide, você revisa e o MR publica.' : 'Describe, import or evolve a capability. The model only proposes; the contract decides, you review and the MR publishes.'}
      actions={<StateBanner state={state} pt={pt} />}>Service Owner Studio</Header>}>
      <SpaceBetween size="m">
        {!!notice && <Alert type="info" dismissible onDismiss={() => setNotice('')}>{notice}</Alert>}
        <FormField label={pt ? 'Descreva a capability' : 'Describe the capability'} description={pt ? 'O texto vai ao modelo como dado. Ele não pode escolher IAM, Secret nem namespace.' : 'The text goes to the model as data. It cannot choose IAM, Secrets or namespaces.'}>
          <Textarea value={prompt} rows={3} onChange={({ detail }) => setPrompt(detail.value)} />
        </FormField>
        <SpaceBetween direction="horizontal" size="xs">
          <Button variant="primary" loading={state === 'generating'} disabled={busy || !prompt.trim()} onClick={generate}>{pt ? 'Propor com Bedrock' : 'Propose with Bedrock'}</Button>
          <Select placeholder={pt ? 'Ou comece de um RGD ou package do catálogo' : 'Or start from an RGD or catalog package'} selectedOption={null}
            options={startingPoints.map(p => ({ label: p.label, value: p.id }))} onChange={({ detail }) => startFrom(detail.selectedOption)} filteringType="auto" />
        </SpaceBetween>
        <FormField label={pt ? 'Ou cole uma CRD (ACK incluída)' : 'Or paste a CRD (ACK included)'} stretch>
          <Textarea rows={2} value="" placeholder="apiVersion: apiextensions.k8s.io/v1" onChange={({ detail }) => detail.value.trim() && importCrd(detail.value)} />
        </FormField>
      </SpaceBetween>
    </Container>

    <Container header={<Header variant="h2" description={base ? (pt ? `Evoluindo ${base.domain}/${base.name}/${base.version}` : `Evolving ${base.domain}/${base.name}/${base.version}`) : (pt ? 'Capability nova' : 'New capability')}>{pt ? 'Rascunho' : 'Draft'}</Header>}>
      <SpaceBetween size="m">
        <SpaceBetween direction="horizontal" size="s">
          <FormField label="Domain"><Select disabled={!!base} selectedOption={{ label: draft.domain, value: draft.domain }} options={DOMAINS.map(d => ({ label: d, value: d }))} onChange={({ detail }) => patch({ domain: String(detail.selectedOption.value) })} /></FormField>
          <FormField label={pt ? 'Nome' : 'Name'}><Input disabled={!!base} value={draft.name} onChange={({ detail }) => patch({ name: detail.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></FormField>
          <FormField label={pt ? 'Versão' : 'Version'} constraintText="v1, v2, ..." errorText={issueAt(issues.errors, '/version', pt)}>
            <Input disabled={!!base} value={draft.version ?? ''} placeholder="v1" onChange={({ detail }) => patch({ version: detail.value.trim() })} />
          </FormField>
          <FormField label="Golden path" constraintText={pt ? 'Formato GP-<letra><número>, ex.: GP-I2' : 'Format GP-<letter><number>, e.g. GP-I2'}
            description={goldenPathHint(goldenPaths, draft, pt)} errorText={issueAt(issues.errors, '/goldenPath', pt)}>
            <Autosuggest value={draft.goldenPath ?? ''} placeholder="GP-I2" enteredTextLabel={value => value}
              options={orderedGoldenPaths(goldenPaths, draft.rgdRef)} empty={pt ? 'Nenhum golden path no catálogo' : 'No golden path in the catalog'}
              onChange={({ detail }) => patch({ goldenPath: detail.value.trim().toUpperCase() })} />
          </FormField>
          <FormField label="Owner team"><Input value={draft.owner} onChange={({ detail }) => patch({ owner: detail.value })} /></FormField>
          <FormField label="Lifecycle"><Select selectedOption={{ label: draft.lifecycle, value: draft.lifecycle }} options={[{ label: 'planned', value: 'planned' }, { label: 'preview', value: 'preview' }]} onChange={({ detail }) => patch({ lifecycle: detail.selectedOption.value as ServiceDraft['lifecycle'] })} /></FormField>
        </SpaceBetween>
        <FormField label={pt ? 'Nome de exibição' : 'Display name'} stretch><Input value={draft.displayName} onChange={({ detail }) => patch({ displayName: detail.value })} /></FormField>
        <FormField label={pt ? 'Descrição' : 'Description'} stretch><Input value={draft.description} onChange={({ detail }) => patch({ description: detail.value })} /></FormField>
        <FormField label={pt ? 'Draft completo (avançado)' : 'Full draft (advanced)'} description={pt ? 'A fonte única do package. Os campos acima editam este mesmo objeto.' : 'The single source of the package. The fields above edit this same object.'} stretch>
          <Textarea rows={14} value={json} onChange={({ detail }) => { setJson(detail.value); setPreview(null); dispatch({ type: 'edit' }); }} />
        </FormField>
        <IssuesAlert errors={issues.errors} warnings={issues.warnings} pt={pt} />
        <SpaceBetween direction="horizontal" size="xs">
          <Button loading={state === 'validating'} disabled={busy} onClick={runPreview}>{pt ? 'Validar e pré-visualizar' : 'Validate and preview'}</Button>
          <Button variant="primary" disabled={!canPropose(state)} onClick={propose}>{pt ? 'Propor merge request' : 'Propose merge request'}</Button>
        </SpaceBetween>
      </SpaceBetween>
    </Container>

    {preview && <Container header={<Header variant="h2" description={preview.directory}>{pt ? 'Preview' : 'Preview'}</Header>}>
      <SpaceBetween size="l">
        {preview.policy && <PolicyVerdictView policy={preview.policy} pt={pt} />}
        {preview.provenance && <ProvenanceView provenance={preview.provenance} pt={pt} />}
        {preview.diff && <ContractDiffView diff={preview.diff} pt={pt} />}
        <Container header={<Header variant="h3" description={pt ? 'Mesmo renderer do wizard. Teste valores: nada é enviado.' : 'Same renderer as the wizard. Try values: nothing is sent.'}>{pt ? 'Formulário do consumidor' : 'Consumer form'}</Header>}>
          <SchemaFormPreview fields={fields} values={values} errors={valueErrors} pt={pt} onChange={(name, value) => setValues(v => ({ ...v, [name]: value }))} />
        </Container>
        {preview.artifacts && <ArtifactTabs artifacts={preview.artifacts} />}
      </SpaceBetween>
    </Container>}

    {request && <Alert type={state === 'failed' ? 'error' : freshness?.confidence === 'stale' && state === 'mr_open' ? 'warning' : 'info'}
      header={<StateBanner state={state} pt={pt} confidence={state === 'mr_open' ? freshness?.confidence : undefined} />}
      action={['requested', 'processing', 'mr_open'].includes(state) ? <Button onClick={checkAgain}>{pt ? 'Verificar de novo' : 'Check again'}</Button> : undefined}>
      <SpaceBetween size="xxs">
        <span>{pt ? `Pedido ${request.requestId} para ${request.path}.` : `Request ${request.requestId} for ${request.path}.`}</span>
        {state === 'mr_open' && freshness && !!requestStatusNote(freshness.confidence, freshness.ageSeconds, pt) && <span>{requestStatusNote(freshness.confidence, freshness.ageSeconds, pt)}</span>}
        {!!request.mrUrl && <Link href={request.mrUrl} external>{request.mrUrl}</Link>}
        {!!request.error && <span>{request.error}</span>}
      </SpaceBetween>
    </Alert>}
  </SpaceBetween>;
}
