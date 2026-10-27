/*
 * Dashboard da Home sobre o Cloudscape Board.
 *
 * O Board é o mesmo componente do AWS Console Home e dos dashboards do CloudWatch: arraste em duas
 * dimensões com preview e placeholder, alça de redimensionar, teclado e anúncios de leitor de tela
 * nativos, e reflow para 2 e 1 coluna em telas estreitas. Este arquivo só traduz entre o Board e o
 * nosso modelo persistido (`layoutModel`); a interação em si é do componente.
 */
import { ReactNode, useEffect, useRef } from 'react';
import { Board, BoardItem, BoardProps, ItemsPalette, ItemsPaletteProps } from '@cloudscape-design/board-components';
import Box from '@cloudscape-design/components/box';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import { BOARD_LAYOUTS, boardColumnsForWidth, BoardLayout, MAX_COLUMN_SPAN, normalizePlacement, SavedLayout, WidgetPlacement } from './layoutModel';
import { BOARD_COLUMNS, WidgetId, WIDGET_REGISTRY } from './widgetRegistry';
import './DashboardBoard.css';

export interface WidgetParts {
  header: ReactNode;
  body: ReactNode;
  /** Remove o padding interno do item, para tabelas e grids que já trazem o seu. */
  flush?: boolean;
}

interface WidgetData { widgetId: WidgetId }

export interface DashboardBoardProps {
  layout: SavedLayout;
  palette: readonly WidgetId[];
  showPalette: boolean;
  pt: boolean;
  widgets: Readonly<Record<WidgetId, WidgetParts>>;
  onChange(widgets: readonly WidgetPlacement[]): Promise<unknown> | void;
}

function titleOf(item: { data: WidgetData }, pt: boolean): string {
  return WIDGET_REGISTRY[item.data.widgetId].title[pt ? 'pt' : 'en'];
}

function placementText(placement: BoardProps.ItemPlacement, pt: boolean): string {
  const columns = pt ? 'coluna' : 'column';
  const rows = pt ? 'linha' : 'row';
  return pt
    ? `${columns} ${placement.x + 1}, ${rows} ${placement.y + 1}, ${placement.width} ${placement.width === 1 ? 'coluna' : 'colunas'} por ${placement.height} ${placement.height === 1 ? 'linha' : 'linhas'}`
    : `${columns} ${placement.x + 1}, ${rows} ${placement.y + 1}, ${placement.width} ${placement.width === 1 ? 'column' : 'columns'} by ${placement.height} ${placement.height === 1 ? 'row' : 'rows'}`;
}

function conflictText(conflicts: readonly { data: WidgetData }[], disturbed: readonly { data: WidgetData }[], pt: boolean): string {
  const parts: string[] = [];
  if (conflicts.length) parts.push(pt ? `Conflito com ${conflicts.map(item => titleOf(item, pt)).join(', ')}.` : `Conflicts with ${conflicts.map(item => titleOf(item, pt)).join(', ')}.`);
  if (disturbed.length) parts.push(pt ? `${disturbed.length} ${disturbed.length === 1 ? 'widget deslocado' : 'widgets deslocados'}.` : `${disturbed.length} ${disturbed.length === 1 ? 'widget moved' : 'widgets moved'}.`);
  return parts.join(' ');
}

