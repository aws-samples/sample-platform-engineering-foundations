import {
  isWidgetId, MAX_ROW_SPAN, MIN_ROW_SPAN, WidgetId, WIDGET_IDS, WIDGET_REGISTRY,
} from './widgetRegistry';

export const LAYOUT_SCHEMA_VERSION = 2 as const;
export const MAX_LAYOUT_BYTES = 64 * 1024;
/** Teto de entradas lidas de um documento antes de desistir dele: proteção contra payload absurdo, não regra de produto. */
export const MAX_WIDGET_ENTRIES = 64;
export const ALL_PROJECTS = '*';
/**
 * Larguras de layout que o Board calcula (medido em `useContainerColumns`: < 688 px = 1, < 912 px = 2,
 * < 2100 px = 4, acima disso 6); o offset é guardado por largura.
 */
export const BOARD_LAYOUTS = [1, 2, 4, 6] as const;
export type BoardLayout = typeof BOARD_LAYOUTS[number];
/** O Board deixa redimensionar até a largura do layout mais largo; `interpretItems` aplica `min(columns, span)` nos outros. */
export const MAX_COLUMN_SPAN: BoardLayout = 6;

/** Os mesmos breakpoints de `useContainerColumns` do Board (medidos no pacote 3.0.277). */
export function boardColumnsForWidth(width: number): BoardLayout {
  if (width < 688) return 1;
  if (width < 912) return 2;
  if (width < 2100) return 4;
  return 6;
}
const PROJECT_ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function layoutProjectId(activeProject: string | null): string {
  if (activeProject === null) return ALL_PROJECTS;
  if (!PROJECT_ID.test(activeProject)) throw new Error('active project is not a DNS-1123 label');
  return activeProject;
}

export function isLayoutProjectId(value: unknown): value is string {
  return value === ALL_PROJECTS || (typeof value === 'string' && PROJECT_ID.test(value));
}

/** Posição de um widget no Board. `columnOffset` é por largura de layout (1, 2, 4 ou 6 colunas). */
export interface WidgetPlacement {
  widgetId: WidgetId;
  columnSpan: number;
  rowSpan: number;
  columnOffset: Partial<Record<BoardLayout, number>>;
}

export interface SavedLayout {
  schemaVersion: typeof LAYOUT_SCHEMA_VERSION;
  projectId: string;
  revision: number;
  /** Widgets visíveis, na ordem do Board. Os autorizados que faltam aqui estão na paleta. */
  widgets: WidgetPlacement[];
  updatedAt: string;
}

export interface LayoutContext {
  projectId: string;
  authorizedWidgets: ReadonlySet<WidgetId>;
  now?: () => string;
}

export interface NormalizedLayout {
  layout: SavedLayout;
  fallback: boolean;
  issues: string[];
}

export type LayoutAction =
  | { type: 'set-widgets'; widgets: readonly WidgetPlacement[] }
  | { type: 'reset'; authorizedWidgets: ReadonlySet<WidgetId>; now?: () => string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return MAX_LAYOUT_BYTES + 1;
  }
}

function clampColumnSpan(widgetId: WidgetId, value: unknown): number {
  const definition = WIDGET_REGISTRY[widgetId].board;
  const columnSpan = Number.isInteger(value) ? Number(value) : definition.defaultColumnSpan;
  return Math.min(MAX_COLUMN_SPAN, Math.max(definition.minColumnSpan, columnSpan));
}

function clampRowSpan(widgetId: WidgetId, value: unknown): number {
  const definition = WIDGET_REGISTRY[widgetId].board;
  const rowSpan = Number.isInteger(value) ? Number(value) : definition.defaultRowSpan;
  return Math.min(MAX_ROW_SPAN, Math.max(Math.max(MIN_ROW_SPAN, definition.minRowSpan), rowSpan));
}

function normalizeOffset(value: unknown, columnSpan: number): Partial<Record<BoardLayout, number>> {
  const offset: Partial<Record<BoardLayout, number>> = {};
  if (!isRecord(value)) return offset;
  for (const columns of BOARD_LAYOUTS) {
    const candidate = value[String(columns)];
    if (!Number.isInteger(candidate)) continue;
    // O Board aplica `min(columns, span)` em cada largura, então o offset cabe em `columns - span efetivo`.
    const max = Math.max(0, columns - Math.min(columnSpan, columns));
    offset[columns] = Math.min(max, Math.max(0, Number(candidate)));
  }
  return offset;
}

/** Converte uma posição livre (do Board ou de um JSON lido) para a forma normalizada e dentro dos limites. */
export function normalizePlacement(widgetId: WidgetId, raw: Partial<Omit<WidgetPlacement, 'widgetId'>> | Record<string, unknown>): WidgetPlacement {
  const source = raw as { columnSpan?: unknown; rowSpan?: unknown; columnOffset?: unknown };
  const columnSpan = clampColumnSpan(widgetId, source.columnSpan);
  return {
    widgetId,
    columnSpan,
    rowSpan: clampRowSpan(widgetId, source.rowSpan),
    columnOffset: normalizeOffset(source.columnOffset, columnSpan),
  };
}

