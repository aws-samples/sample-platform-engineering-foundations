import { describe, expect, it } from 'vitest';
import { defaultLayout, normalizeLayout, reduceLayout, SavedLayout } from './layoutModel';
import { LayoutStore, LocalLayoutStore, MemoryLayoutStore, StorageLike } from './layoutStore';
import { WidgetId, WIDGET_IDS } from './widgetRegistry';

const authorized = new Set<WidgetId>(WIDGET_IDS);
const NOW = '2026-10-24T03:00:00Z';
const KEY = 'agent-platform:dashboard-layout:v2:user-a:agent-platform';

function layout(projectId = 'agent-platform', revision = 0): SavedLayout {
  return { ...defaultLayout({ projectId, authorizedWidgets: authorized, now: () => NOW }), revision };
}

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

async function userMoves(store: LayoutStore, userId = 'user-a') {
  const loaded = await store.load(userId, 'agent-platform');
  const normalized = normalizeLayout(loaded ?? layout(), { projectId: 'agent-platform', authorizedWidgets: authorized, now: () => NOW }).layout;
  const next = reduceLayout(normalized, { type: 'set-widgets', widgets: [...normalized.widgets].reverse() }, authorized)!;
  return store.save(userId, { layout: next, expectedRevision: loaded?.revision ?? null });
}

describe.each([
  ['memory', () => new MemoryLayoutStore()],
  ['local', () => new LocalLayoutStore(new MemoryStorage())],
] as const)('%s layout store', (_name, create) => {
  it('isolates user and project', async () => {
    const store = create();
    expect(await store.save('user-a', { layout: layout(), expectedRevision: null })).toMatchObject({ status: 'saved', layout: { revision: 1 } });
    expect(await store.load('user-a', 'agent-platform')).toMatchObject({ projectId: 'agent-platform' });
    expect(await store.load('other-user', 'agent-platform')).toBeNull();
    expect(await store.load('user-a', 'other-project')).toBeNull();
  });

  it('assigns monotonically increasing revisions and rejects lost updates', async () => {
    const store = create();
    await store.save('user-a', { layout: layout('agent-platform', 5), expectedRevision: null });
    const saved = await store.save('user-a', { layout: layout('agent-platform', 0), expectedRevision: 1 });
    expect(saved).toMatchObject({ status: 'saved', layout: { revision: 2 } });
    if (saved.status === 'saved') {
      expect(saved.layout.updatedAt).not.toBe(NOW);
      expect(Number.isFinite(Date.parse(saved.layout.updatedAt))).toBe(true);
    }
    expect(await store.save('user-a', { layout: layout(), expectedRevision: 1 }))
      .toMatchObject({ status: 'conflict', current: { revision: 2 } });
  });

  it('returns defensive copies from load and save', async () => {
    const store = create();
    const saved = await store.save('user-a', { layout: layout(), expectedRevision: null });
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') return;
    saved.layout.revision = 99;
    const loaded = await store.load('user-a', 'agent-platform');
    expect(loaded?.revision).toBe(1);
    if (loaded) loaded.revision = 88;
    expect((await store.load('user-a', 'agent-platform'))?.revision).toBe(1);
  });

  it('rejects empty identity, invalid expected revision and invalid layout', async () => {
    const store = create();
    expect(await store.save('user-a', null as never)).toMatchObject({ status: 'invalid' });
    expect(await store.save('', { layout: layout(), expectedRevision: null })).toMatchObject({ status: 'invalid' });
    expect(await store.save('user-a', { layout: layout(), expectedRevision: 1.5 })).toMatchObject({ status: 'invalid' });
    expect(await store.save('user-a', { layout: { ...layout(), updatedAt: 12345 } as unknown as SavedLayout, expectedRevision: null }))
      .toMatchObject({ status: 'invalid' });
    const unknownWidget = { ...layout(), widgets: [{ widgetId: 'remote-module', columnSpan: 2, rowSpan: 2, columnOffset: {} }] } as unknown as SavedLayout;
    expect(await store.save('user-a', { layout: unknownWidget, expectedRevision: null })).toMatchObject({ status: 'invalid' });
    const unclamped = { ...layout(), widgets: [{ widgetId: 'activity', columnSpan: 9, rowSpan: 2, columnOffset: {} }] } as unknown as SavedLayout;
    expect(await store.save('user-a', { layout: unclamped, expectedRevision: null })).toMatchObject({ status: 'invalid' });
    const extraKey = { ...layout(), widgets: [{ widgetId: 'activity', columnSpan: 2, rowSpan: 2, columnOffset: {}, span: 12 }] } as unknown as SavedLayout;
    expect(await store.save('user-a', { layout: extraKey, expectedRevision: null })).toMatchObject({ status: 'invalid', issues: ['layout is not normalized'] });
  });

  it('accepts a subset: removed widgets are a valid persisted state', async () => {
    const store = create();
    const subset = { ...layout(), widgets: [layout().widgets[0]] };
    expect(await store.save('user-a', { layout: subset, expectedRevision: null }))
      .toMatchObject({ status: 'saved', layout: { widgets: [{ widgetId: 'overview-summary' }] } });
    expect(await store.save('user-a', { layout: { ...layout(), widgets: [] }, expectedRevision: 1 }))
      .toMatchObject({ status: 'saved', layout: { widgets: [] } });
  });

  it('resets only the selected project without reusing its revision', async () => {
    const store = create();
    await store.save('user-a', { layout: layout(), expectedRevision: null });
    await store.save('user-a', { layout: layout('other'), expectedRevision: null });
    await store.reset('user-a', 'agent-platform');
    expect(await store.load('user-a', 'agent-platform')).toMatchObject({ revision: 2, widgets: layout().widgets });
    expect(await store.load('user-a', 'other')).toMatchObject({ revision: 1 });
  });

  it('rejects a stale writer after reset instead of allowing an ABA update', async () => {
    const store = create();
    await store.save('user-a', { layout: layout(), expectedRevision: null });
    const stale = await store.load('user-a', 'agent-platform');
    await store.reset('user-a', 'agent-platform');
    expect(await store.save('user-a', { layout: stale!, expectedRevision: 1 }))
      .toMatchObject({ status: 'conflict', current: { revision: 2 } });
  });
});

