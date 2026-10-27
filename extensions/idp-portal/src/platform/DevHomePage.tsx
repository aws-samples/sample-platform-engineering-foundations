/*
 * Home do Dev: o ponto de entrada da Developer Platform.
 *
 * Responde, nesta ordem, às perguntas de quem abre o portal: o que eu tenho rodando, o que está
 * provisionando ou quebrado, o que eu posso pedir, e o que fazer agora. Tudo vem de leituras live
 * da cluster-api e do catálogo em arquivo; não há backend novo nem número escrito no código.
 *
 * Duas camadas, no padrão das outras páginas do portal:
 *  - `DevHomeView` é apresentacional e recebe os estados prontos, o que deixa os testes renderizarem
 *    cada estado (carregando, erro, vazio, não lido, pronto) sem browser;
 *  - `DevHomePage` faz as leituras, com abort, polling adaptativo e um estado por bloco, para que a
 *    falha de uma fonte nunca apague o que outra leu.
 *
 * Acessibilidade: todo status é ícone mais texto (StatusIndicator), nunca só cor; cada bloco tem um
 * heading h2 e as listas têm aria-label.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import List from '../components/ItemList';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { ClusterOverview, PlatformView, getEvents, getOverview, getPlatformView } from './clusterApi';
import { capabilities as allCapabilities } from './catalogLoader';
import { errorMessage } from './errors';
import { useI18n } from './i18n';
import { ALL_NAMESPACES, InstanceRow, InstancesResponse, InventoryError, ScorecardLevel, ScorecardsResponse, listInstances, listScorecards } from './kdpInventoryApi';
import { argoUnreadableNote, levelIndicator, levelLabel } from './scorecardParts';
import { DashboardBoard, WidgetParts } from './dashboard/DashboardBoard';
import { ComposableDashboardController, DashboardIssue, useComposableDashboard } from './dashboard/useComposableDashboard';
import { WidgetId, WIDGET_REGISTRY } from './dashboard/widgetRegistry';
import { detailPath, listPath, nextRefreshDelay, relativeAge, stateIndicator } from './kdpInventoryModel';
import { LiveStatus, LoadFailure, SourceWarning } from './KdpInventoryParts';
import { loadTracked } from './agentBuilderModel';
import { LiveCounts, ServiceEntry, buildServiceCatalog, createHref, createIntentFor, writeCreateIntent } from './serviceCatalog';
import { ServiceCards } from './ServiceCatalogParts';
import {
  ActivityItem, HOME_LAYOUT, HealthLevel, LOADING, NextStep, OperationItem, Remote, StepTarget,
  activityFeed, catalogSummary, featuredServices, healthIndicatorType, healthSignals, nextSteps,
  operationsInProgress, overallHealth, phaseIndicator, progressStatus, recentResources,
} from './devHomeModel';

/* -------------------------------------------------------------------------- */
/* Contrato da view                                                            */
/* -------------------------------------------------------------------------- */

export interface OperationsData { items: OperationItem[]; total: number }

export interface DevHomeViewProps {
  pt: boolean;
  /** As entradas do catálogo já cruzadas com a contagem live. */
  entries: ServiceEntry[];
  catalogLoading: boolean;
  catalogError: string;
  recent: Remote<InstanceRow[]>;
  operations: Remote<OperationsData>;
  activity: Remote<ActivityItem[]>;
  overview: Remote<ClusterOverview>;
  platform: Remote<PlatformView>;
  scorecards: Remote<ScorecardsResponse>;
  trackedAgent?: string | null;
  dashboard?: ComposableDashboardController;
  onView(view: string): void;
  onPath(path: string): void;
  onOpenService(entry: ServiceEntry): void;
  onCreate(entry: ServiceEntry): void;
  onRetry?(): void;
}

/* -------------------------------------------------------------------------- */
/* Peças                                                                       */
/* -------------------------------------------------------------------------- */

function notRead(pt: boolean): string {
  return pt ? 'Não lido' : 'Not read';
}

/** Um link interno que navega pelo router, mantendo o href real para abrir em nova aba. */
function InternalLink({ href, onFollow, children, ariaLabel }: { href: string; onFollow(): void; children: React.ReactNode; ariaLabel?: string }): JSX.Element {
  return (
    <Link href={href} ariaLabel={ariaLabel} onFollow={event => { event.preventDefault(); onFollow(); }}>
      {children}
    </Link>
  );
}

function hrefOf(target: StepTarget): string {
  return 'view' in target ? `#${target.view}` : target.path;
}

export interface KpiProps {
  label: string;
  /** `null` mostra o estado em `pending`, nunca um zero. */
  value: string | null;
  /** Mostra o valor como status (ícone e texto) em vez de número grande. */
  valueIndicator?: 'success' | 'warning' | 'error';
  pending: { type: 'loading' | 'warning' | 'error'; text: string } | null;
  detail?: React.ReactNode;
  action?: { text: string; href: string; onFollow(): void };
}

