import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import schemaRaw from '../../../tests/fixtures/service-studio/orders-table.schema.json?raw';
import draftRaw from '../../../tests/fixtures/service-studio/orders-table.draft.json?raw';
import baseRaw from '../../../tests/fixtures/service-studio/dynamodb-v1.base.json?raw';
import dynamoRgd from '../../../platform/compositions/dynamodb-table-rgd.yaml?raw';
import dynamoCapability from '../../../platform/catalog/database/dynamodb/v1/capability.yaml?raw';
import dynamoSchema from '../../../platform/catalog/database/dynamodb/v1/schema.json?raw';
import { formModelFromSchema, initialValues, validateValues } from './schemaForm';
import studioSource from './ServiceOwnerStudio.tsx?raw';
import {
  ageText, canPropose, draftFromPackage, goldenPathOptions, importFromCrd, importFromRgd, issueAt, pollStart, STATUS_STALE_SECONDS,
  statusConfidence, suggestedGoldenPath, transition, StudioState,
} from './serviceStudioModel';
import { ROUTES, serviceStudioApi, Transport } from './serviceStudioApi';
import { ContractDiffView, IssuesAlert, PolicyVerdictView, requestStatusNote, SchemaFormPreview, StateBanner } from './ServiceStudioParts';
import { ServiceOwnerStudio } from './ServiceOwnerStudio';
import { I18nProvider } from '../i18n';

const schema = JSON.parse(schemaRaw);
const draft = JSON.parse(draftRaw);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const originalError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return;
    originalError(...args);
  });
});
afterAll(() => vi.restoreAllMocks());

describe('schema -> form model (renderer shared with the wizard)', () => {
  const fields = formModelFromSchema(schema);

  it('maps the compiled schema to controls, in schema order', () => {
    expect(fields.map(f => [f.name, f.control, f.required])).toEqual([
      ['name', 'text', true], ['hashKeyName', 'text', false], ['hashKeyType', 'select', false], ['environment', 'select', false],
    ]);
    expect(fields[0].placeholder).toBe('orders');
    expect(initialValues(fields)).toEqual({ hashKeyName: 'id', hashKeyType: 'N', environment: 'dev' });
  });

  it('validates values with the same rules as the schema, and refuses unknown keys', () => {
    expect(validateValues(fields, { ...initialValues(fields), name: 'orders' })).toEqual([]);
    expect(validateValues(fields, {})).toEqual([{ name: 'name', code: 'required' }]);
    expect(validateValues(fields, { name: 'Orders!', environment: 'qa', roleArn: 'arn:aws:iam::1:role/x' })).toEqual([
      { name: 'roleArn', code: 'unknown_field' }, { name: 'name', code: 'pattern' }, { name: 'environment', code: 'enum' },
    ]);
  });

  it('an unknown property type renders as unsupported, never as a free text box', () => {
    const odd = formModelFromSchema({ properties: { blob: { type: 'number' } } });
    expect(odd[0].control).toBe('unsupported');
    expect(validateValues(odd, { blob: 1 })).toEqual([{ name: 'blob', code: 'type' }]);
  });

  it('renders every field label, the required marker and the pattern', () => {
    const t = text(renderToStaticMarkup(<SchemaFormPreview fields={fields} values={initialValues(fields)} pt />));
    for (const label of ['Table name', 'Partition key', 'Partition key type', 'Environment']) expect(t).toContain(label);
    expect(t).toContain('obrigatório');
    expect(t).toContain('Formato: ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$');
  });
});

describe('execution state machine', () => {
  const run = (events: Parameters<typeof transition>[1][], from: StudioState = 'draft') => events.reduce(transition, from);

  it('proposing is only possible from a fresh preview', () => {
    expect(canPropose(run([{ type: 'preview' }, { type: 'previewed', state: 'previewed' }]))).toBe(true);
    expect(run([{ type: 'propose' }])).toBe('draft');
    expect(run([{ type: 'preview' }, { type: 'previewed', state: 'invalid' }, { type: 'propose' }])).toBe('invalid');
    expect(run([{ type: 'preview' }, { type: 'previewed', state: 'unauthorized' }, { type: 'propose' }])).toBe('unauthorized');
  });

  it('an edit after the preview drops it, so the proposal is always of the reviewed bytes', () => {
    expect(run([{ type: 'preview' }, { type: 'previewed', state: 'previewed' }, { type: 'edit' }])).toBe('draft');
  });

  it('model proposals go through the preview too, and the CI status drives the rest', () => {
    expect(run([{ type: 'generate' }, { type: 'generated', valid: true }])).toBe('proposed');
    expect(run([{ type: 'generate' }, { type: 'generated', valid: false }])).toBe('invalid');
    const requested = run([{ type: 'preview' }, { type: 'previewed', state: 'previewed' }, { type: 'propose' }]);
    expect(requested).toBe('requested');
    expect(run([{ type: 'status', status: 'processing' }, { type: 'status', status: 'mr_open' }, { type: 'status', status: 'merged' }], requested)).toBe('merged');
    expect(run([{ type: 'status', status: 'mr_open' }, { type: 'edit' }], requested)).toBe('mr_open');
    expect(run([{ type: 'generate' }], 'merged')).toBe('merged');
  });
});