function defaultWidgets(authorized: ReadonlySet<WidgetId>): WidgetPlacement[] {
  return WIDGET_IDS.filter(id => authorized.has(id)).map(widgetId => normalizePlacement(widgetId, {}));
}

export function defaultLayout(context: LayoutContext): SavedLayout {
  if (!isLayoutProjectId(context.projectId)) throw new Error('projectId is invalid');
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    projectId: context.projectId,
    revision: 0,
    widgets: defaultWidgets(context.authorizedWidgets),
    updatedAt: (context.now ?? (() => new Date().toISOString()))(),
  };
}

export function normalizeLayout(raw: unknown, context: LayoutContext): NormalizedLayout {
  const issues: string[] = [];
  const fallback = (reason: string): NormalizedLayout => ({
    layout: defaultLayout(context),
    fallback: true,
    issues: [reason],
  });

  if (byteLength(raw) > MAX_LAYOUT_BYTES) return fallback('layout exceeds 64 KB');
  if (!isRecord(raw)) return fallback('layout is not an object');
  if (raw.schemaVersion !== LAYOUT_SCHEMA_VERSION) return fallback('unsupported schemaVersion');
  if (!isLayoutProjectId(raw.projectId) || raw.projectId !== context.projectId) return fallback('projectId does not match the active project');
  if (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) return fallback('revision is invalid');
  if (typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) return fallback('updatedAt is invalid');
  if (!Array.isArray(raw.widgets) || raw.widgets.length > MAX_WIDGET_ENTRIES) return fallback('widgets are invalid');

  const seen = new Set<WidgetId>();
  const widgets: WidgetPlacement[] = [];
  for (const candidate of raw.widgets) {
    if (!isRecord(candidate) || !isWidgetId(candidate.widgetId)) {
      issues.push('unknown widget ignored');
      continue;
    }
    const widgetId = candidate.widgetId;
    if (!context.authorizedWidgets.has(widgetId)) {
      issues.push(`${widgetId} is not authorized`);
      continue;
    }
    if (seen.has(widgetId)) {
      issues.push(`${widgetId} is duplicated`);
      continue;
    }
    seen.add(widgetId);
    const placement = normalizePlacement(widgetId, candidate);
    if (placement.columnSpan !== candidate.columnSpan || placement.rowSpan !== candidate.rowSpan) {
      issues.push(`${widgetId} size clamped`);
    }
    widgets.push(placement);
  }

  return {
    layout: {
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      projectId: context.projectId,
      revision: Number(raw.revision),
      widgets,
      updatedAt: raw.updatedAt,
    },
    fallback: false,
    issues,
  };
}

/** Widgets autorizados que não estão no layout: é o conteúdo da paleta. */
export function paletteWidgets(layout: SavedLayout, authorized: ReadonlySet<WidgetId>): WidgetId[] {
  const visible = new Set(layout.widgets.map(item => item.widgetId));
  return WIDGET_IDS.filter(id => authorized.has(id) && !visible.has(id));
}

function samePlacement(a: WidgetPlacement, b: WidgetPlacement): boolean {
  return a.widgetId === b.widgetId
    && a.columnSpan === b.columnSpan
    && a.rowSpan === b.rowSpan
    && BOARD_LAYOUTS.every(columns => a.columnOffset[columns] === b.columnOffset[columns]);
}

export function sameWidgets(a: readonly WidgetPlacement[], b: readonly WidgetPlacement[]): boolean {
  return a.length === b.length && a.every((item, index) => samePlacement(item, b[index]));
}

/** `null` significa que a mudança não pode ser aplicada (teto de revisão); o chamador reporta `invalid`. */
export function reduceLayout(layout: SavedLayout, action: LayoutAction, authorized: ReadonlySet<WidgetId>): SavedLayout | null {
  if (layout.revision >= Number.MAX_SAFE_INTEGER) return null;
  if (action.type === 'reset') {
    const reset = defaultLayout({ projectId: layout.projectId, authorizedWidgets: action.authorizedWidgets, now: action.now });
    return { ...reset, revision: layout.revision + 1 };
  }
  const seen = new Set<WidgetId>();
  const widgets: WidgetPlacement[] = [];
  for (const item of action.widgets) {
    if (!isWidgetId(item.widgetId) || seen.has(item.widgetId)) continue;
    if (!authorized.has(item.widgetId)) continue;
    seen.add(item.widgetId);
    widgets.push(normalizePlacement(item.widgetId, item));
  }
  return sameWidgets(widgets, layout.widgets) ? layout : { ...layout, revision: layout.revision + 1, widgets };
}