/** Indicador grande. O valor e o estado nunca aparecem juntos: ou foi lido, ou diz por que não. */
export function Kpi({ label, value, valueIndicator, pending, detail, action }: KpiProps): JSX.Element {
  const read = value !== null && !pending;
  return (
    <Container fitHeight>
      <SpaceBetween size="xxs">
        <Box variant="awsui-key-label">{label}</Box>
        {read && !valueIndicator && <Box variant="awsui-value-large" tagOverride="p" margin={{ vertical: 'n' }}>{value}</Box>}
        {read && valueIndicator && <Box fontSize="heading-l" fontWeight="bold" padding={{ vertical: 'xs' }}><StatusIndicator type={valueIndicator}>{value}</StatusIndicator></Box>}
        {!read && <Box padding={{ vertical: 'xs' }}><StatusIndicator type={pending?.type ?? 'warning'}>{pending?.text ?? ''}</StatusIndicator></Box>}
        {detail && <Box variant="small" color="text-body-secondary">{detail}</Box>}
        {action && <InternalLink href={action.href} onFollow={action.onFollow}>{action.text}</InternalLink>}
      </SpaceBetween>
    </Container>
  );
}

function healthText(level: HealthLevel, pt: boolean): string {
  if (level === 'success') return pt ? 'Saudável' : 'Healthy';
  if (level === 'warning') return pt ? 'Com avisos' : 'Has warnings';
  if (level === 'error') return pt ? 'Com falha' : 'Failing';
  return pt ? 'Não lida' : 'Not read';
}

/** Moldura padrão de um widget fora do Board: o mesmo `Container` que a Home sempre usou. */
function Framed({ parts }: { parts: WidgetParts }): JSX.Element {
  return <Container fitHeight header={parts.header} disableContentPaddings={parts.flush}>{parts.body}</Container>;
}

export function recentResourcesParts({ recent, pt, onPath, onView, onRetry }: Pick<DevHomeViewProps, 'recent' | 'pt' | 'onPath' | 'onView' | 'onRetry'>): WidgetParts {
  const header = (
    <Header
      variant="h2"
      counter={recent.status === 'ready' ? `(${recent.data.length})` : undefined}
      description={pt
        ? 'Instâncias kro de todos os serviços, as mais novas primeiro. Recursos ACK aparecem na página de cada serviço.'
        : 'kro instances across every service, newest first. ACK resources show on each service page.'}
      actions={<Button onClick={() => onView('catalog')}>{pt ? 'Ver por serviço' : 'View by service'}</Button>}
    >
      {pt ? 'Recursos recentes' : 'Recent resources'}
    </Header>
  );
  if (recent.status === 'error') {
    return { header, body: <LoadFailure message={recent.message} pt={pt} onRetry={onRetry} /> };
  }
  const items = recent.status === 'ready' ? recent.data : [];
  const body = (
    <SpaceBetween size="s">
      {recent.status === 'ready' && <SourceWarning partial={Boolean(recent.partial)} sources={recent.sources} pt={pt} />}
      <Table
        variant="borderless"
        items={items}
        trackBy={row => `${row.capability}/${row.namespace}/${row.name}`}
        loading={recent.status === 'loading'}
        loadingText={pt ? 'Lendo os recursos live do cluster' : 'Reading live resources from the cluster'}
        ariaLabels={{ tableLabel: pt ? 'Recursos recentes' : 'Recent resources' }}
        wrapLines={false}
        columnDefinitions={[
          {
            id: 'name',
            header: pt ? 'Nome' : 'Name',
            isRowHeader: true,
            cell: row => <InternalLink href={detailPath(row)} onFollow={() => onPath(detailPath(row))}>{row.name}</InternalLink>,
          },
          {
            id: 'service',
            header: pt ? 'Serviço' : 'Service',
            cell: row => <InternalLink href={listPath(row.capability)} onFollow={() => onPath(listPath(row.capability))}>{row.capability}</InternalLink>,
          },
          { id: 'namespace', header: 'Namespace', cell: row => row.namespace || '-' },
          { id: 'state', header: pt ? 'Estado' : 'State', cell: row => <LiveStatus indicator={stateIndicator(row, pt)} /> },
          {
            id: 'created',
            header: pt ? 'Criado há' : 'Created',
            cell: row => {
              const parsed = row.created ? Date.parse(row.created) : NaN;
              const seconds = Number.isFinite(parsed) ? ((row.freshness?.readAt ?? Date.now() / 1000) - parsed / 1000) : null;
              return relativeAge(seconds, pt);
            },
          },
        ]}
        empty={
          recent.status === 'ready' && recent.partial
            ? <Box textAlign="center" color="text-status-warning">{pt ? 'Nenhum recurso nas fontes que responderam. As que falharam estão no aviso acima.' : 'No resource in the sources that answered. The failed ones are in the warning above.'}</Box>
            : (
              <Box textAlign="center" padding="m">
                <SpaceBetween size="xs">
                  <Box variant="strong">{pt ? 'Você ainda não tem recursos' : 'You have no resources yet'}</Box>
                  <Box variant="p" color="inherit">{pt ? 'Comece pelo catálogo ou crie um site de teste em 10 minutos.' : 'Start from the catalog or create a test site in 10 minutes.'}</Box>
                  <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                    <Button onClick={() => onView('getting-started')}>{pt ? 'Primeiros passos' : 'Getting started'}</Button>
                    <Button variant="primary" onClick={() => onView('catalog')}>{pt ? 'Abrir o catálogo' : 'Open the catalog'}</Button>
                  </SpaceBetween>
                </SpaceBetween>
              </Box>
            )
        }
      />
    </SpaceBetween>
  );
  return { header, body };
}

