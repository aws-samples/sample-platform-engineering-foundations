/*
 * Linha de report compartilhada por CategoryIndex e TwoColumnIndex. Antes cada índice desenhava a
 * própria linha com cores e hover escritos à mão; agora os dois usam a mesma lista, com Link, Badge e
 * texto secundário do Cloudscape.
 */
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { ItemList } from './ItemList';
import { RenderIcon } from './IconMap';
import { isExternal, useRouterFollow } from './routerFollow';

export interface Report {
  name: string;
  path: string;
  description?: string;
  date?: string;
  icon?: string;
  badge?: string;
}

export function ReportList({ reports, ariaLabel, emptyText }: { reports: Report[]; ariaLabel: string; emptyText: string }): JSX.Element {
  const follow = useRouterFollow();
  if (reports.length === 0) return <Box textAlign="center" color="text-body-secondary" padding="l">{emptyText}</Box>;
  return (
    <ItemList
      ariaLabel={ariaLabel}
      items={reports}
      renderItem={report => ({
        id: report.path,
        icon: <RenderIcon name={report.icon || 'file-text'} size={18} />,
        content: (
          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
            <Link href={report.path} external={isExternal(report.path)} onFollow={follow(report.path)}>{report.name}</Link>
            {report.badge && <Badge>{report.badge}</Badge>}
          </SpaceBetween>
        ),
        secondaryContent: report.description,
        actions: report.date ? <Box variant="small" color="text-body-secondary">{report.date}</Box> : undefined,
      })}
    />
  );
}

export function SectionTitle({ icon, children }: { icon?: string; children: string }): JSX.Element {
  return (
    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
      {icon && <RenderIcon name={icon} size={18} />}
      <span>{children}</span>
    </SpaceBetween>
  );
}