export function boardI18n(pt: boolean): BoardProps.I18nStrings<WidgetData> {
  const started = (type: BoardProps.DndOperationType) => (pt
    ? ({ reorder: 'Começou a mover.', resize: 'Começou a redimensionar.', insert: 'Começou a inserir.' })[type]
    : ({ reorder: 'Started moving.', resize: 'Started resizing.', insert: 'Started inserting.' })[type]);
  const noun = (type: BoardProps.DndOperationType) => (pt
    ? ({ reorder: 'Movimento', resize: 'Redimensionamento', insert: 'Inserção' })[type]
    : ({ reorder: 'Move', resize: 'Resize', insert: 'Insert' })[type]);
  return {
    liveAnnouncementDndStarted: started,
    liveAnnouncementDndItemReordered: op => `${titleOf(op.item, pt)}: ${placementText(op.placement, pt)}. ${conflictText(op.conflicts, op.disturbed, pt)}`.trim(),
    liveAnnouncementDndItemResized: op => {
      const limits = [
        op.isMinimalColumnsReached ? (pt ? 'largura mínima' : 'minimal width') : '',
        op.isMinimalRowsReached ? (pt ? 'altura mínima' : 'minimal height') : '',
      ].filter(Boolean).join(pt ? ' e ' : ' and ');
      return `${titleOf(op.item, pt)}: ${placementText(op.placement, pt)}${limits ? ` (${limits})` : ''}. ${conflictText(op.conflicts, op.disturbed, pt)}`.trim();
    },
    liveAnnouncementDndItemInserted: op => `${titleOf(op.item, pt)}: ${placementText(op.placement, pt)}. ${conflictText(op.conflicts, op.disturbed, pt)}`.trim(),
    liveAnnouncementDndCommitted: type => pt
      ? `${noun(type)} ${type === 'insert' ? 'concluída' : 'concluído'}.`
      : `${noun(type)} committed.`,
    liveAnnouncementDndDiscarded: type => pt
      ? `${noun(type)} ${type === 'insert' ? 'cancelada' : 'cancelado'}.`
      : `${noun(type)} discarded.`,
    liveAnnouncementItemRemoved: op => pt
      ? `Widget ${titleOf(op.item, pt)} removido do painel. ${conflictText([], op.disturbed, pt)}`.trim()
      : `Widget ${titleOf(op.item, pt)} removed from the board. ${conflictText([], op.disturbed, pt)}`.trim(),
    navigationAriaLabel: pt ? 'Navegação do painel' : 'Board navigation',
    navigationItemAriaLabel: item => item ? titleOf(item, pt) : (pt ? 'Vazio' : 'Empty'),
  };
}

export function itemI18n(pt: boolean, title: string) {
  return {
    dragHandleAriaLabel: pt ? `Alça de arrastar de ${title}` : `${title} drag handle`,
    dragHandleAriaDescription: pt
      ? 'Use espaço ou Enter para pegar, as setas para mover, espaço ou Enter para soltar e Esc para cancelar.'
      : 'Use Space or Enter to pick up, arrow keys to move, Space or Enter to drop, and Escape to cancel.',
    resizeHandleAriaLabel: pt ? `Alça de redimensionar de ${title}` : `${title} resize handle`,
    resizeHandleAriaDescription: pt
      ? 'Use espaço ou Enter para pegar, as setas para redimensionar, espaço ou Enter para soltar e Esc para cancelar.'
      : 'Use Space or Enter to pick up, arrow keys to resize, Space or Enter to drop, and Escape to cancel.',
    dragHandleTooltipText: pt ? 'Arrastar' : 'Drag',
    resizeHandleTooltipText: pt ? 'Redimensionar' : 'Resize',
  };
}

function toBoardItem(placement: WidgetPlacement): BoardProps.Item<WidgetData> {
  const { board } = WIDGET_REGISTRY[placement.widgetId];
  return {
    id: placement.widgetId,
    data: { widgetId: placement.widgetId },
    columnSpan: placement.columnSpan,
    rowSpan: placement.rowSpan,
    columnOffset: placement.columnOffset as Record<number, number>,
    definition: { ...board },
  };
}

function toPaletteItem(widgetId: WidgetId): ItemsPaletteProps.Item<WidgetData> {
  return { id: widgetId, data: { widgetId }, definition: { ...WIDGET_REGISTRY[widgetId].board } };
}

/**
 * Traduz o que o Board emitiu em `onItemsChange` para o modelo persistido.
 *
 * `columns` é a largura em que o Board estava quando o usuário soltou. O Board desenha cada widget
 * com `min(columns, columnSpan)` e emite essa largura efetiva, então:
 * - em 1 ou 2 colunas a largura canônica anterior é preservada e só `rowSpan` e offset mudam
 *   (redimensionar só a altura no celular viria como largura 1);
 * - em 4 colunas, um widget salvo com 6 que volta com 4 continua 6: a largura emitida é o teto da
 *   grade, não uma escolha (medido na re-review de 24/10/2026);
 * - fora disso o `columnSpan` emitido é o que o usuário escolheu.
 */
export function fromBoardItems(
  items: ReadonlyArray<BoardProps.Item<WidgetData>>,
  previous: readonly WidgetPlacement[] = [],
  columns: BoardLayout = BOARD_COLUMNS as BoardLayout,
): WidgetPlacement[] {
  const before = new Map(previous.map(item => [item.widgetId, item]));
  return items.map(item => {
    const kept = before.get(item.data.widgetId);
    const narrow = columns < BOARD_COLUMNS;
    const clippedByGrid = columns < MAX_COLUMN_SPAN && item.columnSpan === columns && (kept?.columnSpan ?? 0) > columns;
    const columnSpan = kept && (narrow || clippedByGrid) ? kept.columnSpan : item.columnSpan;
    return normalizePlacement(item.data.widgetId, {
      columnSpan,
      rowSpan: item.rowSpan,
      columnOffset: item.columnOffset ?? {},
    });
  });
}

