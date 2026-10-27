/*
 * Par Board -> fromBoardItems -> store -> load, com a ENTRADA gerada pelo código real do Board
 * (`interpretItems`/`transformItems` do pacote vendorizado), nunca por um payload escrito ao lado da
 * regra. Nasceu da revisão independente de 24/10/2026, que achou dois defeitos com exatamente este par.
 */
import { describe, expect, it } from 'vitest';
// O pacote tem `exports` sem este caminho, então o import é relativo ao node_modules do repo.
import { interpretItems, transformItems } from '../../../node_modules/@cloudscape-design/board-components/internal/utils/layout.js';
import { errorMessage, SESSION_EXPIRED_MESSAGE, SessionMissingError, signedResponse } from '../errors';
import { fromBoardItems } from './DashboardBoard';
import { BoardLayout, defaultLayout, reduceLayout, SavedLayout } from './layoutModel';
import { LocalLayoutStore, StorageLike } from './layoutStore';
import { WidgetId, WIDGET_IDS, WIDGET_REGISTRY } from './widgetRegistry';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const ALL = new Set<WidgetId>(WIDGET_IDS);
const USER = 'user-a';
const PROJECT = 'agent-platform';
const base = defaultLayout({ projectId: PROJECT, authorizedWidgets: ALL, now: () => '2026-10-24T00:00:00.000Z' });

function boardItems(layout: SavedLayout) {
  return layout.widgets.map(w => ({
    id: w.widgetId,
    data: { widgetId: w.widgetId },
    columnSpan: w.columnSpan,
    rowSpan: w.rowSpan,
    columnOffset: w.columnOffset as Record<number, number>,
    definition: { ...WIDGET_REGISTRY[w.widgetId].board },
  }));
}

/** O commit de um resize no Board com `columns` colunas, pelo mesmo código que gera `onItemsChange`. */
function boardResize(layout: SavedLayout, columns: BoardLayout, target: WidgetId, width: number, height: number) {
  const items = boardItems(layout);
  const grid = interpretItems(items, columns);
  const resized = { ...grid, items: grid.items.map(it => (it.id === target ? { ...it, width, height } : it)) };
  return transformItems(items, resized, target) as Parameters<typeof fromBoardItems>[0];
}

async function persistAndReload(layout: SavedLayout, columns: BoardLayout, emitted: Parameters<typeof fromBoardItems>[0]) {
  const storage = new MemoryStorage();
  const next = reduceLayout(layout, { type: 'set-widgets', widgets: fromBoardItems(emitted, layout.widgets, columns) }, ALL)!;
  const saved = await new LocalLayoutStore(storage).save(USER, { layout: next, expectedRevision: null });
  const loaded = await new LocalLayoutStore(storage).load(USER, PROJECT);
  return { next, saved, loaded };
}

describe('real Board payload round trip', () => {
  for (const columns of [1, 2, 4, 6] as const) {
    it(`save and load are symmetric after a real resize in ${columns} column(s)`, async () => {
      const emitted = boardResize(base, columns, 'recent-resources', Math.min(columns, 1), 3);
      const { next, saved, loaded } = await persistAndReload(base, columns, emitted);
      expect(saved.status).toBe('saved');
      expect(loaded?.widgets).toEqual(saved.status === 'saved' ? saved.layout.widgets : null);
      expect(loaded?.widgets).toEqual(next.widgets);
    });
  }

  it('a 6-wide resize on the 6-column layout survives the store exactly as the user dropped it', async () => {
    const emitted = boardResize(base, 6, 'catalog-highlights', 6, 4);
    expect(emitted.find(item => item.id === 'catalog-highlights')!.columnSpan).toBe(6);
    const { loaded } = await persistAndReload(base, 6, emitted);
    expect(loaded!.widgets.find(w => w.widgetId === 'catalog-highlights')!.columnSpan).toBe(6);
  });

  it('a height-only resize on the phone (1 column) keeps the desktop width', async () => {
    const emitted = boardResize(base, 1, 'overview-summary', 1, 6);
    const { loaded } = await persistAndReload(base, 1, emitted);
    expect(loaded!.widgets.find(w => w.widgetId === 'overview-summary')).toMatchObject({ rowSpan: 6, columnSpan: 4 });
  });
});

describe('missing the corporate SSO session at the fetch boundary', () => {
  it('signedResponse rejects what the the internal gateway wrapper returns without a session and accepts a Response', () => {
    expect(() => signedResponse(undefined)).toThrow(SessionMissingError);
    expect(() => signedResponse({ ok: true })).toThrow(SessionMissingError);
    const response = { ok: true, status: 200, json: async () => ({}) };
    expect(signedResponse(response)).toBe(response);
  });

  it('errorMessage recognizes the typed error, the Chrome and Safari minified forms, and nothing else', () => {
    expect(errorMessage(new SessionMissingError(), 'fb')).toBe(SESSION_EXPIRED_MESSAGE);
    expect(errorMessage(new TypeError('h.json is not a function'), 'fb')).toBe(SESSION_EXPIRED_MESSAGE);
    expect(errorMessage(new TypeError('(intermediate value).json is not a function'), 'fb')).toBe(SESSION_EXPIRED_MESSAGE);
    expect(errorMessage(new TypeError("h.json is not a function. (In 'h.json()', 'h.json' is undefined)"), 'fb')).toBe(SESSION_EXPIRED_MESSAGE);
    // Bug nosso (chamar .json em dado já parseado) tem que continuar aparecendo como está.
    expect(errorMessage(new TypeError('data.json is not a function'), 'fb')).toBe('data.json is not a function');
    expect(errorMessage(new TypeError('response.json is not a function'), 'fb')).toBe('response.json is not a function');
  });
});
