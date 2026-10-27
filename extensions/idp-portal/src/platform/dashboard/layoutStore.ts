import { defaultLayout, isLayoutProjectId, normalizeLayout, sameWidgets, SavedLayout } from './layoutModel';
import { isWidgetId, WidgetId, WIDGET_IDS } from './widgetRegistry';

export interface SaveLayoutInput {
  layout: SavedLayout;
  expectedRevision: number | null;
}

export type SaveResult =
  | { status: 'saved'; layout: SavedLayout }
  | { status: 'conflict'; current: SavedLayout | null }
  | { status: 'invalid'; issues: string[] }
  | { status: 'unavailable'; message: string };

export interface LayoutStore {
  load(userId: string, projectId: string): Promise<SavedLayout | null>;
  save(userId: string, input: SaveLayoutInput): Promise<SaveResult>;
  reset(userId: string, projectId: string): Promise<void>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const ALL_WIDGETS = new Set<WidgetId>(WIDGET_IDS);

function identityIssues(userId: string, projectId: string): string[] {
  const issues = [];
  if (typeof userId !== 'string' || userId.trim() === '') issues.push('userId is required');
  if (!isLayoutProjectId(projectId)) issues.push('projectId is invalid');
  return issues;
}

/** A chave leva a versão do schema: layouts v1 (grid artesanal) ficam órfãos e são ignorados. */
function key(userId: string, projectId: string): string {
  const issues = identityIssues(userId, projectId);
  if (issues.length) throw new Error(issues.join('; '));
  return `agent-platform:dashboard-layout:v2:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`;
}

function sameKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sameNormalizedLayout(actual: SavedLayout, normalized: SavedLayout): boolean {
  const layoutKeys = ['projectId', 'revision', 'schemaVersion', 'updatedAt', 'widgets'];
  const widgetKeys = ['columnOffset', 'columnSpan', 'rowSpan', 'widgetId'];
  return sameKeys(actual, layoutKeys)
    && actual.schemaVersion === normalized.schemaVersion
    && actual.projectId === normalized.projectId
    && actual.revision === normalized.revision
    && actual.updatedAt === normalized.updatedAt
    && actual.widgets.every(item => sameKeys(item, widgetKeys))
    && sameWidgets(actual.widgets, normalized.widgets);
}

function declaredWidgetIds(layout: SavedLayout): ReadonlySet<WidgetId> {
  if (!Array.isArray(layout.widgets)) return ALL_WIDGETS;
  return new Set(layout.widgets
    .filter(item => item && typeof item === 'object' && isWidgetId(item.widgetId))
    .map(item => item.widgetId));
}

function strictLayout(layout: SavedLayout): string[] {
  if (!layout || !isLayoutProjectId(layout.projectId)) return ['projectId is invalid'];
  try {
    const normalized = normalizeLayout(layout, {
      projectId: layout.projectId,
      authorizedWidgets: declaredWidgetIds(layout),
      now: () => layout.updatedAt,
    });
    if (normalized.fallback) return normalized.issues;
    if (normalized.issues.length) return normalized.issues;
    return sameNormalizedLayout(layout, normalized.layout) ? [] : ['layout is not normalized'];
  } catch {
    return ['layout is invalid'];
  }
}

/**
 * Leitura TOLERANTE: um widget aposentado do registry ou um mínimo que subiu num deploy futuro não
 * apagam o layout inteiro do usuário (o que ressuscitaria os widgets que ele removeu). O documento
 * é normalizado com o que ainda vale; só documento estruturalmente inválido volta `null`. A escrita
 * continua ESTRITA (`strictLayout`): o que entra no storage é sempre a forma normalizada.
 */
function decode(value: string | null, projectId: string): SavedLayout | null {
  if (!value) return null;
  try {
    const layout = JSON.parse(value) as SavedLayout;
    if (!layout || layout.projectId !== projectId) return null;
    const normalized = normalizeLayout(layout, { projectId, authorizedWidgets: declaredWidgetIds(layout), now: () => layout.updatedAt });
    return normalized.fallback ? null : normalized.layout;
  } catch {
    return null;
  }
}

function decodeRevision(value: string | null, projectId: string): number | null {
  if (!value) return null;
  try {
    const record = JSON.parse(value) as Record<string, unknown>;
    return record.projectId === projectId
      && Number.isSafeInteger(record.revision)
      && Number(record.revision) >= 0
      ? Number(record.revision)
      : null;
  } catch {
    return null;
  }
}

function nextLayout(layout: SavedLayout, revisionFloor: number | null): SavedLayout | null {
  const revision = (revisionFloor ?? 0) + 1;
  return Number.isSafeInteger(revision)
    ? { ...structuredClone(layout), revision, updatedAt: new Date().toISOString() }
    : null;
}

function expectedRevisionIssues(value: number | null): string[] {
  return value === null || (Number.isSafeInteger(value) && value >= 0) ? [] : ['expectedRevision is invalid'];
}

function resetLayout(projectId: string, revisionFloor: number): SavedLayout | null {
  if (revisionFloor >= Number.MAX_SAFE_INTEGER) return null;
  const layout = defaultLayout({ projectId, authorizedWidgets: ALL_WIDGETS });
  return { ...layout, revision: revisionFloor + 1 };
}

export class MemoryLayoutStore implements LayoutStore {
  private readonly layouts = new Map<string, SavedLayout>();