/** Largura de layout do Board para um container, usando os breakpoints do próprio componente. */
export function columnsOf(element: HTMLElement | null): BoardLayout {
  const width = element?.getBoundingClientRect().width ?? 0;
  const columns = boardColumnsForWidth(width);
  return BOARD_LAYOUTS.includes(columns) ? columns : BOARD_COLUMNS as BoardLayout;
}

export function DashboardBoard({ layout, palette, showPalette, pt, widgets, onChange }: DashboardBoardProps): JSX.Element {
  const items = layout.widgets.map(toBoardItem);
  const host = useRef<HTMLDivElement>(null);
  const previousCount = useRef(items.length);
  // O Board foca a alça do widget seguinte; quando o último sai não há alça, então o foco vai ao painel
  // vazio. Tem que ser depois do render que removeu o item: no `onItemsChange` o slot vazio ainda não existe.
  useEffect(() => {
    if (previousCount.current > 0 && items.length === 0) host.current?.querySelector<HTMLElement>('[data-dashboard-empty]')?.focus();
    previousCount.current = items.length;
  }, [items.length]);
  const changed = (next: ReadonlyArray<BoardProps.Item<WidgetData>>) => {
    void onChange(fromBoardItems(next, layout.widgets, columnsOf(host.current)));
  };
  return (
    <div className="dashboard-board" data-dashboard-widgets={items.length} ref={host}>
      {showPalette && (
        <Container
          header={(
            <Header
              variant="h2"
              counter={`(${palette.length})`}
              description={pt
                ? 'Arraste um widget para o painel, ou use a alça com o teclado. Para remover um widget, use o menu no canto dele.'
                : 'Drag a widget onto the board, or use its handle with the keyboard. To remove a widget, use the menu in its corner.'}
            >
              {pt ? 'Widgets disponíveis' : 'Available widgets'}
            </Header>
          )}
        >
          {palette.length === 0
            ? <Box color="text-body-secondary">{pt ? 'Todos os widgets já estão no painel.' : 'Every widget is already on the board.'}</Box>
            : (
              <ItemsPalette<WidgetData>
                items={palette.map(toPaletteItem)}
                renderItem={item => {
                  const definition = WIDGET_REGISTRY[item.data.widgetId];
                  return (
                    <BoardItem header={<Header variant="h3">{definition.title[pt ? 'pt' : 'en']}</Header>} i18nStrings={itemI18n(pt, titleOf(item, pt))}>
                      <Box variant="small" color="text-body-secondary">{definition.description[pt ? 'pt' : 'en']}</Box>
                    </BoardItem>
                  );
                }}
                i18nStrings={{
                  liveAnnouncementDndStarted: pt ? 'Começou a inserir um widget.' : 'Started inserting a widget.',
                  liveAnnouncementDndDiscarded: pt ? 'Inserção cancelada.' : 'Insert discarded.',
                  navigationAriaLabel: pt ? 'Widgets disponíveis' : 'Available widgets',
                  navigationItemAriaLabel: item => titleOf(item, pt),
                }}
              />
            )}
        </Container>
      )}
      <Board<WidgetData>
        items={items}
        renderItem={(item, actions) => {
          const parts = widgets[item.data.widgetId];
          const title = titleOf(item, pt);
          return (
            <BoardItem
              header={parts.header}
              disableContentPaddings={parts.flush}
              i18nStrings={itemI18n(pt, title)}
              settings={(
                <ButtonDropdown
                  variant="icon"
                  ariaLabel={pt ? `Opções de ${title}` : `${title} options`}
                  items={[{ id: 'remove', text: pt ? 'Remover do painel' : 'Remove from board' }]}
                  onItemClick={event => { if (event.detail.id === 'remove') actions.removeItem(); }}
                />
              )}
            >
              {parts.body}
            </BoardItem>
          );
        }}
        onItemsChange={event => changed(event.detail.items)}
        i18nStrings={boardI18n(pt)}
        empty={(
          <div data-dashboard-empty tabIndex={-1}>
            <Box textAlign="center" color="text-body-secondary" padding="l">
              {pt ? 'Nenhum widget no painel. Abra "Adicionar widget" para escolher o que ver aqui.' : 'No widget on the board. Open "Add widget" to choose what to show here.'}
            </Box>
          </div>
        )}
      />
    </div>
  );
}
