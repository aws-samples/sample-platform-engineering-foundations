/*
 * Lista semântica de itens com divisor, no subconjunto da API do Cloudscape `List` que o portal usa.
 *
 * Por que existe: o `@cloudscape-design/components` tem a pasta `polaris/list`, mas não a
 * exporta no `exports` do package.json, então o import não resolve. Este componente mantém a mesma
 * forma de props (`items`, `renderItem`, `ariaLabel`, `tagOverride`) para a troca voltar a ser um
 * import de uma linha quando o pacote interno publicar o `list`.
 */
import type { ReactNode } from 'react';
import Box from '@cloudscape-design/components/box';
import { colorBorderDividerDefault, spaceScaledS, spaceScaledXs } from '@cloudscape-design/design-tokens';

export interface ItemListItem {
  id: string;
  content: ReactNode;
  secondaryContent?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  /** Aceito por compatibilidade com o `List`; só tem efeito em lista ordenável, que o portal não usa. */
  announcementLabel?: string;
}

export interface ItemListProps<T> {
  items: ReadonlyArray<T>;
  renderItem: (item: T) => ItemListItem;
  ariaLabel?: string;
  tagOverride?: 'ol' | 'ul';
}

export function ItemList<T>({ items, renderItem, ariaLabel, tagOverride = 'ul' }: ItemListProps<T>): JSX.Element {
  const Tag = tagOverride;
  return (
    <Tag aria-label={ariaLabel} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((item, index) => {
        const row = renderItem(item);
        return (
          <li
            key={row.id}
            style={{
              display: 'flex', alignItems: 'center', gap: spaceScaledS, padding: `${spaceScaledXs} 0`,
              borderTop: index === 0 ? 'none' : `1px solid ${colorBorderDividerDefault}`,
            }}
          >
            {row.icon && <span style={{ display: 'inline-flex', flexShrink: 0 }}>{row.icon}</span>}
            <div style={{ flex: 1, minWidth: 0 }}>
              {row.content}
              {row.secondaryContent && <Box variant="small" color="text-body-secondary">{row.secondaryContent}</Box>}
            </div>
            {row.actions && <div style={{ flexShrink: 0 }}>{row.actions}</div>}
          </li>
        );
      })}
    </Tag>
  );
}

export default ItemList;
