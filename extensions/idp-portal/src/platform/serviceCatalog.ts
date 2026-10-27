/*
 * Service Catalog model (issue #7). The catalog is the entry point of the platform, so every
 * list here is DERIVED: capabilities come from platform/catalog/**\/capability.yaml through
 * catalogLoader, and the added/available state comes from the LIVE capability counts the
 * cluster-api reports (`GET /cluster/capabilities?counts=true`). Nothing in this file hardcodes a
 * capability, a category or a deployed flag.
 *
 * Why the count comes from the cluster and not from the AWS Tagging API: a tagged ARN proves an
 * AWS resource exists, not that the platform capability is installed and listable. The two
 * disagree in both directions - a kro capability with no AWS resource at all (inference-eks) is
 * added, and a leftover tagged ARN from a deleted instance is not. The cluster-api counts the
 * objects the service page then lists, so the badge and the page can no longer disagree.
 */
import { Capability, capabilities } from './catalogLoader';
import { listPath } from './kdpInventoryModel';

/**
 * `added` is not a lifecycle: it means the platform found at least one live instance of the
 * capability. `unknown` is not a lifecycle either: it means the live read did not answer, and the
 * UI must say so instead of falling back to the file lifecycle - falling back is what used to
 * paint every service "Available" the moment the API failed. The other four mirror the capability
 * lifecycle declared in its YAML.
 */
export type ServiceState = 'added' | 'available' | 'preview' | 'planned' | 'deprecated' | 'unknown';
export type ViewMode = 'grid' | 'table';
export type SortField = 'name' | 'category' | 'state' | 'instances';

/** Rank for sorting and for "most useful first": what you can use now comes before what you cannot. */
const STATE_ORDER: Record<ServiceState, number> = { added: 0, available: 1, preview: 2, unknown: 3, planned: 4, deprecated: 5 };

export interface ServiceEntry {
  id: string;
  /**
   * The capability identity in the cluster (the RGD `metadata.name`). Routes, live counts and the
   * reverse Create lookup all key off this, never off `id`.
   */
  liveCapability: string;
  /** Category shown in the UI and in the facets; the capability `domain` in its YAML. */
  category: string;
  displayName: string;
  displayNamePt: string;
  description: string;
  descriptionPt: string;
  pattern: string;
  engine: string;
  lifecycle: Capability['lifecycle'];
  goldenPath: string;
  version: string;
  state: ServiceState;
  /**
   * How many live instances carry this capability. 0 means not added yet; `null` means the count
   * was not readable, which is a different claim and renders differently.
   */
  instanceCount: number | null;
  capability: Capability;
}

/**
 * Live instance counts per capability, keyed by the LIVE capability id.
 *
 * `counts: null` is the whole read failing (or not having happened yet). A `null` VALUE inside the
 * map is one capability whose count failed while others answered, which is exactly what the
 * cluster-api reports in `instances` when a single source errors.
 */
export interface LiveCounts {
  counts: Record<string, number | null> | null;
  loading?: boolean;
  error?: string;
}

export interface Facet {
  value: string;
  count: number;
}

export interface CatalogFacets {
  categories: Facet[];
  states: Facet[];
  engines: Facet[];
}

export interface CatalogFilters {
  categories?: string[];
  states?: string[];
  engines?: string[];
}

/**
 * The `platform:capability` tag is written by three different producers and they do not agree on
 * a shape: the kro compositions tag the bare id (`inference-ecs`), the tour writes
 * `frontend/static-web-app (tour)` and the admin path writes `agent/kagent-declarative`. Joining
 * on the raw string would silently under-count the added state, which is the exact staleness this
 * issue is about, so normalise to the bare id before matching.
 */
export function normalizeCapabilityKey(raw: string): string {
  const withoutSuffix = raw.split('(')[0];
  const segments = withoutSuffix.trim().toLowerCase().split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}

/** Case- and accent-insensitive, so "funcao" finds "Função Lambda" and "AGENT" finds "agent". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * The catalog entry whose LIVE identity matches `live`, or null.
 *
 * This is the reverse of `liveCapability`, and it is what makes Create work from a live page: the
 * listing and the detail only know `web-api`, and the wizard only knows catalog ids. Returning
 * null for an unknown live capability is deliberate - falling back to a default capability is how
 * a Create on `web-api` used to pre-select a DynamoDB table.
 *
 * Several catalog ids may compose the SAME RGD: a Service Owner Studio MR legitimately publishes
 * a new id (`e2e-dp-1022-orders`) with `rgdRef` to an existing composition (`dynamodb-table`).
 * The live identity is then shared, and the answer must not depend on alphabetical order. The
 * canonical entry is the one whose id IS the live name, then the most mature lifecycle
 * (available > preview > planned > deprecated), then catalog order.
 */