export function RecentResources(props: Pick<DevHomeViewProps, 'recent' | 'pt' | 'onPath' | 'onView' | 'onRetry'>): JSX.Element {
  return <Framed parts={recentResourcesParts(props)} />;
}

function elapsedLabel(item: OperationItem, pt: boolean): string {
  const elapsed = relativeAge(item.elapsedSeconds, pt);
  if (item.budgetSeconds === null) return pt ? `${elapsed} desde a criação` : `${elapsed} since creation`;
  const budget = relativeAge(item.budgetSeconds, pt);
  return pt ? `${elapsed} de ~${budget} previstos` : `${elapsed} of ~${budget} expected`;
}

export function operationsParts({ operations, pt, onPath, onRetry }: Pick<DevHomeViewProps, 'operations' | 'pt' | 'onPath' | 'onRetry'>): WidgetParts {
  const ready = operations.status === 'ready' ? operations : null;
  const shown = ready ? ready.data.items.slice(0, 5) : [];
  const hidden = ready ? Math.max(0, ready.data.total - shown.length) : 0;
  const header = (
    <Header
      variant="h2"
      counter={ready ? `(${ready.data.total})` : undefined}
      description={pt
        ? 'O que ainda não está pronto. O percentual é estimado pelo tempo de convergência; o controller não reporta progresso.'
        : 'What is not ready yet. The percentage is estimated from the converge budget; the controller does not report progress.'}
    >
      {pt ? 'Operações em andamento' : 'Operations in progress'}
    </Header>
  );
  const body = (
    <>
      {operations.status === 'loading' && <StatusIndicator type="loading">{pt ? 'Lendo o que está provisionando' : 'Reading what is provisioning'}</StatusIndicator>}
      {operations.status === 'error' && <LoadFailure message={operations.message} pt={pt} onRetry={onRetry} />}
      {ready && (
        <SpaceBetween size="m">
          <SourceWarning partial={Boolean(ready.partial)} sources={ready.sources} pt={pt} />
          {shown.length === 0
            ? (ready.partial
              ? <StatusIndicator type="warning">{pt ? 'Nada em andamento nas fontes que responderam' : 'Nothing in progress in the sources that answered'}</StatusIndicator>
              : <StatusIndicator type="success">{pt ? 'Nada provisionando agora: todos os recursos estão prontos' : 'Nothing provisioning right now: every resource is ready'}</StatusIndicator>)
            : (
              <List
                ariaLabel={pt ? 'Operações em andamento' : 'Operations in progress'}
                items={shown}
                renderItem={item => {
                  const phase = phaseIndicator(item.phase, pt);
                  return {
                    id: `${item.row.capability}/${item.row.namespace}/${item.row.name}`,
                    announcementLabel: `${item.row.name}: ${phase.text}`,
                    content: (
                      <SpaceBetween size="xxs">
                        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                          <InternalLink href={detailPath(item.row)} onFollow={() => onPath(detailPath(item.row))}>{item.row.name}</InternalLink>
                          <Box variant="small" color="text-body-secondary">{item.row.capability} · {item.row.namespace}</Box>
                        </SpaceBetween>
                        <StatusIndicator type={phase.type}>{phase.text}</StatusIndicator>
                        {item.percent !== null && (
                          <ProgressBar
                            value={item.percent}
                            status={progressStatus(item.phase)}
                            label={pt ? `Progresso estimado de ${item.row.name}` : `Estimated progress of ${item.row.name}`}
                            description={elapsedLabel(item, pt)}
                            resultText={item.phase === 'blocked' ? (pt ? 'O controller reportou falha' : 'The controller reported a failure') : undefined}
                          />
                        )}
                        {item.percent === null && <Box variant="small" color="text-body-secondary">{elapsedLabel(item, pt)}</Box>}
                      </SpaceBetween>
                    ),
                  };
                }}
              />
            )}
          {hidden > 0 && (
            <Box variant="small" color="text-body-secondary">
              {pt ? `Mais ${hidden} na página de cada serviço.` : `${hidden} more on each service page.`}
            </Box>
          )}
        </SpaceBetween>
      )}
    </>
  );
  return { header, body };
}

export function OperationsPanel(props: Pick<DevHomeViewProps, 'operations' | 'pt' | 'onPath' | 'onRetry'>): JSX.Element {
  return <Framed parts={operationsParts(props)} />;
}

