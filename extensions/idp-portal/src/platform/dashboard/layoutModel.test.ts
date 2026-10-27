import { describe, expect, it } from 'vitest';
import {
  boardColumnsForWidth, defaultLayout, LAYOUT_SCHEMA_VERSION, layoutProjectId, MAX_COLUMN_SPAN, normalizeLayout, normalizePlacement,
  paletteWidgets, reduceLayout, SavedLayout, WidgetPlacement,
} from './layoutModel';
import { MAX_ROW_SPAN, WidgetId, WIDGET_IDS, WIDGET_REGISTRY } from './widgetRegistry';

const authorized = new Set<WidgetId>(WIDGET_IDS);
const now = () => '2026-10-24T03:00:00Z';
const context = { projectId: 'agent-platform', authorizedWidgets: authorized, now };

describe('defaultLayout', () => {
  it('places every authorized widget with its registry definition and no offsets', () => {
    const layout = defaultLayout(context);
    expect(layout.schemaVersion).toBe(LAYOUT_SCHEMA_VERSION);
    expect(layout.revision).toBe(0);
    expect(layout.widgets.map(item => item.widgetId)).toEqual(WIDGET_IDS);
    for (const item of layout.widgets) {
      const { board } = WIDGET_REGISTRY[item.widgetId];
      expect(item.columnSpan).toBe(board.defaultColumnSpan);
      expect(item.rowSpan).toBe(board.defaultRowSpan);
      expect(item.columnOffset).toEqual({});
    }
  });

  it('only includes authorized widgets and maps a null project to the all-projects sentinel', () => {
    const layout = defaultLayout({ ...context, projectId: layoutProjectId(null), authorizedWidgets: new Set<WidgetId>(['activity']) });
    expect(layout.projectId).toBe('*');
    expect(layout.widgets.map(item => item.widgetId)).toEqual(['activity']);
  });

  it('rejects a project id that is not a DNS-1123 label', () => {
    expect(() => layoutProjectId('Not Valid')).toThrow();
    expect(() => defaultLayout({ ...context, projectId: 'UPPER' })).toThrow();
  });
});

describe('normalizePlacement', () => {
  it('clamps spans to the registry minimum, the widest board layout (6) and the row ceiling', () => {
    const tiny = normalizePlacement('overview-summary', { columnSpan: 1, rowSpan: 1 });
    expect(tiny.columnSpan).toBe(WIDGET_REGISTRY['overview-summary'].board.minColumnSpan);
    expect(tiny.rowSpan).toBe(WIDGET_REGISTRY['overview-summary'].board.minRowSpan);
    const huge = normalizePlacement('activity', { columnSpan: 99, rowSpan: 99 });
    expect(huge.columnSpan).toBe(MAX_COLUMN_SPAN);
    expect(huge.rowSpan).toBe(MAX_ROW_SPAN);
    // Ultra-wide: o Board deixa chegar a 6 e isso tem que sobreviver ao storage.
    expect(normalizePlacement('catalog-highlights', { columnSpan: 6, rowSpan: 4 }).columnSpan).toBe(6);
  });

  it('keeps offsets per layout width inside the grid and drops unknown widths', () => {
    const placed = normalizePlacement('activity', { columnSpan: 2, rowSpan: 3, columnOffset: { 6: 9, 4: 9, 2: 1, 1: 5, 3: 1, x: 2 } });
    expect(placed.columnOffset).toEqual({ 6: 4, 4: 2, 2: 0, 1: 0 });
  });

  it('maps container widths to the same column counts the Board measures', () => {
    expect([0, 687, 688, 911, 912, 2099, 2100, 4000].map(boardColumnsForWidth)).toEqual([1, 1, 2, 2, 4, 4, 6, 6]);
  });

  it('falls back to defaults for non-integer sizes', () => {
    const placed = normalizePlacement('next-steps', { columnSpan: 'wide', rowSpan: 2.5 });
    expect(placed.columnSpan).toBe(WIDGET_REGISTRY['next-steps'].board.defaultColumnSpan);
    expect(placed.rowSpan).toBe(WIDGET_REGISTRY['next-steps'].board.defaultRowSpan);
  });
});