const LIFECYCLE_RANK: Record<Capability['lifecycle'], number> = { available: 0, preview: 1, planned: 2, deprecated: 3 };

export function capabilityForLiveId(capabilities: Capability[], live: string): Capability | null {
  const target = String(live ?? '').trim();
  if (!target) return null;
  const sharing = capabilities.filter(entry => entry.liveCapability === target);
  if (sharing.length > 1) {
    return sharing.find(entry => entry.id === target)
      ?? [...sharing].sort((a, b) => (LIFECYCLE_RANK[a.lifecycle] ?? 9) - (LIFECYCLE_RANK[b.lifecycle] ?? 9))[0];
  }
  return sharing[0]
    ?? capabilities.find(entry => entry.id === target)
    ?? null;
}

/**
 * Joins the file-driven catalog with the live capability counts. The join key is the LIVE
 * capability id, because that is what the cluster reports.
 */
export function buildServiceCatalog(capabilities: Capability[], live: LiveCounts = { counts: null }): ServiceEntry[] {
  const counts = live.counts;
  return capabilities.map(capability => {
    // Three distinct cases, and they must stay distinct: whole read failed, this capability's
    // count failed, or this capability simply is not live.
    const raw = counts ? counts[capability.liveCapability] : undefined;
    const unknown = counts === null || raw === null;
    const instanceCount = unknown ? null : (raw ?? 0);
    const state: ServiceState = unknown
      ? 'unknown'
      : (instanceCount ?? 0) > 0 ? 'added' : capability.lifecycle;
    return {
      id: capability.id,
      liveCapability: capability.liveCapability,
      category: capability.domain,
      displayName: capability.displayName,
      displayNamePt: capability.displayNamePt,
      description: capability.description,
      descriptionPt: capability.descriptionPt,
      pattern: capability.pattern,
      engine: capability.engine,
      lifecycle: capability.lifecycle,
      goldenPath: capability.goldenPath,
      version: capability.version,
      state,
      instanceCount,
      capability,
    };
  });
}

/**
 * Live capabilities the cluster reports that match no catalog entry. A non-empty result means the
 * UI would show a smaller total than the platform actually runs, so a caller can surface it
 * instead of reporting a stale count as the truth.
 */
export function unmatchedCapabilityKeys(capabilities: Capability[], live: LiveCounts = { counts: null }): string[] {
  if (!live.counts) return [];
  const known = new Set(capabilities.map(capability => capability.liveCapability));
  return Object.keys(live.counts).filter(key => !known.has(key)).sort();
}

/** Search over name, description and category, in both locales, so the hit does not depend on the UI language. */
export function searchServiceEntries(entries: ServiceEntry[], query: string): ServiceEntry[] {
  const needle = fold(query.trim());
  if (!needle) return entries;
  return entries.filter(entry => [
    entry.id,
    entry.displayName,
    entry.displayNamePt,
    entry.description,
    entry.descriptionPt,
    entry.category,
    entry.engine,
    entry.pattern,
  ].some(field => fold(field).includes(needle)));
}