export function activityParts({ activity, pt, onView }: Pick<DevHomeViewProps, 'activity' | 'pt' | 'onView'>): WidgetParts {
  const warnings = activity.status === 'ready' ? activity.data.filter(item => item.type === 'warning').length : 0;
  const header = (
    <Header
      variant="h2"
      description={activity.status === 'ready'
        ? (pt ? `Eventos do cluster, mais recentes primeiro · ${warnings} ${warnings === 1 ? 'aviso' : 'avisos'}` : `Cluster events, newest first · ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`)
        : (pt ? 'Eventos do cluster, mais recentes primeiro' : 'Cluster events, newest first')}
      actions={<Button variant="inline-link" onClick={() => onView('cluster')}>{pt ? 'Ver no Cluster' : 'View in Cluster'}</Button>}
    >
      {pt ? 'Atividade' : 'Activity'}
    </Header>
  );
  const body = (
    <>
      {activity.status === 'loading' && <StatusIndicator type="loading">{pt ? 'Lendo os eventos' : 'Reading events'}</StatusIndicator>}
      {activity.status === 'error' && <StatusIndicator type="error">{pt ? `Eventos indisponíveis: ${activity.message}` : `Events unavailable: ${activity.message}`}</StatusIndicator>}
      {activity.status === 'ready' && (activity.data.length === 0
        ? <Box color="text-body-secondary">{pt ? 'Nenhum evento recente no cluster.' : 'No recent cluster event.'}</Box>
        : (
          <List
            ariaLabel={pt ? 'Atividade recente do cluster' : 'Recent cluster activity'}
            items={activity.data}
            renderItem={item => ({
              id: item.key,
              announcementLabel: `${item.type}: ${item.reason} ${item.object}`,
              content: (
                <SpaceBetween size="xxs">
                  <StatusIndicator type={item.type === 'warning' ? 'warning' : 'info'}>
                    {`${item.type === 'warning' ? (pt ? 'Aviso' : 'Warning') : 'Info'} · ${item.reason}`}
                  </StatusIndicator>
                  <Box variant="small">{item.object} · {item.namespace}{item.count > 1 ? ` · ${item.count}x` : ''} · {item.ageSeconds === null ? (pt ? 'sem horário' : 'no time') : (pt ? `há ${relativeAge(item.ageSeconds, pt)}` : `${relativeAge(item.ageSeconds, pt)} ago`)}</Box>
                  {item.message && <Box variant="small" color="text-body-secondary">{item.message}</Box>}
                </SpaceBetween>
              ),
            })}
          />
        ))}
    </>
  );
  return { header, body };
}

export function ActivityPanel(props: Pick<DevHomeViewProps, 'activity' | 'pt' | 'onView'>): JSX.Element {
  return <Framed parts={activityParts(props)} />;
}

export function healthParts({ overview, platform, pt, onView }: Pick<DevHomeViewProps, 'overview' | 'platform' | 'pt' | 'onView'>): WidgetParts {
  const loading = overview.status === 'loading' || platform.status === 'loading';
  const signals = healthSignals(
    overview.status === 'ready' ? overview.data : null,
    platform.status === 'ready' ? platform.data : null,
    pt,
  );
  const errors = [
    overview.status === 'error' ? `overview: ${overview.message}` : '',
    platform.status === 'error' ? `platform: ${platform.message}` : '',
  ].filter(Boolean);
  const header = (
    <Header
      variant="h2"
      description={pt ? 'Lido agora da cluster-api, endpoint privado do EKS.' : 'Read now from the cluster-api, private EKS endpoint.'}
      actions={<Button variant="inline-link" onClick={() => onView('cluster')}>{pt ? 'Abrir Cluster' : 'Open Cluster'}</Button>}
    >
      {pt ? 'Saúde da plataforma' : 'Platform health'}
    </Header>
  );
  const body = loading
    ? <StatusIndicator type="loading">{pt ? 'Verificando' : 'Checking'}</StatusIndicator>
    : (
      <SpaceBetween size="s">
        {signals.map(signal => (
          <div key={signal.id}>
            <Box variant="awsui-key-label">{signal.label}</Box>
            <StatusIndicator type={healthIndicatorType(signal.level)}>
              {signal.level === 'unknown' ? notRead(pt) : signal.value}
            </StatusIndicator>
          </div>
        ))}
        {errors.length > 0 && (
          <Box variant="small" color="text-status-error">
            {pt ? `Sem resposta de: ${errors.join('; ')}. Esses sinais aparecem como não lidos.` : `No answer from: ${errors.join('; ')}. Those signals show as not read.`}
          </Box>
        )}
      </SpaceBetween>
    );
  return { header, body };
}

export function HealthPanel(props: Pick<DevHomeViewProps, 'overview' | 'platform' | 'pt' | 'onView'>): JSX.Element {
  return <Framed parts={healthParts(props)} />;
}

