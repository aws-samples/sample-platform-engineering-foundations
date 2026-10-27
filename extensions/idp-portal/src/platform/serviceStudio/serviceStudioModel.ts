// Service Owner Studio model: draft types, the execution state machine and the deterministic
// imports (existing RGD, CRD/ACK resource, catalog package) that give a starting point with no model.
//
// None of this validates policy. Imports only TRANSLATE a document into a ServiceDraft; the
// server validator (backend/service_studio) decides what is allowed, so a CRD that exposes a
// roleArn becomes a draft the preview refuses with `iam_field`, never a draft silently trimmed.
import { parse } from 'yaml';
import type { CapabilitySchema } from './schemaForm';

export const SCHEMA_VERSION = 'service-draft/v1';
export type FieldType = 'string' | 'integer' | 'boolean' | 'stringMap' | 'stringList';
export type StudioOp = 'create' | 'evolve' | 'deprecate' | 'retire';
export type DraftOrigin = 'form' | 'model' | 'import-rgd' | 'import-crd' | 'catalog';

export interface DraftField {
  name: string; type: FieldType; title?: string; description?: string; required?: boolean;
  default?: unknown; enum?: string[]; pattern?: string; minimum?: number; maximum?: number; example?: unknown;
}

export interface ServiceDraft {
  schemaVersion: string; domain: string; name: string; version: string;
  displayName: string; displayNamePt?: string; description: string; descriptionPt?: string;
  owner: string; engine: 'ack' | 'kro'; pattern: string; lifecycle: 'planned' | 'preview';
  goldenPath: string; rgdRef?: string; requires?: string[]; fields: DraftField[];
  docs?: { overview?: string; usage?: string };
}

export interface StudioIssue { path: string; code: string; message: string; messagePt?: string }

export interface ContractDiff {
  op: 'create' | 'evolve';
  fieldsAdded: string[]; fieldsRemoved: string[];
  fieldsChanged: { name: string; changes: { key: string; before: unknown; after: unknown }[] }[];
  metadataChanged: { key: string; before: unknown; after: unknown }[];
}

export interface PolicyVerdict { verdict: 'standard_review' | 'elevated_review'; reasons: string[]; humanReviewRequired: true }

export interface Provenance {
  requester: string; owner: string; origin: DraftOrigin; sources: string[];
  compiler: string; draftSha256: string; baseSource: 'client' | null;
}

export interface PreviewResponse {
  state: 'previewed' | 'invalid' | 'unauthorized';
  valid: boolean; errors: StudioIssue[]; warnings: StudioIssue[];
  draft?: ServiceDraft; draftSha256?: string; compiler?: string; directory?: string;
  artifacts?: Record<string, string>; form?: CapabilitySchema; diff?: ContractDiff;
  policy?: PolicyVerdict; provenance?: Provenance;
}

export type RequestStatus = 'pending' | 'processing' | 'mr_open' | 'merged' | 'closed' | 'failed';

// ------------------------------------------------------------------ execution state machine
export type StudioState =
  | 'draft' | 'generating' | 'proposed' | 'validating' | 'invalid' | 'unauthorized' | 'previewed'
  | 'requested' | 'processing' | 'mr_open' | 'merged' | 'closed' | 'failed';

export type StudioEvent =
  | { type: 'edit' } | { type: 'generate' } | { type: 'generated'; valid: boolean } | { type: 'generationFailed' }
  | { type: 'preview' } | { type: 'previewed'; state: PreviewResponse['state'] } | { type: 'previewFailed' }
  | { type: 'propose' } | { type: 'requestFailed' } | { type: 'status'; status: RequestStatus }
  /** O pedido relido do servidor no mount de `#studio/<requestId>` (reload, deep link). */
  | { type: 'restored'; status: RequestStatus };

const TERMINAL: StudioState[] = ['merged', 'closed', 'failed'];

/**
 * Pure transition. Two rules carry the governance: you can only `propose` from `previewed`
 * (nothing reaches the MR queue that the user did not see compiled), and any `edit` after the
 * preview goes back to `draft`, so a proposal is always of the bytes last reviewed.
 */