describe('deterministic imports', () => {
  it('an RGD import asks for exactly what the composition accepts', () => {
    const imported = importFromRgd(dynamoRgd, 'platform/compositions/dynamodb-table-rgd.yaml');
    expect(imported.kind).toBe('DynamoDBTable');
    expect(imported.fields).toEqual([
      { name: 'name', type: 'string', required: true, example: 'example' },
      { name: 'hashKeyName', type: 'string', default: 'id' },
      { name: 'hashKeyType', type: 'string', default: 'N' },
      { name: 'environment', type: 'string', default: 'dev' },
    ]);
  });

  it('a CRD import keeps scalar inputs and reports what it skipped', () => {
    const crd = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
spec:
  names: {kind: Queue}
  versions:
    - name: v1alpha1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          properties:
            spec:
              required: [queueName]
              properties:
                queueName: {type: string, description: "Queue name.\\nMore text"}
                delaySeconds: {type: integer, minimum: 0, maximum: 900}
                fifoQueue: {type: boolean}
                tags: {type: object, additionalProperties: {type: string}}
                redrivePolicy: {type: object, properties: {maxReceiveCount: {type: integer}}}
`;
    const imported = importFromCrd(crd);
    expect(imported.kind).toBe('Queue');
    expect(imported.skipped).toEqual(['redrivePolicy']);
    expect(imported.fields.map(f => f.name)).toEqual(['name', 'queueName', 'delaySeconds', 'fifoQueue', 'tags']);
    expect(imported.fields[1]).toEqual({ name: 'queueName', type: 'string', required: true, description: 'Queue name.', example: 'example' });
    expect(() => importFromCrd('kind: Deployment')).toThrow();
  });

  it('a catalog package rebuilds into the same draft the Python CI rebuilds (shared fixture)', () => {
    expect(draftFromPackage(dynamoCapability, JSON.parse(dynamoSchema))).toEqual(JSON.parse(baseRaw));
  });
});

describe('API client', () => {
  const recorder = () => {
    const calls: { base: string; path: string; body: unknown }[] = [];
    const transport: Transport = async (base, path, init) => {
      calls.push({ base, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return { state: 'requested', requestId: 'a'.repeat(32), status: 'pending' };
    };
    return { calls, api: serviceStudioApi(transport) };
  };

  it('never sends compiled artifacts, a manifest, a requester or model tools', async () => {
    const { calls, api } = recorder();
    await api.generate('make a table', 'pt-BR');
    await api.preview({ op: 'create', draft, origin: 'model', sources: ['s3://kb/a.md'] });
    await api.request({ op: 'create', draft, origin: 'model', sources: [], previewSha256: 'f'.repeat(64) });
    expect(calls.map(c => [c.base, c.path])).toEqual([['bff', ROUTES.generate], ['platform', ROUTES.preview], ['platform', ROUTES.request]]);
    for (const call of calls) {
      for (const key of ['manifest', 'artifacts', 'files', 'requester', 'tools', 'tool_choice', 'functions']) expect(call.body).not.toHaveProperty(key);
    }
    expect(calls[2].body).toMatchObject({ kind: 'service-capability', previewSha256: 'f'.repeat(64) });
  });

  it('refuses a malformed request id before calling anything', async () => {
    const { calls, api } = recorder();
    await expect(api.status('../../admin')).rejects.toThrow('invalid request id');
    expect(calls).toEqual([]);
  });
});

describe('Studio DOM', () => {
  it('verdict, diff and issues are readable without color', () => {
    const verdict = text(renderToStaticMarkup(<PolicyVerdictView pt policy={{ verdict: 'elevated_review', reasons: ['makes the capability provisionable (preview)'], humanReviewRequired: true }} />));
    expect(verdict).toContain('Review elevado: platform reviewer obrigatório');
    expect(verdict).toContain('⚠ makes the capability provisionable (preview)');
    const diff = text(renderToStaticMarkup(<ContractDiffView pt diff={{ op: 'evolve', fieldsAdded: ['ttl'], fieldsRemoved: [], fieldsChanged: [{ name: 'environment', changes: [{ key: 'enum', before: ['dev'], after: ['dev', 'prod'] }] }], metadataChanged: [] }} />));
    expect(diff).toContain('+ Campos adicionados (1) ttl');
    expect(diff).toContain('~ environment.enum: ["dev"] → ["dev","prod"]');
    const issues = text(renderToStaticMarkup(<IssuesAlert pt warnings={[]} errors={[{ path: '/fields/4/name', code: 'iam_field', message: 'IAM.', messagePt: 'IAM é escolhido pela policy.' }]} />));
    expect(issues).toContain('Bloqueado: 1 erro(s)');
    expect(issues).toContain('IAM é escolhido pela policy. (iam_field em /fields/4/name)');
  });

  it('the page renders isolated, with an injected API, and starts unable to propose', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'en-US', setItem: () => undefined });
    const api = serviceStudioApi(async () => ({}));
    const html = renderToStaticMarkup(<I18nProvider><ServiceOwnerStudio api={api} startingPoints={[]} /></I18nProvider>);
    vi.unstubAllGlobals();
    const t = text(html);
    expect(t).toContain('Service Owner Studio');
    expect(t).toContain('Propose merge request');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Propose merge request/s);
  });
});

/* -------------------------------------------------------------------------- */
/* Finding live 2 (2026-10-22): MR !45 fechado, a tela seguia dizendo "aberto" */
/* -------------------------------------------------------------------------- */
describe('request status freshness: the page never asserts an MR open that the CI did not reconfirm', () => {
  const T0 = 1_000_000_000_000;

  it('mr_open recently stamped by the CI is confirmed, and the age keeps growing after the read', () => {
    expect(statusConfidence({ status: 'mr_open', statusAgeSeconds: 60 }, T0, T0)).toEqual({ confidence: 'confirmed', ageSeconds: 60 });
    // O mesmo carimbo, lido há 40 min e nunca relido (o polling parou): deixou de ser confirmação.
    expect(statusConfidence({ status: 'mr_open', statusAgeSeconds: 60 }, T0, T0 + 40 * 60_000)).toEqual({ confidence: 'stale', ageSeconds: 2460 });
    // Fronteira exata: até STATUS_STALE_SECONDS ainda vale.
    expect(statusConfidence({ status: 'mr_open', statusAgeSeconds: STATUS_STALE_SECONDS }, T0, T0).confidence).toBe('confirmed');
    expect(statusConfidence({ status: 'mr_open', statusAgeSeconds: STATUS_STALE_SECONDS + 1 }, T0, T0).confidence).toBe('stale');
  });

  it('mr_open never stamped (old request) is stale, not open', () => {
    expect(statusConfidence({ status: 'mr_open', statusAgeSeconds: null }, T0, T0)).toEqual({ confidence: 'stale', ageSeconds: null });
    expect(statusConfidence({ status: 'mr_open' }, T0, T0).confidence).toBe('stale');
  });

  it('terminal and queue states are not graded by the MR stamp', () => {
    for (const status of ['merged', 'closed', 'failed'] as const) expect(statusConfidence({ status, statusAgeSeconds: 99_999 }, T0, T0).confidence).toBe('final');
    for (const status of ['pending', 'processing'] as const) expect(statusConfidence({ status }, T0, T0).confidence).toBe('queue');
  });

  it('a stale mr_open banner says "last read", with a warning icon, and never "open for review"', () => {
    const stale = text(renderToStaticMarkup(<StateBanner state="mr_open" pt confidence="stale" />));
    expect(stale).toContain('Último estado lido: MR aberto, não reconfirmado');
    expect(stale).not.toContain('aberto para review');
    expect(renderToStaticMarkup(<StateBanner state="mr_open" pt confidence="stale" />)).toContain('warning');
    // Controle: confirmado continua dizendo aberto, e closed continua dizendo fechado.
    expect(text(renderToStaticMarkup(<StateBanner state="mr_open" pt confidence="confirmed" />))).toContain('Merge request aberto para review');
    expect(text(renderToStaticMarkup(<StateBanner state="closed" pt />))).toContain('Fechado sem merge');
  });

  it('the note says when the CI confirmed it, or that it was not confirmed and what to do', () => {
    expect(requestStatusNote('confirmed', 180, true)).toBe('Confirmado pelo CI há 3 min. O próximo sweep agendado reconfere.');
    // Nenhuma frequência fixa prometida: o schedule efetivo não é um intervalo exato.
    expect(requestStatusNote('confirmed', 180, false)).not.toMatch(/every \d+ min|a cada \d+ min/);
    expect(requestStatusNote('stale', 2460, false)).toContain('last confirmed by CI 41 min ago: the MR may have been closed or merged');
    expect(requestStatusNote('stale', null, true)).toContain('nunca reconfirmado pelo CI');
    expect(requestStatusNote('final', null, true)).toBe('');
    expect([ageText(30, true), ageText(7300, false)]).toEqual(['agora', '2 h ago']);
  });

  it('a new poll epoch opens a new 30-minute window for the same request', () => {
    const first = pollStart(null, `${'a'.repeat(32)}#0`, 1);
    expect(pollStart(first, `${'a'.repeat(32)}#0`, 999)).toBe(first);
    expect(pollStart(first, `${'a'.repeat(32)}#1`, 999)).toEqual({ requestId: `${'a'.repeat(32)}#1`, at: 999 });
  });

  it('the page wires the re-read: visibility, "Check again", a new epoch and the confidence on the banner', () => {
    const code = studioSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    expect(code).toContain("addEventListener('visibilitychange'");
    expect(code).toContain("removeEventListener('visibilitychange'");
    expect(code).toContain('`${request.requestId}#${pollEpoch}`');
    expect(code).toContain('onClick={checkAgain}');
    expect(code).toContain('confidence={state === \'mr_open\' ? freshness?.confidence : undefined}');
    // E o browser continua sem token do GitLab: o status vem só da platform-api.
    expect(code).not.toMatch(/gitlab\.aws\.dev\/api|PRIVATE-TOKEN|glpat-/);
  });
});