export function scorecardsParts({ scorecards, pt, onView, onRetry }: Pick<DevHomeViewProps, 'scorecards' | 'pt' | 'onView' | 'onRetry'>): WidgetParts {
  const header = (
    <Header
      variant="h2"
      description={pt ? 'Níveis cumulativos contra platform/scorecards/standards.json, avaliados no servidor.' : 'Cumulative levels against platform/scorecards/standards.json, evaluated server-side.'}
      actions={<Button variant="inline-link" onClick={() => onView('scorecards')}>{pt ? 'Abrir Scorecards' : 'Open Scorecards'}</Button>}
    >
      Scorecards
    </Header>
  );
  if (scorecards.status === 'loading') return { header, body: <StatusIndicator type="loading">{pt ? 'Avaliando' : 'Evaluating'}</StatusIndicator> };
  if (scorecards.status === 'error') {
    return { header, body: <LoadFailure message={scorecards.message} pt={pt} onRetry={onRetry} /> };
  }
  const { summary, rules, standards, partial, sources, truncatedSources } = scorecards.data;
  const worst = rules
    .filter(rule => rule.applicable > 0)
    .map(rule => ({ ...rule, rate: rule.passed / rule.applicable, title: standards.rules.find(entry => entry.id === rule.id) }))
    .sort((a, b) => a.rate - b.rate)[0];
  const levels: ScorecardLevel[] = ['gold', 'silver', 'bronze', 'none'];
  // Leitura parcial nunca vira "vazio": com fonte falha, zero itens é "não lido", e contagem
  // presente vem com o aviso de que é piso (mesma regra I-A do inventário).
  const warning = <SourceWarning partial={partial} sources={sources} truncatedSources={truncatedSources} pt={pt} />;
  const body = summary.total === 0
    ? <SpaceBetween size="s">{warning}<Box textAlign="center" color="text-status-inactive">{partial ? (pt ? 'Nenhum recurso lido: fonte indisponível.' : 'No resource read: source unavailable.') : (pt ? 'Nenhum recurso no escopo para pontuar.' : 'No resource in scope to score.')}</Box></SpaceBetween>
    : (
      <SpaceBetween size="s">
        {warning}
        <ColumnLayout columns={4} variant="text-grid" minColumnWidth={110}>
          {levels.map(level => (
            <div key={level}>
              <Box variant="awsui-key-label">{levelLabel(level, pt)}</Box>
              <StatusIndicator type={levelIndicator({ level, passed: 0, total: 0 }, pt).type}>{summary.byLevel[level]}</StatusIndicator>
            </div>
          ))}
        </ColumnLayout>
        {worst && worst.rate < 1 && (
          <Box variant="small">
            {pt ? 'Regra que mais derruba nível: ' : 'Rule costing the most levels: '}
            <Box variant="strong" display="inline">{worst.title ? (pt ? worst.title.titlePt : worst.title.title) : worst.id}</Box>
            {` (${worst.passed}/${worst.applicable})`}
          </Box>
        )}
        {!scorecards.data.argoReadable && <Box variant="small" color="text-status-warning">{argoUnreadableNote(pt)}</Box>}
      </SpaceBetween>
    );
  return { header, body };
}

export function nextStepsParts({ steps, pt, onTarget }: { steps: NextStep[]; pt: boolean; onTarget(target: StepTarget): void }): WidgetParts {
  const header = <Header variant="h2" description={pt ? 'Sugeridos a partir do que a plataforma leu agora.' : 'Suggested from what the platform read just now.'}>{pt ? 'Próximos passos' : 'Next steps'}</Header>;
  const body = (
    <List
      ariaLabel={pt ? 'Próximos passos' : 'Next steps'}
      tagOverride="ol"
      items={steps}
      renderItem={step => ({
        id: step.id,
        announcementLabel: step.title,
        content: <Box variant="strong">{step.title}</Box>,
        secondaryContent: step.description,
        actions: (
          <Button
            variant={step.primary ? 'primary' : 'normal'}
            href={hrefOf(step.target)}
            ariaLabel={`${step.action}: ${step.title}`}
            onFollow={event => { event.preventDefault(); onTarget(step.target); }}
          >
            {step.action}
          </Button>
        ),
      })}
    />
  );
  return { header, body };
}

export function NextStepsPanel(props: { steps: NextStep[]; pt: boolean; onTarget(target: StepTarget): void }): JSX.Element {
  return <Framed parts={nextStepsParts(props)} />;
}

function dashboardIssueText(issue: DashboardIssue, pt: boolean): { header: string; detail: string } {
  if (issue === 'conflict') return {
    header: pt ? 'Layout atualizado' : 'Layout updated',
    detail: pt ? 'Outra aba salvou uma mudança primeiro. A versão mais recente foi carregada.' : 'Another tab saved first. The latest version was loaded.',
  };
  if (issue === 'unavailable') return {
    header: pt ? 'Layout salvo apenas nesta sessão' : 'Layout saved for this session only',
    detail: pt ? 'O storage do browser está indisponível. A Home continua funcionando, mas a mudança pode não sobreviver ao reload.' : 'Browser storage is unavailable. The Home still works, but this change may not survive reload.',
  };
  return {
    header: pt ? 'Layout inválido' : 'Invalid layout',
    detail: pt ? 'A mudança não foi persistida. Restaure o padrão e tente novamente.' : 'The change was not persisted. Reset the layout and try again.',
  };
}

/* -------------------------------------------------------------------------- */
/* View                                                                        */
/* -------------------------------------------------------------------------- */