export function transition(state: StudioState, event: StudioEvent): StudioState {
  // O servidor é a fonte do pedido restaurado: vale em qualquer estado local.
  if (event.type === 'restored') return event.status === 'pending' ? 'requested' : event.status;
  if (TERMINAL.includes(state) && event.type !== 'edit') return state;
  switch (event.type) {
    case 'edit': return ['requested', 'processing', 'mr_open'].includes(state) ? state : 'draft';
    case 'generate': return ['generating', 'validating', 'requested', 'processing', 'mr_open'].includes(state) ? state : 'generating';
    case 'generated': return state === 'generating' ? (event.valid ? 'proposed' : 'invalid') : state;
    case 'generationFailed': return state === 'generating' ? 'failed' : state;
    case 'preview': return ['draft', 'proposed', 'invalid', 'previewed', 'unauthorized'].includes(state) ? 'validating' : state;
    case 'previewed': return state === 'validating' ? event.state : state;
    case 'previewFailed': return state === 'validating' ? 'draft' : state;
    case 'propose': return state === 'previewed' ? 'requested' : state;
    case 'requestFailed': return state === 'requested' ? 'previewed' : state;
    case 'status':
      if (!['requested', 'processing', 'mr_open'].includes(state)) return state;
      return event.status === 'pending' ? 'requested' : event.status;
  }
}

export function canPropose(state: StudioState): boolean { return state === 'previewed'; }
export function isBusy(state: StudioState): boolean { return state === 'generating' || state === 'validating'; }

// ------------------------------------------------------------------ deterministic imports
const KRO_TYPES: Record<string, FieldType> = {
  string: 'string', integer: 'integer', boolean: 'boolean', 'map[string]string': 'stringMap', '[]string': 'stringList',
};

function kroField(name: string, raw: unknown): DraftField | null {
  const text = String(raw ?? '').trim();
  const bar = text.indexOf('|');
  const head = (bar < 0 ? text : text.slice(0, bar)).trim();
  const type = KRO_TYPES[head];
  if (!type) return null;
  const field: DraftField = { name, type };
  const marker = bar < 0 ? '' : text.slice(bar + 1).trim();
  if (marker.startsWith('default=')) {
    try { field.default = JSON.parse(marker.slice('default='.length)); } catch { return null; }
  } else if (type !== 'stringMap' && type !== 'stringList') {
    field.required = true;
  }
  return field;
}

export interface ImportResult { fields: DraftField[]; skipped: string[]; kind: string; source: string }

/** Starting point from an existing kro RGD: the form asks for exactly what the composition accepts. */
export function importFromRgd(text: string, ref: string): ImportResult {
  const doc = parse(text) as { kind?: string; spec?: { schema?: { kind?: string; spec?: Record<string, unknown> } } };
  if (doc?.kind !== 'ResourceGraphDefinition' || !doc.spec?.schema?.spec) throw new Error('not a ResourceGraphDefinition with spec.schema.spec');
  const fields: DraftField[] = [];
  const skipped: string[] = [];
  for (const [name, raw] of Object.entries(doc.spec.schema.spec)) {
    const field = kroField(name, raw);
    if (field) fields.push(field); else skipped.push(name);
  }
  return { fields: withExamples(fields), skipped, kind: String(doc.spec.schema.kind ?? ''), source: `import:${ref}` };
}

interface OpenApiProp { type?: string; description?: string; enum?: unknown[]; default?: unknown; minimum?: number; maximum?: number; pattern?: string; additionalProperties?: { type?: string }; items?: { type?: string } }

/** Starting point from a CRD (an ACK CRD included): top-level scalar inputs of the served version's spec. */
export function importFromCrd(text: string): ImportResult {
  const doc = parse(text) as { kind?: string; spec?: { names?: { kind?: string }; versions?: { served?: boolean; storage?: boolean; schema?: { openAPIV3Schema?: { properties?: { spec?: { required?: string[]; properties?: Record<string, OpenApiProp> } } } } }[] } };
  if (doc?.kind !== 'CustomResourceDefinition') throw new Error('not a CustomResourceDefinition');
  const versions = doc.spec?.versions ?? [];
  const version = versions.find(v => v.storage) ?? versions.find(v => v.served) ?? versions[0];
  const spec = version?.schema?.openAPIV3Schema?.properties?.spec;
  if (!spec?.properties) throw new Error('CRD has no spec properties');
  const required = new Set(spec.required ?? []);
  const fields: DraftField[] = [];
  const skipped: string[] = [];
  for (const [name, prop] of Object.entries(spec.properties)) {
    const type: FieldType | null = prop.type === 'string' ? 'string' : prop.type === 'integer' ? 'integer' : prop.type === 'boolean' ? 'boolean'
      : prop.type === 'object' && prop.additionalProperties?.type === 'string' ? 'stringMap'
        : prop.type === 'array' && prop.items?.type === 'string' ? 'stringList' : null;
    if (!type) { skipped.push(name); continue; }
    const field: DraftField = { name, type };
    if (required.has(name)) field.required = true;
    if (prop.description) field.description = prop.description.split('\n')[0].slice(0, 200).trim();
    if (type === 'string' && Array.isArray(prop.enum)) field.enum = prop.enum.map(String);
    if (prop.default !== undefined) field.default = prop.default;
    if (type === 'integer' && typeof prop.minimum === 'number') field.minimum = prop.minimum;
    if (type === 'integer' && typeof prop.maximum === 'number') field.maximum = prop.maximum;
    fields.push(field);
  }
  if (!fields.some(f => f.name === 'name')) fields.unshift({ name: 'name', type: 'string', required: true });
  return { fields: withExamples(fields), skipped, kind: String(doc.spec?.names?.kind ?? ''), source: 'import:crd' };
}

