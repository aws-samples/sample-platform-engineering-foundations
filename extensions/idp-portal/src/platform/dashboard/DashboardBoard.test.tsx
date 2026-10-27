// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardI18n, DashboardBoard, fromBoardItems, WidgetParts } from './DashboardBoard';
import { defaultLayout, SavedLayout } from './layoutModel';
import { WidgetId, WIDGET_IDS, WIDGET_REGISTRY } from './widgetRegistry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void { /* jsdom has no layout */ }
  unobserve(): void { /* noop */ }
  disconnect(): void { /* noop */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const authorized = new Set<WidgetId>(WIDGET_IDS);
const layout = defaultLayout({ projectId: 'agent-platform', authorizedWidgets: authorized, now: () => '2026-10-24T03:00:00Z' });
const widgets = Object.fromEntries(WIDGET_IDS.map(id => [id, {
  header: <h2>{WIDGET_REGISTRY[id].title.pt}</h2>,
  body: <div data-widget-body={id}>corpo {id}</div>,
}])) as Record<WidgetId, WidgetParts>;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(current: SavedLayout, palette: WidgetId[], showPalette: boolean, onChange = vi.fn()) {
  act(() => root.render(
    <DashboardBoard layout={current} palette={palette} showPalette={showPalette} pt widgets={widgets} onChange={onChange} />,
  ));
  return onChange;
}

describe('DashboardBoard', () => {
  it('renders one board item per persisted widget, each with localized drag and resize handles', () => {
    render(layout, [], false);
    for (const id of WIDGET_IDS) {
      expect(host.querySelector(`[data-widget-body="${id}"]`)).not.toBeNull();
      const title = WIDGET_REGISTRY[id].title.pt;
      expect(host.textContent).toContain(`Alça de arrastar de ${title}`);
      expect(host.textContent).toContain(`Alça de redimensionar de ${title}`);
      expect(host.querySelector(`[aria-label="Opções de ${title}"]`)).not.toBeNull();
    }
    expect(host.textContent).not.toContain('Widgets disponíveis');
  });

  it('shows the palette with the widgets that are not on the board', () => {
    const partial = { ...layout, widgets: layout.widgets.slice(0, 2) };
    render(partial, WIDGET_IDS.slice(2), true);
    expect(host.textContent).toContain('Widgets disponíveis');
    expect(host.textContent).toContain(`(${WIDGET_IDS.length - 2})`);
    for (const id of WIDGET_IDS.slice(2)) {
      expect(host.textContent).toContain(WIDGET_REGISTRY[id].description.pt);
      expect(host.querySelector(`[data-widget-body="${id}"]`)).toBeNull();
    }
  });

  it('removes a widget through its settings menu and hands the remaining items to the store', async () => {
    const onChange = render(layout, [], false);
    const menu = host.querySelector<HTMLButtonElement>('[aria-label="Opções de Atividade"]');
    expect(menu).not.toBeNull();
    await act(async () => { menu!.click(); });
    const remove = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent?.includes('Remover do painel')) as HTMLElement | undefined;
    expect(remove).toBeDefined();
    await act(async () => { remove!.click(); });
    // O Board confirma a remoção depois de TRANSITION_DURATION_MS (200 ms) para a animação terminar.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const items = onChange.mock.calls[0][0] as { widgetId: string }[];
    expect(items.map(item => item.widgetId)).toEqual(WIDGET_IDS.filter(id => id !== 'activity'));
  });

  it('renders the empty state when every widget was removed', () => {
    render({ ...layout, widgets: [] }, [...WIDGET_IDS], false);
    expect(host.textContent).toContain('Nenhum widget no painel');
  });

  it('moves focus to the empty board after the last widget leaves, once the removal has rendered', async () => {
    const single = { ...layout, widgets: layout.widgets.slice(0, 1) };
    function Harness(): JSX.Element {
      const [current, setCurrent] = useState(single);
      return (
        <DashboardBoard
          layout={current}
          palette={[]}
          showPalette={false}
          pt
          widgets={widgets}
          onChange={async next => { await Promise.resolve(); setCurrent(value => ({ ...value, widgets: next as typeof value.widgets })); }}
        />
      );
    }
    act(() => root.render(<Harness />));
    const menu = host.querySelector<HTMLButtonElement>('[aria-label="Opções de Resumo da plataforma"]')!;
    await act(async () => { menu.click(); });
    const remove = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent?.includes('Remover do painel')) as HTMLElement;
    await act(async () => { remove.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
    expect(host.textContent).toContain('Nenhum widget no painel');
    expect(document.activeElement).toBe(host.querySelector('[data-dashboard-empty]'));
  });
});

describe('fromBoardItems', () => {
  it('normalizes what the board emits into persisted placements', () => {
    const placements = fromBoardItems([
      { id: 'activity', data: { widgetId: 'activity' }, columnSpan: 9, rowSpan: 1, columnOffset: { 4: 3, 2: 1 } },
      { id: 'next-steps', data: { widgetId: 'next-steps' } },
    ]);
    expect(placements).toEqual([
      { widgetId: 'activity', columnSpan: 6, rowSpan: 2, columnOffset: { 4: 0, 2: 0 } },
      { widgetId: 'next-steps', columnSpan: 2, rowSpan: 4, columnOffset: {} },
    ]);
  });

  it('keeps the desktop width when the board was in 1 or 2 columns and only the height changed', () => {
    const previous = layout.widgets;
    const emitted = previous.map(item => ({ id: item.widgetId, data: { widgetId: item.widgetId }, columnSpan: 1, rowSpan: item.widgetId === 'overview-summary' ? 6 : item.rowSpan, columnOffset: { 1: 0 } }));
    const narrow = fromBoardItems(emitted, previous, 1);
    expect(narrow.find(item => item.widgetId === 'overview-summary')).toMatchObject({ columnSpan: 4, rowSpan: 6 });
    expect(narrow.map(item => item.columnSpan)).toEqual(previous.map(item => item.columnSpan));
    // Em 4 colunas a largura emitida é a escolha do usuário.
    const wide = fromBoardItems(emitted.map(item => ({ ...item, columnSpan: 2 })), previous, 4);
    expect(wide.find(item => item.widgetId === 'overview-summary')).toMatchObject({ columnSpan: 2 });
    // Widget inserido em layout estreito não tem largura anterior: usa a emitida (clampada ao mínimo do registry).
    const inserted = fromBoardItems([{ id: 'activity', data: { widgetId: 'activity' }, columnSpan: 1, rowSpan: 4 }], [], 1);
    expect(inserted[0].columnSpan).toBe(1);
  });

  it('keeps an ultra-wide span when a 4-column board emits its own ceiling, but honors a real shrink', () => {
    const previous = [{ widgetId: 'catalog-highlights' as WidgetId, columnSpan: 6, rowSpan: 4, columnOffset: {} }];
    const clipped = fromBoardItems([{ id: 'catalog-highlights', data: { widgetId: 'catalog-highlights' }, columnSpan: 4, rowSpan: 5 }], previous, 4);
    expect(clipped[0]).toMatchObject({ columnSpan: 6, rowSpan: 5 });
    const shrunk = fromBoardItems([{ id: 'catalog-highlights', data: { widgetId: 'catalog-highlights' }, columnSpan: 2, rowSpan: 4 }], previous, 4);
    expect(shrunk[0].columnSpan).toBe(2);
    const wideBoard = fromBoardItems([{ id: 'catalog-highlights', data: { widgetId: 'catalog-highlights' }, columnSpan: 4, rowSpan: 4 }], previous, 6);
    expect(wideBoard[0].columnSpan).toBe(4);
  });
});

describe('boardI18n', () => {
  const item = { id: 'activity', data: { widgetId: 'activity' as WidgetId } };
  const placement = { x: 2, y: 0, width: 2, height: 3 };

  it('announces placement, conflicts and limits in Portuguese', () => {
    const strings = boardI18n(true);
    expect(strings.liveAnnouncementDndStarted('resize')).toBe('Começou a redimensionar.');
    expect(strings.liveAnnouncementDndItemReordered({ item, placement, direction: 'horizontal', conflicts: [], disturbed: [item] }))
      .toBe('Atividade: coluna 3, linha 1, 2 colunas por 3 linhas. 1 widget deslocado.');
    expect(strings.liveAnnouncementDndItemResized({ item, placement, direction: 'vertical', isMinimalColumnsReached: false, isMinimalRowsReached: true, conflicts: [], disturbed: [] }))
      .toBe('Atividade: coluna 3, linha 1, 2 colunas por 3 linhas (altura mínima).');
    expect(strings.liveAnnouncementItemRemoved({ item, disturbed: [] })).toBe('Widget Atividade removido do painel.');
    expect(strings.liveAnnouncementDndCommitted('insert')).toBe('Inserção concluída.');
    expect(strings.liveAnnouncementDndCommitted('reorder')).toBe('Movimento concluído.');
  });

  it('announces in English without em dashes', () => {
    const strings = boardI18n(false);
    const text = [
      strings.liveAnnouncementDndStarted('reorder'),
      strings.liveAnnouncementDndItemInserted({ item, placement, conflicts: [item], disturbed: [] }),
      strings.liveAnnouncementDndDiscarded('resize'),
    ].join(' ');
    expect(text).toBe('Started moving. Activity: column 3, row 1, 2 columns by 3 rows. Conflicts with Activity. Resize discarded.');
    expect(text).not.toContain('\u2014');
  });
});