/* -------------------------------------------------------------------------- */
/* Finding live 3 (2026-10-22): Bedrock omitiu version e goldenPath            */
/* -------------------------------------------------------------------------- */
describe('version and goldenPath are form fields, the contract keeps blocking without them', () => {
  const capabilityYamls = Object.values(import.meta.glob('../../../platform/catalog/**/capability.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>);
  const options = goldenPathOptions(capabilityYamls);

  it('offers the golden paths the catalog uses, only codes the contract accepts', () => {
    expect(options.length).toBeGreaterThan(0);
    expect(options.every(option => /^GP-[A-Z][0-9]{1,2}$/.test(option.value))).toBe(true);
    // `GP-A` e `GP-B` existem no catálogo sem número: o validator recusaria, então não são sugeridos.
    expect(options.map(option => option.value)).not.toContain('GP-A');
    expect(options.find(option => option.value === 'GP-I2')?.label).toBe('GP-I2 (database/dynamodb)');
  });

  it('suggests the golden path of the capability that composes the same RGD, never a guess', () => {
    expect(suggestedGoldenPath(options, 'platform/compositions/dynamodb-table-rgd.yaml')).toBe('GP-I2');
    expect(suggestedGoldenPath(options, 'platform/compositions/no-such-rgd.yaml')).toBe('');
    expect(suggestedGoldenPath(options, undefined)).toBe('');
  });

  it('shows the contract error on the input of the path it belongs to', () => {
    const errors = [{ path: '/version', code: 'required', message: 'Field is required.', messagePt: 'O campo é obrigatório.' }];
    expect(issueAt(errors, '/version', true)).toBe('O campo é obrigatório. (required em /version)');
    expect(issueAt(errors, '/goldenPath', true)).toBeUndefined();
  });

  it('the Golden path input receives the errorText of the contract issue at /goldenPath', () => {
    // Os dois erros que o validator do backend emite para goldenPath (service_studio.validator).
    const pattern = [{ path: '/goldenPath', code: 'pattern', message: 'Value does not match the required format.', messagePt: 'O valor não casa com o formato exigido.' }];
    const required = [{ path: '/goldenPath', code: 'required', message: 'Field is required.', messagePt: 'O campo é obrigatório.' }];
    expect(issueAt(pattern, '/goldenPath', true)).toBe('O valor não casa com o formato exigido. (pattern em /goldenPath)');
    expect(issueAt(required, '/goldenPath', false)).toContain('Field is required.');
    expect(issueAt(pattern, '/version', true)).toBeUndefined();
    // E a ligação é a do campo Golden path, não outra: o FormField dele lê exatamente esse path.
    const field = studioSource.slice(studioSource.indexOf("label=\"Golden path\""));
    expect(field.slice(0, field.indexOf('</FormField>'))).toContain("errorText={issueAt(issues.errors, '/goldenPath', pt)}");
  });

  it('the draft card renders Version and Golden path inputs, so no one edits the JSON for them', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'pt-BR', setItem: () => undefined });
    const html = renderToStaticMarkup(<I18nProvider><ServiceOwnerStudio api={serviceStudioApi(async () => ({}))} startingPoints={[]} goldenPaths={options} /></I18nProvider>);
    vi.unstubAllGlobals();
    const t = text(html).replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    expect(t).toContain('Versão');
    expect(t).toContain('Golden path');
    expect(t).toContain('Formato GP-<letra><número>, ex.: GP-I2');
    // O Studio não preenche goldenPath sozinho: o default do draft vazio é o que o Dev vê e troca.
    expect(html).toContain('value="GP-I1"');
  });
});