describe('normalizeLayout', () => {
  const stored = (): SavedLayout & { widgets: WidgetPlacement[] } => ({
    ...defaultLayout(context),
    revision: 4,
    widgets: [
      { widgetId: 'activity', columnSpan: 2, rowSpan: 3, columnOffset: { 4: 2 } },
      { widgetId: 'recent-resources', columnSpan: 2, rowSpan: 4, columnOffset: { 4: 0 } },
    ],
  });

  it('accepts a valid subset: removed widgets stay removed and appear in the palette', () => {
    const result = normalizeLayout(stored(), context);
    expect(result.fallback).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.layout.widgets.map(item => item.widgetId)).toEqual(['activity', 'recent-resources']);
    expect(paletteWidgets(result.layout, authorized)).toEqual(WIDGET_IDS.filter(id => id !== 'activity' && id !== 'recent-resources'));
  });

  it('drops unknown, unauthorized and duplicated widgets and reports each', () => {
    const raw = stored();
    raw.widgets.push({ widgetId: 'activity', columnSpan: 2, rowSpan: 3, columnOffset: {} });
    raw.widgets.push({ widgetId: 'bogus', columnSpan: 2, rowSpan: 3, columnOffset: {} } as never);
    raw.widgets.push({ widgetId: 'platform-health', columnSpan: 1, rowSpan: 4, columnOffset: {} });
    const result = normalizeLayout(raw, { ...context, authorizedWidgets: new Set<WidgetId>(['activity', 'recent-resources']) });
    expect(result.fallback).toBe(false);
    expect(result.layout.widgets.map(item => item.widgetId)).toEqual(['activity', 'recent-resources']);
    expect(result.issues).toEqual(['activity is duplicated', 'unknown widget ignored', 'platform-health is not authorized']);
  });

  it('a dozen duplicated entries are deduplicated, not a reason to discard the document', () => {
    const raw = stored();
    raw.widgets = new Array(13).fill(raw.widgets[0]);
    const result = normalizeLayout(raw, context);
    expect(result.fallback).toBe(false);
    expect(result.layout.widgets.map(item => item.widgetId)).toEqual(['activity']);
    expect(result.issues.filter(issue => issue === 'activity is duplicated')).toHaveLength(12);
  });

  it('clamps out-of-range sizes and says so', () => {
    const raw = stored();
    raw.widgets[0] = { widgetId: 'activity', columnSpan: 40, rowSpan: 1, columnOffset: {} };
    const result = normalizeLayout(raw, context);
    expect(result.layout.widgets[0]).toMatchObject({ columnSpan: 6, rowSpan: 2 });
    expect(result.issues).toEqual(['activity size clamped']);
  });

  it.each([
    ['legacy v1 layout', { schemaVersion: 1, projectId: 'agent-platform', viewport: 'desktop', revision: 3, widgets: [], updatedAt: now() }, 'unsupported schemaVersion'],
    ['other project', { ...defaultLayout(context), projectId: 'other' }, 'projectId does not match the active project'],
    ['negative revision', { ...defaultLayout(context), revision: -1 }, 'revision is invalid'],
    ['unsafe revision', { ...defaultLayout(context), revision: Number.MAX_SAFE_INTEGER + 2 }, 'revision is invalid'],
    ['bad timestamp', { ...defaultLayout(context), updatedAt: 'yesterday' }, 'updatedAt is invalid'],
    ['too many widget entries', { ...defaultLayout(context), widgets: new Array(65).fill(defaultLayout(context).widgets[0]) }, 'widgets are invalid'],
    ['not an object', 'nope', 'layout is not an object'],
  ])('falls back to defaults for %s', (_name, raw, issue) => {
    const result = normalizeLayout(raw, context);
    expect(result.fallback).toBe(true);
    expect(result.issues).toEqual([issue]);
    expect(result.layout).toEqual(defaultLayout(context));
  });

  it('falls back when the document exceeds 64 KB', () => {
    const raw = { ...defaultLayout(context), padding: 'x'.repeat(64 * 1024) };
    expect(normalizeLayout(raw, context)).toMatchObject({ fallback: true, issues: ['layout exceeds 64 KB'] });
  });
});

describe('reduceLayout', () => {
  const base = defaultLayout(context);

  it('returns the same object when the board emitted an identical arrangement', () => {
    expect(reduceLayout(base, { type: 'set-widgets', widgets: base.widgets.map(item => ({ ...item })) }, authorized)).toBe(base);
  });

  it('bumps the revision for a move, a resize and a removal', () => {
    const moved = reduceLayout(base, { type: 'set-widgets', widgets: [...base.widgets].reverse() }, authorized)!;
    expect(moved.revision).toBe(1);
    expect(moved.widgets[0].widgetId).toBe(WIDGET_IDS[WIDGET_IDS.length - 1]);
    const resized = reduceLayout(moved, { type: 'set-widgets', widgets: moved.widgets.map((item, index) => index === 0 ? { ...item, rowSpan: 6 } : item) }, authorized)!;
    expect(resized.revision).toBe(2);
    expect(resized.widgets[0].rowSpan).toBe(6);
    const removed = reduceLayout(resized, { type: 'set-widgets', widgets: resized.widgets.slice(1) }, authorized)!;
    expect(removed.revision).toBe(3);
    expect(removed.widgets).toHaveLength(WIDGET_IDS.length - 1);
  });

  it('normalizes what the board emits: unauthorized and duplicate ids are dropped, sizes clamped', () => {
    const next = reduceLayout(base, {
      type: 'set-widgets',
      widgets: [
        { widgetId: 'activity', columnSpan: 9, rowSpan: 0, columnOffset: { 4: 3 } },
        { widgetId: 'activity', columnSpan: 2, rowSpan: 2, columnOffset: {} },
        { widgetId: 'next-steps', columnSpan: 1, rowSpan: 4, columnOffset: {} },
      ],
    }, new Set<WidgetId>(['activity']))!;
    expect(next.widgets).toEqual([{ widgetId: 'activity', columnSpan: 6, rowSpan: 2, columnOffset: { 4: 0 } }]);
  });

  it('reset restores the defaults with a higher revision', () => {
    const removed = reduceLayout(base, { type: 'set-widgets', widgets: [] }, authorized)!;
    const reset = reduceLayout(removed, { type: 'reset', authorizedWidgets: authorized, now }, authorized)!;
    expect(reset.revision).toBe(2);
    expect(reset.widgets).toEqual(base.widgets);
  });

  it('refuses to overflow the revision counter and says so with null, never a silent no-op', () => {
    const ceiling = { ...base, revision: Number.MAX_SAFE_INTEGER };
    expect(reduceLayout(ceiling, { type: 'set-widgets', widgets: [] }, authorized)).toBeNull();
    expect(reduceLayout(ceiling, { type: 'reset', authorizedWidgets: authorized, now }, authorized)).toBeNull();
  });
});