export function DevHomeView(props: DevHomeViewProps): JSX.Element {
  const { pt, entries, catalogLoading, catalogError, recent, operations, overview, platform, onView, onPath } = props;
  const summary = useMemo(() => catalogSummary(entries), [entries]);
  const featured = useMemo(() => featuredServices(entries), [entries]);
  const signals = healthSignals(overview.status === 'ready' ? overview.data : null, platform.status === 'ready' ? platform.data : null, pt);
  const health = overallHealth(signals);
  const healthLoading = overview.status === 'loading' || platform.status === 'loading';
  const catalogUnread = !catalogLoading && summary.total > 0 && summary.unknown === summary.total;
  const steps = useMemo(() => nextSteps({
    pt,
    catalog: catalogLoading ? null : summary,
    operations: operations.status === 'ready' ? operations.data.items : null,
    trackedAgent: props.trackedAgent,
    detailPathOf: row => detailPath(row),
  }), [pt, catalogLoading, summary, operations, props.trackedAgent]);
  const blocked = operations.status === 'ready' ? operations.data.items.filter(item => item.phase === 'blocked').length : 0;
  const onTarget = useCallback((target: StepTarget) => ('view' in target ? onView(target.view) : onPath(target.path)), [onView, onPath]);
  const [showPalette, setShowPalette] = useState(false);
  const dashboardState = props.dashboard?.state;
  const dashboard = props.dashboard && dashboardState?.status === 'ready'
    ? { controller: props.dashboard, state: dashboardState }
    : null;
  const dashboardIssue = dashboard?.state.issue ? dashboardIssueText(dashboard.state.issue, pt) : null;

  const catalogPending = catalogLoading
    ? { type: 'loading' as const, text: pt ? 'Lendo' : 'Reading' }
    : catalogUnread ? { type: 'warning' as const, text: notRead(pt) } : null;

  const kpis = (
    // ColumnLayout com minColumnWidth: CSS grid auto-fit, sem breakpoint em JS. Dentro do Board
    // o Grid de 12 colunas media a largura cedo demais e ficava em 2 por linha (medido 24/10/2026).
    <ColumnLayout columns={4} minColumnWidth={220}>
      <Kpi
        label={pt ? 'Serviços em uso' : 'Services in use'}
        value={`${summary.added}`}
        pending={catalogPending}
        detail={pt ? `de ${summary.total} no catálogo · ${summary.requestable} disponíveis para pedir` : `of ${summary.total} in the catalog · ${summary.requestable} requestable`}
        action={{ text: pt ? 'Abrir o catálogo' : 'Open the catalog', href: '#catalog', onFollow: () => onView('catalog') }}
      />
      <Kpi
        label={pt ? 'Instâncias live' : 'Live instances'}
        value={summary.instances === null ? null : `${summary.instances}`}
        pending={catalogPending ?? (summary.instances === null ? { type: 'warning', text: pt ? 'Parte das contagens não foi lida' : 'Some counts were not read' } : null)}
        detail={pt ? 'Somadas da contagem por serviço' : 'Summed from the per-service count'}
      />
      <Kpi
        label={pt ? 'Em andamento' : 'In progress'}
        value={operations.status === 'ready' ? `${operations.data.total}` : null}
        pending={operations.status === 'loading'
          ? { type: 'loading', text: pt ? 'Lendo' : 'Reading' }
          : operations.status === 'error' ? { type: 'error', text: pt ? 'Leitura falhou' : 'Read failed' } : null}
        detail={operations.status === 'ready'
          ? (blocked ? (pt ? `${blocked} com falha` : `${blocked} failed`) : (pt ? 'nenhum com falha' : 'none failed'))
          : undefined}
      />
      <Kpi
        label={pt ? 'Saúde da plataforma' : 'Platform health'}
        value={healthLoading ? null : healthText(health, pt)}
        valueIndicator={healthIndicatorType(health)}
        pending={healthLoading ? { type: 'loading', text: pt ? 'Verificando' : 'Checking' } : health === 'unknown' ? { type: 'warning', text: healthText(health, pt) } : null}
        detail={pt ? 'Nodes, pods e compositions' : 'Nodes, pods and compositions'}
        action={{ text: pt ? 'Abrir Cluster' : 'Open Cluster', href: '#cluster', onFollow: () => onView('cluster') }}
      />
    </ColumnLayout>
  );

  const catalogHeader = (
    <Header
      variant="h2"
      counter={`(${featured.length}/${summary.total})`}
      description={pt
        ? 'Os serviços em uso primeiro, depois o que você pode pedir agora. Create abre o wizard governado: o pedido vira MR e o Argo CD aplica.'
        : 'Services in use first, then what you can request now. Create opens the governed wizard: the request becomes an MR and Argo CD applies it.'}
      actions={<Button onClick={() => onView('catalog')}>{pt ? `Ver os ${summary.total} serviços` : `See all ${summary.total} services`}</Button>}
    >
      {pt ? 'Do catálogo' : 'From the catalog'}
    </Header>
  );
  const catalogBody = (
    <SpaceBetween size="s">
      {catalogLoading && <StatusIndicator type="loading">{pt ? 'Lendo a contagem live do catálogo' : 'Reading the live catalog count'}</StatusIndicator>}
      <ServiceCards
        entries={featured}
        pt={pt}
        empty={<Box textAlign="center">{pt ? 'Nenhum serviço disponível para pedir agora.' : 'No service available to request right now.'}</Box>}
        onOpen={props.onOpenService}
        onCreate={props.onCreate}
      />
    </SpaceBetween>
  );

  const dashboardWidgets: Record<WidgetId, WidgetParts> = {
    'overview-summary': { header: <Header variant="h2">{WIDGET_REGISTRY['overview-summary'].title[pt ? 'pt' : 'en']}</Header>, body: kpis },
    'recent-resources': recentResourcesParts({ recent, pt, onPath, onView, onRetry: props.onRetry }),
    'in-progress-operations': operationsParts({ operations, pt, onPath, onRetry: props.onRetry }),
    'catalog-highlights': { header: catalogHeader, body: catalogBody },
    'next-steps': nextStepsParts({ steps, pt, onTarget }),
    'platform-health': healthParts({ overview, platform, pt, onView }),
    activity: activityParts({ activity: props.activity, pt, onView }),
    scorecards: scorecardsParts({ scorecards: props.scorecards, pt, onView, onRetry: props.onRetry }),
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={pt
            ? 'Seu ponto de partida: o que você tem rodando, o que está provisionando e o que dá para pedir agora. Tudo lido do cluster na hora.'
            : 'Your starting point: what you have running, what is provisioning and what you can request now. All read from the cluster on open.'}
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              {dashboard && (
                <Button iconName="add-plus" onClick={() => setShowPalette(value => !value)}>
                  {showPalette ? (pt ? 'Fechar widgets' : 'Close widgets') : (pt ? 'Adicionar widget' : 'Add widget')}
                </Button>
              )}
              {dashboard && <Button onClick={dashboard.controller.reset}>{pt ? 'Restaurar padrão' : 'Reset layout'}</Button>}
              <Button onClick={() => onView('agent-builder')}>{pt ? 'Criar agent' : 'Build an agent'}</Button>
              <Button onClick={() => onView('catalog')}>{pt ? 'Catálogo de serviços' : 'Service catalog'}</Button>
              <Button variant="primary" onClick={() => onView('provision')}>{pt ? 'Provisionar' : 'Provision'}</Button>
            </SpaceBetween>
          }
        >
          {pt ? 'Início' : 'Home'}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {!!catalogError && (
          <Alert type="error" header={pt ? 'Contagem live indisponível' : 'Live count unavailable'}>
            {pt
              ? `A cluster-api não respondeu: ${catalogError}. O catálogo segue navegável, nenhum serviço é mostrado como adicionado sem leitura, e a contagem é lida de novo a cada 30 segundos.`
              : `The cluster-api did not respond: ${catalogError}. The catalog stays browsable, no service is shown as added without a read, and the count is read again every 30 seconds.`}
          </Alert>
        )}

        {props.dashboard?.state.status === 'error' && (
          <Alert type="warning" header={pt ? 'Personalização indisponível' : 'Customization unavailable'}>
            {pt ? 'A Home continua no layout padrão. A personalização não está disponível para esta sessão ou project.' : 'The Home remains on the default layout. Customization is not available for this session or project.'}
          </Alert>
        )}

        {dashboard ? (
          <>
            {dashboardIssue && (
              <Alert type="warning" header={dashboardIssue.header}>
                {dashboardIssue.detail}
              </Alert>
            )}
            <DashboardBoard
              layout={dashboard.state.layout}
              palette={dashboard.state.palette}
              showPalette={showPalette}
              pt={pt}
              widgets={dashboardWidgets}
              onChange={dashboard.controller.setWidgets}
            />
          </>
        ) : (
          <>
            {kpis}
            <Grid gridDefinition={HOME_LAYOUT.work}>
              <Framed parts={dashboardWidgets['recent-resources']} />
              <Framed parts={dashboardWidgets['in-progress-operations']} />
            </Grid>
            <SpaceBetween size="s">
              {catalogHeader}
              {catalogBody}
            </SpaceBetween>
            <Grid gridDefinition={HOME_LAYOUT.context}>
              <Framed parts={dashboardWidgets['next-steps']} />
              <Framed parts={dashboardWidgets['platform-health']} />
              <Framed parts={dashboardWidgets.activity} />
            </Grid>
            <Framed parts={dashboardWidgets.scorecards} />
          </>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}

/* -------------------------------------------------------------------------- */
/* Página com as leituras                                                      */
/* -------------------------------------------------------------------------- */

export interface DevHomePageProps {
  /** Contagem live do shell. É a mesma fonte do menu lateral e do catálogo. */
  counts: LiveCounts;
  onNavigateView(view: string): void;
  onNavigatePath(path: string): void;
}

const CONTEXT_REFRESH_MS = 60_000;
const RECENT_LIMIT = 6;
const OPERATIONS_LIMIT = 20;

function asReady<T>(data: T, response: Pick<InstancesResponse, 'partial' | 'sources' | 'readAt'>): Remote<T> {
  return { status: 'ready', data, partial: response.partial, sources: response.sources, readAt: response.readAt };
}

export function DevHomePage({ counts, onNavigateView, onNavigatePath }: DevHomePageProps): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const dashboard = useComposableDashboard();
  const [recent, setRecent] = useState<Remote<InstanceRow[]>>(LOADING);
  const [operations, setOperations] = useState<Remote<OperationsData>>(LOADING);
  const [activity, setActivity] = useState<Remote<ActivityItem[]>>(LOADING);
  const [overview, setOverview] = useState<Remote<ClusterOverview>>(LOADING);
  const [platform, setPlatform] = useState<Remote<PlatformView>>(LOADING);
  const [scorecards, setScorecards] = useState<Remote<ScorecardsResponse>>(LOADING);
  const [nonce, setNonce] = useState(0);
  const trackedAgent = useMemo(() => loadTracked()?.name ?? null, []);
  const entries = useMemo(() => buildServiceCatalog(allCapabilities, counts), [counts]);
  const timer = useRef<number | undefined>(undefined);

  // Recursos e operações: polling adaptativo, rápido enquanto algo converge (a mesma cadência das
  // páginas de serviço). Cada leitura tem o seu estado; uma falha não apaga a outra.
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      const failure = (cause: unknown) => (cause instanceof InventoryError && cause.aborted ? null : errorMessage(cause, 'cluster-api unavailable'));
      const [recentResult, operationsResult] = await Promise.allSettled([
        listInstances({ namespace: ALL_NAMESPACES, sort: 'created', order: 'desc', limit: RECENT_LIMIT }, controller.signal),
        listInstances({ namespace: ALL_NAMESPACES, ready: 'false', sort: 'created', order: 'desc', limit: OPERATIONS_LIMIT }, controller.signal),
      ]);
      if (!active) return;
      const seen: InstanceRow[] = [];
      let partial = false;
      if (recentResult.status === 'fulfilled') {
        const rows = recentResources(recentResult.value.items, RECENT_LIMIT);
        seen.push(...rows);
        partial = partial || recentResult.value.partial;
        setRecent(asReady(rows, recentResult.value));
      } else {
        const message = failure(recentResult.reason);
        if (message !== null) setRecent({ status: 'error', message });
      }
      if (operationsResult.status === 'fulfilled') {
        const items = operationsInProgress(operationsResult.value.items, operationsResult.value.readAt);
        seen.push(...items.map(item => item.row));
        partial = partial || operationsResult.value.partial;
        setOperations(asReady({ items, total: operationsResult.value.total }, operationsResult.value));
      } else {
        const message = failure(operationsResult.reason);
        if (message !== null) setOperations({ status: 'error', message });
      }
      const delay = recentResult.status === 'rejected' && operationsResult.status === 'rejected'
        ? CONTEXT_REFRESH_MS
        : nextRefreshDelay({ items: seen, partial });
      timer.current = window.setTimeout(() => { if (active) void load(); }, delay);
    };
    void load();
    return () => { active = false; controller.abort(); window.clearTimeout(timer.current); };
  }, [nonce]);

  // Saúde e atividade mudam devagar e custam mais: uma leitura por minuto basta.
  useEffect(() => {
    let active = true;
    const load = async () => {
      const [overviewResult, platformResult, eventsResult, scorecardsResult] = await Promise.allSettled([getOverview(), getPlatformView(), getEvents(ALL_NAMESPACES), listScorecards(ALL_NAMESPACES)]);
      if (!active) return;
      setScorecards(scorecardsResult.status === 'fulfilled' ? { status: 'ready', data: scorecardsResult.value } : { status: 'error', message: errorMessage(scorecardsResult.reason, 'cluster-api unavailable') });
      setOverview(overviewResult.status === 'fulfilled' ? { status: 'ready', data: overviewResult.value } : { status: 'error', message: errorMessage(overviewResult.reason, 'cluster-api unavailable') });
      setPlatform(platformResult.status === 'fulfilled' ? { status: 'ready', data: platformResult.value } : { status: 'error', message: errorMessage(platformResult.reason, 'cluster-api unavailable') });
      setActivity(eventsResult.status === 'fulfilled'
        ? { status: 'ready', data: activityFeed(eventsResult.value.events ?? []) }
        : { status: 'error', message: errorMessage(eventsResult.reason, 'cluster-api unavailable') });
    };
    void load();
    const interval = window.setInterval(() => void load(), CONTEXT_REFRESH_MS);
    return () => { active = false; window.clearInterval(interval); };
  }, [nonce]);

  const onCreate = useCallback((entry: ServiceEntry) => {
    // O mesmo registro duplo do catálogo: o hash sobrevive ao reload, o storage ao lazy load.
    writeCreateIntent(createIntentFor(entry));
    onNavigateView(createHref(entry).slice(1));
  }, [onNavigateView]);

  const retry = useCallback(() => {
    setRecent(LOADING); setOperations(LOADING); setActivity(LOADING); setOverview(LOADING); setPlatform(LOADING); setScorecards(LOADING);
    setNonce(value => value + 1);
  }, []);

  return (
    <DevHomeView
      pt={pt}
      entries={entries}
      catalogLoading={Boolean(counts.loading)}
      catalogError={counts.error ?? ''}
      recent={recent}
      operations={operations}
      activity={activity}
      overview={overview}
      platform={platform}
      scorecards={scorecards}
      trackedAgent={trackedAgent}
      dashboard={dashboard}
      onView={onNavigateView}
      onPath={onNavigatePath}
      onOpenService={entry => onNavigatePath(listPath(entry.liveCapability))}
      onCreate={onCreate}
      onRetry={retry}
    />
  );
}

export default DevHomePage;