function withExamples(fields: DraftField[]): DraftField[] {
  return fields.map(f => {
    if (!f.required || f.default !== undefined || f.example !== undefined) return f;
    if (f.name === 'name') return { ...f, example: 'example' };
    if (f.type === 'string') return { ...f, example: f.enum?.[0] ?? 'example' };
    if (f.type === 'integer') return { ...f, example: f.minimum ?? 1 };
    if (f.type === 'boolean') return { ...f, example: false };
    return f;
  });
}

interface CapabilityDoc { metadata: { name: string; domain: string; version: string }; spec: Record<string, unknown> }

/** The draft an existing catalog package means: the base of `evolve`, and its diff. Mirrors publish.draft_from_package. */
export function draftFromPackage(capabilityYaml: string, schema: CapabilitySchema): ServiceDraft {
  const doc = parse(capabilityYaml) as CapabilityDoc;
  const spec = doc.spec;
  const required = new Set(schema.required ?? []);
  const typeOf: Record<string, FieldType> = { string: 'string', integer: 'integer', boolean: 'boolean', object: 'stringMap', array: 'stringList' };
  const fields = Object.entries(schema.properties ?? {}).map(([name, prop]) => {
    const field: DraftField = { name, type: typeOf[String(prop.type)] ?? (String(prop.type) as FieldType) };
    for (const key of ['title', 'description', 'enum', 'minimum', 'maximum', 'default'] as const) {
      if (prop[key] !== undefined) (field as unknown as Record<string, unknown>)[key] = prop[key];
    }
    const pattern = prop.pattern;
    if (pattern && !(name === 'name' && pattern === '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')) {
      field.pattern = pattern.startsWith('^(?:') && pattern.endsWith(')$') ? pattern.slice(4, -2) : pattern;
    }
    if (Array.isArray(prop.examples) && prop.examples.length) field.example = prop.examples[0];
    field.required = required.has(name);
    return field;
  });
  const draft: ServiceDraft = {
    schemaVersion: SCHEMA_VERSION, domain: doc.metadata.domain, name: doc.metadata.name, version: doc.metadata.version,
    displayName: String(spec.displayName), description: String(spec.description), owner: String(spec.owner),
    engine: spec.engine as ServiceDraft['engine'], pattern: String(spec.pattern), lifecycle: spec.lifecycle as ServiceDraft['lifecycle'],
    goldenPath: String(spec.goldenPath ?? ''), fields,
  };
  if (spec.displayNamePt) draft.displayNamePt = String(spec.displayNamePt);
  if (spec.descriptionPt) draft.descriptionPt = String(spec.descriptionPt);
  if (spec.rgdRef) draft.rgdRef = String(spec.rgdRef);
  const requires = (spec.relations as { requires?: string[] } | undefined)?.requires ?? [];
  if (requires.length) draft.requires = [...requires];
  return draft;
}

export function emptyDraft(owner = 'platform-team'): ServiceDraft {
  return {
    schemaVersion: SCHEMA_VERSION, domain: 'storage', name: '', version: 'v1', displayName: '', description: '',
    owner, engine: 'ack', pattern: '', lifecycle: 'planned', goldenPath: 'GP-I1',
    fields: [{ name: 'name', type: 'string', required: true, example: 'example' }],
  };
}

/** Pt-BR or en-US message of an issue, with the JSON Pointer so the user finds the field. */
export function issueText(issue: StudioIssue, pt: boolean): string {
  const message = (pt && issue.messagePt) || issue.message || issue.code;
  const where = issue.path ? ` ${pt ? 'em' : 'at'} ${issue.path}` : '';
  return `${message} (${issue.code}${where})`;
}

/** Prazo do polling de um pedido: aba esquecida para de perguntar depois disto. */
export const POLL_BOUND_MS = 30 * 60 * 1000;
export interface PollStart { requestId: string; at: number }

/** Início do polling: o mesmo enquanto o requestId é o mesmo, novo só quando ele muda. */
export function pollStart(previous: PollStart | null, requestId: string, now: number): PollStart {
  return previous && previous.requestId === requestId ? previous : { requestId, at: now };
}