  async load(userId: string, projectId: string): Promise<SavedLayout | null> {
    try {
      const current = this.layouts.get(key(userId, projectId));
      return current ? structuredClone(current) : null;
    } catch {
      return null;
    }
  }

  async save(userId: string, input: SaveLayoutInput): Promise<SaveResult> {
    if (!input?.layout || typeof input.layout !== 'object') return { status: 'invalid', issues: ['layout is invalid'] };
    const issues = [...identityIssues(userId, input.layout.projectId), ...expectedRevisionIssues(input.expectedRevision), ...strictLayout(input.layout)];
    if (issues.length) return { status: 'invalid', issues };
    const target = key(userId, input.layout.projectId);
    const current = this.layouts.get(target) ?? null;
    if ((current?.revision ?? null) !== input.expectedRevision) {
      return { status: 'conflict', current: current ? structuredClone(current) : null };
    }
    const saved = nextLayout(input.layout, current?.revision ?? null);
    if (!saved) return { status: 'invalid', issues: ['revision limit reached'] };
    this.layouts.set(target, saved);
    return { status: 'saved', layout: structuredClone(saved) };
  }

  async reset(userId: string, projectId: string): Promise<void> {
    try {
      const target = key(userId, projectId);
      const current = this.layouts.get(target);
      if (!current) return;
      const reset = resetLayout(projectId, current.revision);
      if (reset) this.layouts.set(target, reset);
    } catch { /* graceful degradation */ }
  }
}

export class LocalLayoutStore implements LayoutStore {
  constructor(private readonly storage: StorageLike) {}

  async load(userId: string, projectId: string): Promise<SavedLayout | null> {
    try { return decode(this.storage.getItem(key(userId, projectId)), projectId); }
    catch { return null; }
  }

  async save(userId: string, input: SaveLayoutInput): Promise<SaveResult> {
    if (!input?.layout || typeof input.layout !== 'object') return { status: 'invalid', issues: ['layout is invalid'] };
    const issues = [...identityIssues(userId, input.layout.projectId), ...expectedRevisionIssues(input.expectedRevision), ...strictLayout(input.layout)];
    if (issues.length) return { status: 'invalid', issues };
    try {
      const target = key(userId, input.layout.projectId);
      const raw = this.storage.getItem(target);
      const current = decode(raw, input.layout.projectId);
      if ((current?.revision ?? null) !== input.expectedRevision) {
        return { status: 'conflict', current: current ? structuredClone(current) : null };
      }
      const saved = nextLayout(input.layout, decodeRevision(raw, input.layout.projectId));
      if (!saved) return { status: 'invalid', issues: ['revision limit reached'] };
      this.storage.setItem(target, JSON.stringify(saved));
      return { status: 'saved', layout: structuredClone(saved) };
    } catch (error) {
      return { status: 'unavailable', message: error instanceof Error ? error.message : 'storage unavailable' };
    }
  }

  async reset(userId: string, projectId: string): Promise<void> {
    try {
      const target = key(userId, projectId);
      const raw = this.storage.getItem(target);
      const revision = decodeRevision(raw, projectId);
      if (revision === null) {
        if (raw) this.storage.removeItem(target);
        return;
      }
      const reset = resetLayout(projectId, revision);
      if (reset) this.storage.setItem(target, JSON.stringify(reset));
    } catch { /* graceful degradation */ }
  }
}