describe('local layout store forward compatibility (tolerant load, strict save)', () => {
  it('a widget retired from the registry does not wipe the layout nor resurrect removed widgets', async () => {
    const storage = new MemoryStorage();
    const store = new LocalLayoutStore(storage);
    const base = defaultLayout({ projectId: 'agent-platform', authorizedWidgets: authorized });
    const custom = reduceLayout(base, { type: 'set-widgets', widgets: base.widgets.filter(w => w.widgetId !== 'activity' && w.widgetId !== 'next-steps') }, authorized)!;
    expect(await store.save('user-a', { layout: custom, expectedRevision: null })).toMatchObject({ status: 'saved' });
    const raw = JSON.parse(storage.values.get(KEY)!);
    raw.widgets[0].widgetId = 'widget-aposentado';
    storage.values.set(KEY, JSON.stringify(raw));
    const loaded = await store.load('user-a', 'agent-platform');
    expect(loaded).not.toBeNull();
    expect(loaded!.widgets.map(w => w.widgetId)).toEqual(custom.widgets.slice(1).map(w => w.widgetId));
    expect(loaded!.widgets.map(w => w.widgetId)).not.toContain('activity');
    // E a próxima escrita continua respeitando o CAS do documento que existe.
    expect(await store.save('user-a', { layout: { ...loaded!, revision: 0 }, expectedRevision: null })).toMatchObject({ status: 'conflict' });
    expect(await store.save('user-a', { layout: loaded!, expectedRevision: loaded!.revision })).toMatchObject({ status: 'saved', layout: { revision: 2 } });
  });

  it('a minimum raised in a future deploy clamps the saved layout instead of discarding it', async () => {
    const storage = new MemoryStorage();
    const store = new LocalLayoutStore(storage);
    await store.save('user-a', { layout: layout(), expectedRevision: null });
    const raw = JSON.parse(storage.values.get(KEY)!);
    raw.widgets[0].columnSpan = 1; // overview-summary exige 2 hoje
    storage.values.set(KEY, JSON.stringify(raw));
    const loaded = await store.load('user-a', 'agent-platform');
    expect(loaded?.widgets[0]).toMatchObject({ widgetId: 'overview-summary', columnSpan: 2 });
  });
});

describe('local layout store resilience', () => {
  it.each([
    ['revision as float', { schemaVersion: 2, projectId: 'agent-platform', revision: 1.5, widgets: [] }, 1],
    ['widgets not array', { schemaVersion: 2, projectId: 'agent-platform', revision: 5, widgets: 'x' }, 6],
    ['oversized', { ...layout(), revision: 5, padding: 'x'.repeat(70_000) }, 6],
  ])('recovers from %s without a CAS livelock', async (_label, document, expectedRevision) => {
    const storage = new MemoryStorage();
    storage.values.set(KEY, JSON.stringify(document));
    const store = new LocalLayoutStore(storage);
    expect(await store.load('user-a', 'agent-platform')).toBeNull();
    expect(await userMoves(store)).toMatchObject({ status: 'saved', layout: { revision: expectedRevision } });
  });

  it('ignores a legacy v1 grid layout left in storage', async () => {
    const storage = new MemoryStorage();
    storage.values.set('agent-platform:dashboard-layout:v1:user-a:agent-platform:desktop', JSON.stringify({
      schemaVersion: 1, projectId: 'agent-platform', viewport: 'desktop', revision: 7, updatedAt: NOW,
      widgets: [{ widgetId: 'overview-summary', order: 0, span: 12 }],
    }));
    const store = new LocalLayoutStore(storage);
    expect(await store.load('user-a', 'agent-platform')).toBeNull();
    expect(await userMoves(store)).toMatchObject({ status: 'saved', layout: { revision: 1 } });
  });

  it('refuses to overflow a persisted safe revision', async () => {
    const storage = new MemoryStorage();
    const exhausted = layout('agent-platform', Number.MAX_SAFE_INTEGER);
    storage.values.set(KEY, JSON.stringify(exhausted));
    const store = new LocalLayoutStore(storage);
    await expect(store.save('user-a', { layout: exhausted, expectedRevision: Number.MAX_SAFE_INTEGER }))
      .resolves.toMatchObject({ status: 'invalid', issues: ['revision limit reached'] });
  });

  it('degrades gracefully when browser storage is unavailable', async () => {
    const unavailable: StorageLike = {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('QuotaExceededError'); },
      removeItem() { throw new Error('SecurityError'); },
    };
    const store = new LocalLayoutStore(unavailable);
    await expect(store.load('user-a', 'agent-platform')).resolves.toBeNull();
    await expect(store.save('user-a', { layout: layout(), expectedRevision: null }))
      .resolves.toMatchObject({ status: 'unavailable', message: 'SecurityError' });
    await expect(store.reset('user-a', 'agent-platform')).resolves.toBeUndefined();
  });
});