// ------------------------------------------------------------------ freshness of the request status
/**
 * Até quando um "MR aberto" conta como confirmado: duas rodadas do sweep do CI (`*\/15`) e folga.
 *
 * O status vive no DynamoDB e quem o atualiza é o sweep do CI, o único ator que lê o GitLab (a
 * platform-api não alcança a API do GitLab, e o browser nunca recebe token). Medido em 2026-10-22:
 * o MR !45 foi fechado às 08:30:45Z e o sweep das 08:33Z gravou `closed`; a tela seguiu dizendo
 * "aberto" porque o polling já tinha parado no prazo de 30 min. Então a tela não afirma o que não
 * foi reconfirmado: passou disto, o estado é "última leitura", não "aberto".
 */
export const STATUS_STALE_SECONDS = 35 * 60;

export type StatusConfidence = 'final' | 'queue' | 'confirmed' | 'stale';
export interface StatusReading { status: RequestStatus; statusAgeSeconds?: number | null }

/**
 * Quanto a tela pode afirmar sobre o status lido. `statusAgeSeconds` vem do servidor (idade do
 * último carimbo do CI no instante da leitura); somar o tempo desde a leitura dispensa o relógio
 * do browser. `mr_open` sem carimbo nunca foi reconfirmado e por isso é `stale`, não "aberto".
 */
export function statusConfidence(reading: StatusReading, readAtMs: number, nowMs: number): { confidence: StatusConfidence; ageSeconds: number | null } {
  if (reading.status === 'merged' || reading.status === 'closed' || reading.status === 'failed') return { confidence: 'final', ageSeconds: null };
  if (reading.status !== 'mr_open') return { confidence: 'queue', ageSeconds: null };
  const base = reading.statusAgeSeconds;
  if (typeof base !== 'number' || !Number.isFinite(base)) return { confidence: 'stale', ageSeconds: null };
  const ageSeconds = Math.max(0, Math.round(base + Math.max(0, nowMs - readAtMs) / 1000));
  return { confidence: ageSeconds > STATUS_STALE_SECONDS ? 'stale' : 'confirmed', ageSeconds };
}

/** "há 3 min" / "3 min ago", arredondado para baixo; abaixo de 1 min, "agora". */
export function ageText(ageSeconds: number, pt: boolean): string {
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 1) return pt ? 'agora' : 'just now';
  if (minutes < 120) return pt ? `há ${minutes} min` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return pt ? `há ${hours} h` : `${hours} h ago`;
}

// ------------------------------------------------------------------ metadata the form asks for
/** O erro do contrato num caminho exato (`/version`, `/goldenPath`), para o input mostrar onde está. */
export function issueAt(issues: StudioIssue[], path: string, pt: boolean): string | undefined {
  const found = issues.find(issue => issue.path === path);
  return found ? issueText(found, pt) : undefined;
}

export interface GoldenPathOption { value: string; label: string; rgdRefs: string[] }
const GOLDEN_PATH = /^GP-[A-Z][0-9]{1,2}$/;

/**
 * Os golden paths que o catálogo já usa, com quem os usa. Só códigos que passam no contrato
 * (`GP-A` sem número fica de fora): sugerir um valor que o validator recusa seria pior que nada.
 */
export function goldenPathOptions(capabilityYamls: string[]): GoldenPathOption[] {
  const byCode = new Map<string, { ids: string[]; rgdRefs: string[] }>();
  for (const text of capabilityYamls) {
    let doc: { metadata?: { name?: string; domain?: string }; spec?: { goldenPath?: unknown; rgdRef?: unknown } };
    try { doc = parse(text) as typeof doc; } catch { continue; }
    const code = String(doc?.spec?.goldenPath ?? '');
    if (!GOLDEN_PATH.test(code)) continue;
    const entry = byCode.get(code) ?? { ids: [], rgdRefs: [] };
    entry.ids.push(`${doc.metadata?.domain}/${doc.metadata?.name}`);
    if (doc.spec?.rgdRef) entry.rgdRefs.push(String(doc.spec.rgdRef));
    byCode.set(code, entry);
  }
  return [...byCode.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([value, entry]) => ({ value, label: `${value} (${entry.ids.sort().join(', ')})`, rgdRefs: entry.rgdRefs }));
}

/** O golden path da capability que já compõe o mesmo RGD: a sugestão, nunca um preenchimento. */
export function suggestedGoldenPath(options: GoldenPathOption[], rgdRef: string | undefined): string {
  if (!rgdRef) return '';
  return options.find(option => option.rgdRefs.includes(rgdRef))?.value ?? '';
}