function tally(values: string[]): Facet[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Facets are counted off the entries handed in, so they can never list a category the catalog lost. */
export function deriveFacets(entries: ServiceEntry[]): CatalogFacets {
  return {
    categories: tally(entries.map(entry => entry.category)),
    states: tally(entries.map(entry => entry.state)),
    engines: tally(entries.map(entry => entry.engine)),
  };
}

export function filterServiceEntries(entries: ServiceEntry[], filters: CatalogFilters): ServiceEntry[] {
  const { categories, states, engines } = filters;
  return entries.filter(entry =>
    (!categories?.length || categories.includes(entry.category)) &&
    (!states?.length || states.includes(entry.state)) &&
    (!engines?.length || engines.includes(entry.engine)));
}

/** Stable: equal keys fall back to the display name so grid and table never disagree on order. */
export function sortServiceEntries(entries: ServiceEntry[], field: SortField, descending = false): ServiceEntry[] {
  const direction = descending ? -1 : 1;
  // An unknown count sorts as -1, below zero: "we could not read it" must not outrank "it is not
  // added", and it must not silently read as zero either.
  const instances = (entry: ServiceEntry) => (entry.instanceCount === null ? -1 : entry.instanceCount);
  const compare = (a: ServiceEntry, b: ServiceEntry): number => {
    if (field === 'category') return a.category.localeCompare(b.category);
    if (field === 'state') return STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (field === 'instances') return instances(a) - instances(b);
    return a.displayName.localeCompare(b.displayName);
  };
  return [...entries].sort((a, b) => direction * compare(a, b) || a.displayName.localeCompare(b.displayName));
}

/** One call for the whole pipeline, so grid and table are guaranteed to show the same set. */
export function applyCatalogQuery(
  entries: ServiceEntry[],
  options: { query?: string; filters?: CatalogFilters; sortField?: SortField; descending?: boolean } = {},
): ServiceEntry[] {
  const searched = searchServiceEntries(entries, options.query ?? '');
  const filtered = filterServiceEntries(searched, options.filters ?? {});
  return sortServiceEntries(filtered, options.sortField ?? 'state', options.descending ?? false);
}

const STATE_LABELS_PT: Record<ServiceState, string> = {
  added: 'Adicionado',
  available: 'Disponível',
  preview: 'Preview',
  planned: 'Planejado',
  deprecated: 'Descontinuado',
  unknown: 'Estado não lido',
};

const STATE_LABELS_EN: Record<ServiceState, string> = {
  added: 'Added',
  available: 'Available',
  preview: 'Preview',
  planned: 'Planned',
  deprecated: 'Deprecated',
  unknown: 'State not read',
};

export function stateLabel(state: ServiceState, pt: boolean): string {
  return (pt ? STATE_LABELS_PT : STATE_LABELS_EN)[state];
}

/**
 * Cloudscape StatusIndicator renders an icon AND the label, so the status never depends on colour
 * alone. Each state maps to a distinct icon shape, not just a distinct colour.
 */
export function stateIndicator(state: ServiceState): 'success' | 'info' | 'in-progress' | 'pending' | 'stopped' | 'warning' {
  if (state === 'added') return 'success';
  if (state === 'available') return 'info';
  if (state === 'preview') return 'in-progress';
  // Unreadable is a warning, not a neutral pending: the user is looking at a number nobody read.
  if (state === 'unknown') return 'warning';
  return state === 'deprecated' ? 'stopped' : 'pending';
}

export interface CatalogPreferences {
  viewMode: ViewMode;
  pageSize: number;
  sortField: SortField;
  descending: boolean;
}

export const DEFAULT_PREFERENCES: CatalogPreferences = {
  viewMode: 'grid',
  pageSize: 12,
  sortField: 'state',
  descending: false,
};

export const PREFERENCES_KEY = 'agent-platform-service-catalog';
export const CREATE_INTENT_KEY = 'agent-platform-create-intent';

/** Only the two methods we use, so a test can pass a plain object and node needs no localStorage. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const VIEW_MODES: ViewMode[] = ['grid', 'table'];
const SORT_FIELDS: SortField[] = ['name', 'category', 'state', 'instances'];
const PAGE_SIZES = [12, 24, 48];

/** Browser storage can be absent (node tests) or throw (private mode, quota), so never let it break a render. */
export function browserStorage(): PreferenceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * A stored preference is untrusted input: an older build, a hand-edited value or a renamed sort
 * field must degrade to the default rather than render an impossible view.
 */
export function loadPreferences(storage: PreferenceStorage | null = browserStorage()): CatalogPreferences {
  if (!storage) return DEFAULT_PREFERENCES;
  let stored: unknown;
  try {
    const raw = storage.getItem(PREFERENCES_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    stored = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (typeof stored !== 'object' || !stored) return DEFAULT_PREFERENCES;
  const candidate = stored as Partial<CatalogPreferences>;
  return {
    viewMode: VIEW_MODES.includes(candidate.viewMode as ViewMode) ? candidate.viewMode as ViewMode : DEFAULT_PREFERENCES.viewMode,
    pageSize: PAGE_SIZES.includes(Number(candidate.pageSize)) ? Number(candidate.pageSize) : DEFAULT_PREFERENCES.pageSize,
    sortField: SORT_FIELDS.includes(candidate.sortField as SortField) ? candidate.sortField as SortField : DEFAULT_PREFERENCES.sortField,
    descending: typeof candidate.descending === 'boolean' ? candidate.descending : DEFAULT_PREFERENCES.descending,
  };
}

export function savePreferences(preferences: CatalogPreferences, storage: PreferenceStorage | null = browserStorage()): void {
  try {
    storage?.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    /* A view preference is not worth failing a render over. */
  }
}

/**
 * The Create button must arrive at the wizard with the capability already chosen. The hash carries
 * it for a link the user can share or reload, and the storage copy survives the lazy chunk load
 * that happens between the click and the wizard mounting.
 */
export interface CreateIntent {
  capability: string;
  kind: 'infra' | 'agent';
  category: string;
  /** When the user clicked. This is what makes "most recent wins" decidable instead of guessed. */
  at: number;
}

export function createIntentFor(entry: ServiceEntry, now: number = Date.now()): CreateIntent {
  return { capability: entry.id, kind: entry.category === 'agent' ? 'agent' : 'infra', category: entry.category, at: now };
}

/** `#provision/<id>`: the existing router reads the first hash segment, so the view still resolves. */
export function createHref(entry: ServiceEntry): string {
  return `#provision/${encodeURIComponent(entry.id)}`;
}

/** The service page uses the live RGD identity that cluster-api lists. */
export function serviceHref(entry: ServiceEntry): string {
  return `/agent-platform/services/${entry.liveCapability.replace(/\//g, '~')}`;
}

/** Maps a catalog id to the live RGD identity used by cluster-api routes. */
export function servicePathFor(capabilityId: string): string {
  const live = capabilities.find(capability => capability.id === capabilityId)?.liveCapability ?? capabilityId;
  return listPath(live);
}

/** Reads the capability id carried by a `#provision/<id>` hash, if any. */
export function readCapabilityFromHash(hash: string): string {
  const segments = hash.replace(/^#/, '').split('/');
  return segments.length > 1 ? decodeURIComponent(segments.slice(1).join('/')) : '';
}

export function writeCreateIntent(intent: CreateIntent, storage: PreferenceStorage | null = browserStorage()): void {
  try {
    storage?.setItem(CREATE_INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* The hash still carries the capability; the storage copy is a convenience. */
  }
}

/** Returns the pending intent and clears it, so a later visit to the wizard is not pre-filled by a stale click. */
export function takeCreateIntent(capabilities: Capability[], storage: PreferenceStorage | null = browserStorage()): CreateIntent | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(CREATE_INTENT_KEY);
    storage.removeItem?.(CREATE_INTENT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CreateIntent>;
    const capability = typeof parsed.capability === 'string' ? parsed.capability : '';
    // Only honour a capability the catalog still has: a removed capability must not pre-fill the
    // wizard. The lookup accepts the live id too, so an intent recorded from a live page resolves.
    const match = capabilityForLiveId(capabilities, capability);
    if (!match) return null;
    return {
      capability: match.id,
      kind: match.domain === 'agent' ? 'agent' : 'infra',
      category: match.domain,
      at: typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : 0,
    };
  } catch {
    return null;
  }
}

export interface CreateResolution {
  capability: Capability | null;
  namespace: string;
  /** Which signal won. Exported so a test asserts the precedence instead of inferring it. */
  source: 'intent' | 'hash' | 'query' | 'default';
}

/**
 * Which capability the wizard opens with, and why.
 *
 * Precedence is intent > hash > query, and that order IS the fix: the intent and the hash are both
 * written at click time, while a `?capability=` in the query survives from an earlier navigation
 * (the live inventory sends the user to `/agent-platform/?capability=web-api#provision`). Reading
 * the query first meant that, after one such trip, every later Create on the catalog re-opened the
 * capability from that first trip. `source` is returned rather than logged so the precedence is
 * observable from a test.
 *
 * The namespace always comes from the query, because that is the only signal that carries one.
 */
export function resolveCreateCapability(input: {
  search: string;
  hash: string;
  capabilities: Capability[];
  storage?: PreferenceStorage | null;
  fallback?: Capability | null;
}): CreateResolution {
  const { search, hash, capabilities, fallback = null } = input;
  const storage = input.storage === undefined ? browserStorage() : input.storage;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const namespace = params.get('ns') || 'appmod';
  const intent = takeCreateIntent(capabilities, storage);

  const candidates: { value: string; source: CreateResolution['source'] }[] = [
    { value: intent?.capability ?? '', source: 'intent' },
    { value: readCapabilityFromHash(hash), source: 'hash' },
    { value: params.get('capability') ?? '', source: 'query' },
  ];
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const match = capabilityForLiveId(capabilities, candidate.value);
    if (match) return { capability: match, namespace, source: candidate.source };
  }
  return { capability: fallback, namespace, source: 'default' };
}

/**
 * The location with the consumed Create signals removed, keeping the view.
 *
 * After the wizard has read `capability`/`ns`, leaving them in the URL is what made the NEXT
 * Create stale. Dropping the whole query or the whole hash instead would throw away the view
 * (`#provision`) and any unrelated parameter, so only the two keys and the hash's id segment go.
 * `changed` lets the caller skip a history write when there was nothing to clean.
 */
export function clearedCreateLocation(search: string, hash: string): { search: string; hash: string; changed: boolean } {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const had = params.has('capability') || params.has('ns');
  params.delete('capability');
  params.delete('ns');
  const view = hash.replace(/^#/, '').split('/')[0];
  const nextHash = view ? `#${view}` : '';
  const query = params.toString();
  return { search: query ? `?${query}` : '', hash: nextHash, changed: had || nextHash !== hash };
}
