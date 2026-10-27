import { useMemo, useState } from 'react';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Grid from '@cloudscape-design/components/grid';
import Modal from '@cloudscape-design/components/modal';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { backlogAreas, backlogItems, backlogProgress, BacklogItem, BacklogStatus, priorityRank } from './backlogLoader';
import { useI18n } from './i18n';

const STATUS_META: Record<BacklogStatus, { type: 'success' | 'in-progress' | 'pending' | 'error'; pt: string; en: string; order: number }> = {
  doing: { type: 'in-progress', pt: 'Fazendo', en: 'Doing', order: 0 },
  blocked: { type: 'error', pt: 'Bloqueado', en: 'Blocked', order: 1 },
  todo: { type: 'pending', pt: 'A fazer', en: 'To do', order: 2 },
  done: { type: 'success', pt: 'Feito', en: 'Done', order: 3 },
};

function WiringBadge({ wiring, pt }: { wiring: BacklogItem['wiring']; pt: boolean }): JSX.Element | null {
  if (wiring === 'live') return <Badge color="green">live</Badge>;
  if (wiring === 'mock') return <Badge color="severity-medium">{pt ? 'mock' : 'mock'}</Badge>;
  return null;
}

function PriorityBadge({ priority }: { priority: BacklogItem['priority'] }): JSX.Element | null {
  if (priority === 'P0') return <Badge color="severity-critical">P0</Badge>;
  if (priority === 'P1') return <Badge color="severity-high">P1</Badge>;
  if (priority === 'P2') return <Badge color="severity-low">P2</Badge>;
  return null;
}

export function BacklogModal({ onDismiss }: { onDismiss: () => void }): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('open');
  const progress = useMemo(() => backlogProgress(), []);

  const visible = backlogItems.filter(item =>
    filter === 'all' ? true : filter === 'done' ? item.status === 'done' : item.status !== 'done');

  const byArea = backlogAreas
    .map(area => ({
      area,
      items: visible
        .filter(item => item.area === area.id)
        .sort((a, b) => priorityRank(a) - priorityRank(b) || STATUS_META[a.status].order - STATUS_META[b.status].order),
      total: backlogItems.filter(item => item.area === area.id),
    }))
    .filter(group => group.items.length > 0);

  return (
    <Modal
      visible
      size="large"
      onDismiss={onDismiss}
      header={
        <SpaceBetween size="xs">
          <Box variant="h2">{pt ? 'Backlog da plataforma' : 'Platform backlog'}</Box>
          <Box variant="small" color="text-body-secondary">
            {pt
              ? 'Fonte: platform/backlog/backlog.yaml, versionado e editável por agents via MR.'
              : 'Source: platform/backlog/backlog.yaml, versioned and agent-editable through MRs.'}
          </Box>
        </SpaceBetween>
      }
    >
      <SpaceBetween size="l">
        <Grid gridDefinition={[{ colspan: { default: 12, xs: 7 } }, { colspan: { default: 12, xs: 5 } }]}>
          <ProgressBar
            value={progress.percent}
            label={pt ? 'Progresso geral' : 'Overall progress'}
            additionalInfo={pt
              ? `${progress.done} de ${progress.total} entregues`
              : `${progress.done} of ${progress.total} delivered`}
          />
          <Box textAlign="right" padding={{ top: 's' }}>
            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
              <StatusIndicator type="in-progress">{progress.doing} {pt ? 'em curso' : 'doing'}</StatusIndicator>
              <StatusIndicator type="pending">{progress.todo} {pt ? 'a fazer' : 'to do'}</StatusIndicator>
              {progress.blocked > 0 && <StatusIndicator type="error">{progress.blocked} {pt ? 'bloqueado(s)' : 'blocked'}</StatusIndicator>}
            </SpaceBetween>
          </Box>
        </Grid>

        <SegmentedControl
          selectedId={filter}
          onChange={({ detail }) => setFilter(detail.selectedId as typeof filter)}
          options={[
            { id: 'open', text: pt ? 'Pendentes' : 'Open' },
            { id: 'done', text: pt ? 'Entregues' : 'Delivered' },
            { id: 'all', text: pt ? 'Tudo' : 'All' },
          ]}
        />

        {byArea.map(({ area, items, total }) => {
          const areaDone = total.filter(i => i.status === 'done').length;
          return (
            <ExpandableSection
              key={area.id}
              defaultExpanded={items.some(i => i.status === 'doing' || i.status === 'blocked')}
              variant="container"
              headerText={pt ? area.namePt : area.name}
              headerCounter={`(${areaDone}/${total.length})`}
            >
              <SpaceBetween size="s">
                {items.map(item => (
                  <ExpandableSection
                    key={item.id}
                    headerText={
                      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                        <StatusIndicator type={STATUS_META[item.status].type}>
                          {pt ? STATUS_META[item.status].pt : STATUS_META[item.status].en}
                        </StatusIndicator>
                        <PriorityBadge priority={item.priority} />
                        <span>{pt ? item.titlePt : item.title}</span>
                        <WiringBadge wiring={item.wiring} pt={pt} />
                      </SpaceBetween> as unknown as string
                    }
                  >
                    <Box variant="p" color="text-body-secondary">{pt ? item.detailPt : item.detail}</Box>
                    {item.source && <Box variant="small" color="text-status-inactive">{pt ? 'Origem' : 'Source'}: {item.source}</Box>}
                  </ExpandableSection>
                ))}
              </SpaceBetween>
            </ExpandableSection>
          );
        })}
      </SpaceBetween>
    </Modal>
  );
}
