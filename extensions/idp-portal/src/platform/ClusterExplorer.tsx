import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Modal from '@cloudscape-design/components/modal';
import Select, { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table, { TableProps } from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import {
  ClusterOverview, ConfigView, EventRow, NodeRow, PlatformView, PodDetail, PodRow, ServicesView, WorkloadRow,
  deletePod, getConfig, getEvents, getLogs, getNodeMetrics, getNodes, getOverview, getPlatformView, getPodDetail, getPodMetrics, getPods,
  getServices, getWorkloads, restartWorkload, scaleWorkload,
} from './clusterApi';
import {
  METRICS_NOTICE, MetricsView, NodeMetricRow, PodMetricRow, formatCpu, formatMemory, indexNodeMetrics, indexPodMetrics,
  podMetricKey, withPercent,
} from './clusterMetrics';
import { Locale, translate, useI18n } from './i18n';
import { errorMessage } from './errors';
import { eventsOfWorkload, isFullyReady, podsOfWorkload, supportsHealthDetail } from './workloadHealth';
import { Day2Action, Day2ConfirmModal } from './Day2ConfirmModal';

function phaseIndicator(phase: string): JSX.Element {
  const type = phase === 'Running' || phase === 'Succeeded' ? 'success' : phase === 'Pending' ? 'in-progress' : 'error';
  return <StatusIndicator type={type}>{phase}</StatusIndicator>;
}

function readyIndicator(ready?: string): JSX.Element {
  if (!ready) return <span>-</span>;
  const [current, desired] = ready.split('/');
  if (desired === '0') return <StatusIndicator type="stopped">{ready}</StatusIndicator>;
  return <StatusIndicator type={current === desired ? 'success' : 'warning'}>{ready}</StatusIndicator>;
}

/** Estado das métricas acima da tabela: todo estado sem dados se explica em texto; `available` só avisa truncamento. */
export function MetricsNotice({ view, locale }: { view: MetricsView<unknown> | null; locale: Locale }): JSX.Element | null {
  if (!view) return null;
  const t = (text: string) => translate(text, locale);
  if (view.status === 'available') return view.truncated ? <Alert type="info">{t('Metrics list truncated: some rows were left out.')}</Alert> : null;
  const type = view.status === 'not_installed' ? 'info' : view.status === 'unavailable' ? 'warning' : 'error';
  return (
    <Alert type={type} header={t('CPU and memory')}>
      {t(METRICS_NOTICE[view.status])}
      {'message' in view && <Box variant="small">{t('Detail')}: {view.message}</Box>}
    </Alert>
  );
}

/** Colunas tipo `kubectl top`. Só entram quando há dados; amostra antiga é marcada com ícone E texto. */
export function metricColumns<Row>(
  sampleOf: (row: Row) => PodMetricRow | NodeMetricRow | undefined, locale: Locale,
): TableProps.ColumnDefinition<Row>[] {
  const t = (text: string) => translate(text, locale);
  const value = (text: string | null) => text ?? t('Unreadable');
  const pct = (sample: PodMetricRow | NodeMetricRow, key: 'cpuPercent' | 'memoryPercent') => ('cpuPercent' in sample ? sample[key] : null);
  return [
    { id: 'cpuUsage', header: 'CPU', cell: r => { const s = sampleOf(r); return s ? value(withPercent(formatCpu(s.cpuMillicores), pct(s, 'cpuPercent'))) : '-'; } },
    { id: 'memUsage', header: t('Memory'), cell: r => { const s = sampleOf(r); return s ? value(withPercent(formatMemory(s.memoryBytes), pct(s, 'memoryPercent'))) : '-'; } },
    {
      id: 'sample', header: t('Sample'), cell: r => {
        const s = sampleOf(r);
        if (!s) return t('No sample');
        if (s.stale) return <StatusIndicator type="warning">{t('Stale sample')}</StatusIndicator>;
        return s.windowSeconds === null ? '-' : `${s.windowSeconds}s`;
      },
    },
  ];
}

export function ClusterExplorer(): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [overview, setOverview] = useState<ClusterOverview | null>(null);
  const [namespace, setNamespace] = useState<SelectProps.Option>({ label: pt ? 'Todos os namespaces' : 'All namespaces', value: '_all' });
  const [error, setError] = useState('');
  const [tab, setTab] = useState('workloads');
  const [workloads, setWorkloads] = useState<Record<string, WorkloadRow[]>>({});
  const [pods, setPods] = useState<PodRow[]>([]);
  const [services, setServices] = useState<ServicesView | null>(null);
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [podMetrics, setPodMetrics] = useState<MetricsView<PodMetricRow> | null>(null);
  const [nodeMetrics, setNodeMetrics] = useState<MetricsView<NodeMetricRow> | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [platform, setPlatform] = useState<PlatformView | null>(null);
  const [loading, setLoading] = useState(false);
  const [logModal, setLogModal] = useState<{ pod: PodRow; text: string; container?: string } | null>(null);
  const [detail, setDetail] = useState<PodDetail | null>(null);
  const [scaleModal, setScaleModal] = useState<{ row: WorkloadRow; replicas: string } | null>(null);
  const [opMessage, setOpMessage] = useState('');
  // Restart e Delete pod só saem do botão Confirmar do modal, nunca do clique na tabela.
  const [pendingOp, setPendingOp] = useState<Day2Action | null>(null);
  const [opBusy, setOpBusy] = useState(false);
  const [health, setHealth] = useState<{ row: WorkloadRow; pods: PodRow[]; events: EventRow[]; loading: boolean; error: string } | null>(null);

  const openHealth = async (row: WorkloadRow) => {
    setHealth({ row, pods: [], events: [], loading: true, error: '' });
    try {
      const [podList, eventList] = await Promise.all([getPods(row.namespace), getEvents(row.namespace)]);
      setHealth({
        row, loading: false, error: '',
        pods: podsOfWorkload(row.kind, row.name, row.namespace, podList.pods),
        events: eventsOfWorkload(row.kind, row.name, eventList.events),
      });
    } catch (cause) {
      setHealth({ row, pods: [], events: [], loading: false, error: errorMessage(cause, 'cluster API unavailable') });
    }
  };

  const nsValue = String(namespace.value);

  const refresh = useCallback(async (activeTab: string, ns: string) => {
    setLoading(true); setError('');
    try {
      if (activeTab === 'workloads') setWorkloads(await getWorkloads(ns));
      else if (activeTab === 'pods') {
        // getPodMetrics nunca lança: a lista de pods não depende do metrics-server.
        const [list, metrics] = await Promise.all([getPods(ns), getPodMetrics(ns)]);
        setPods(list.pods); setPodMetrics(metrics);
      }
      else if (activeTab === 'services') setServices(await getServices(ns));
      else if (activeTab === 'config') setConfig(await getConfig(ns));
      else if (activeTab === 'nodes') {
        const [list, metrics] = await Promise.all([getNodes(), getNodeMetrics()]);
        setNodes(list.nodes); setNodeMetrics(metrics);
      }
      else if (activeTab === 'events') setEvents((await getEvents(ns)).events);
      else if (activeTab === 'platform') setPlatform(await getPlatformView());
    } catch (cause) {
      setError(errorMessage(cause, 'cluster API unavailable'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { getOverview().then(setOverview).catch(cause => setError(errorMessage(cause, 'cluster API unavailable'))); }, []);
  useEffect(() => { void refresh(tab, nsValue); }, [tab, nsValue, refresh]);

  const openLogs = async (pod: PodRow, container?: string) => {
    setLogModal({ pod, text: pt ? 'Carregando…' : 'Loading…', container });
    try {
      const { logs } = await getLogs(pod.namespace, pod.name, container);
      setLogModal({ pod, text: logs || (pt ? '(sem linhas)' : '(no lines)'), container });
    } catch (cause) {
      setLogModal({ pod, text: `erro: ${errorMessage(cause, String(cause))}`, container });
    }
  };

  const runOp = async (op: () => Promise<unknown>, success: string) => {
    setOpMessage('');
    try { await op(); setOpMessage(success); void refresh(tab, nsValue); }
    catch (cause) { setError(errorMessage(cause, 'operation failed')); }
  };

  const confirmOp = async (action: Day2Action) => {
    setOpBusy(true);
    await runOp(
      () => action.op === 'restart' ? restartWorkload(action.namespace, action.kind, action.name) : deletePod(action.namespace, action.name),
      action.op === 'restart' ? `${action.name}: restart disparado` : `${action.name}: delete solicitado`,
    );
    setOpBusy(false);
    setPendingOp(null);
  };

  const podSamples = useMemo(() => (podMetrics?.status === 'available' ? indexPodMetrics(podMetrics.rows) : null), [podMetrics]);
  const nodeSamples = useMemo(() => (nodeMetrics?.status === 'available' ? indexNodeMetrics(nodeMetrics.rows) : null), [nodeMetrics]);

  const nsOptions: SelectProps.Option[] = [
    { label: pt ? 'Todos os namespaces' : 'All namespaces', value: '_all' },
    ...(overview?.namespaces ?? []).map(n => ({ label: n, value: n })),
  ];

  const workloadTable = (kind: string, rows: WorkloadRow[]) => (
    <Table
      key={kind}
      variant="embedded"
      header={<Header variant="h3" counter={`(${rows.length})`}>{kind}</Header>}
      items={rows}
      columnDefinitions={[
        { id: 'name', header: pt ? 'Nome' : 'Name', cell: r => r.name },
        { id: 'ns', header: 'Namespace', cell: r => r.namespace },
        {
          id: 'ready', header: pt ? 'Pronto' : 'Ready', cell: r => r.kind === 'cronjob'
            ? (r.suspend ? 'suspenso' : r.schedule)
            : !isFullyReady(r.ready) && supportsHealthDetail(r.kind)
              ? <Button variant="inline-link" ariaLabel={pt ? `Por que ${r.name} não está pronto` : `Why ${r.name} is not ready`} onClick={() => void openHealth(r)}>{readyIndicator(r.ready)}</Button>
              : readyIndicator(r.ready),
        },
        {
          id: 'ops', header: pt ? 'Operações' : 'Operations', cell: r => (r.kind === 'deployment' || r.kind === 'statefulset')
            ? <SpaceBetween direction="horizontal" size="xs">
                <Button variant="inline-link" onClick={() => setScaleModal({ row: r, replicas: (r.ready ?? '1/1').split('/')[1] })}>Scale</Button>
                <Button variant="inline-link" onClick={() => setPendingOp({ op: 'restart', name: r.name, namespace: r.namespace, kind: r.kind })}>Restart</Button>
              </SpaceBetween>
            : <span>-</span>,
        },
      ]}
      empty={<Box textAlign="center" variant="small">{pt ? 'Nenhum item.' : 'None.'}</Box>}
    />
  );

  return (
    <ContentLayout header={<Header variant="h1" description={pt ? 'Explorer Kubernetes nativo do portal: leitura ampla, operações gated para admins, zero exposição do API server.' : 'Portal-native Kubernetes explorer: broad reads, admin-gated operations, zero API server exposure.'}>Cluster</Header>}>
      <SpaceBetween size="l">
        {overview && <Container>
          <KeyValuePairs columns={4} items={[
            { label: pt ? 'Versão' : 'Version', value: overview.version },
            { label: 'Nodes', value: `${overview.nodes.ready}/${overview.nodes.total} ready · ${overview.nodes.spot} spot` },
            { label: 'Pods', value: `${overview.pods.running}/${overview.pods.total} running` + (overview.pods.failed ? ` · ${overview.pods.failed} failed` : '') },
            { label: 'Namespaces', value: String(overview.namespaces.length) },
          ]} />
        </Container>}
        {!!error && <Alert type="error" dismissible onDismiss={() => setError('')}>{error}</Alert>}
        {!!opMessage && <Alert type="success" dismissible onDismiss={() => setOpMessage('')}>{opMessage}</Alert>}
        <SpaceBetween direction="horizontal" size="m">
          <FormField label="Namespace"><Select selectedOption={namespace} onChange={({ detail }) => setNamespace(detail.selectedOption)} options={nsOptions} filteringType="auto" /></FormField>
          <Box padding={{ top: 'xl' }}><Button iconName="refresh" onClick={() => void refresh(tab, nsValue)} loading={loading}>{pt ? 'Atualizar' : 'Refresh'}</Button></Box>
        </SpaceBetween>
        <Tabs activeTabId={tab} onChange={({ detail }) => setTab(detail.activeTabId)} tabs={[
          {
            id: 'workloads', label: 'Workloads',
            content: <SpaceBetween size="m">{['deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs'].map(kind => workloadTable(kind, workloads[kind] ?? []))}</SpaceBetween>,
          },
          {
            id: 'pods', label: 'Pods',
            content: <SpaceBetween size="s">
              <MetricsNotice view={podMetrics} locale={locale} />
              <Table
              header={<Header counter={`(${pods.length})`}>Pods</Header>}
              items={pods}
              columnDefinitions={[
                { id: 'name', header: pt ? 'Nome' : 'Name', cell: r => <Button variant="inline-link" onClick={() => void getPodDetail(r.namespace, r.name).then(setDetail)}>{r.name}</Button> },
                { id: 'ns', header: 'Namespace', cell: r => r.namespace },
                { id: 'phase', header: 'Status', cell: r => phaseIndicator(r.phase) },
                { id: 'ready', header: pt ? 'Pronto' : 'Ready', cell: r => readyIndicator(r.ready) },
                { id: 'restarts', header: 'Restarts', cell: r => r.restarts },
                { id: 'node', header: 'Node', cell: r => r.node },
                ...(podSamples ? metricColumns<PodRow>(r => podSamples.get(podMetricKey(r.namespace, r.name)), locale) : []),
                {
                  id: 'ops', header: pt ? 'Operações' : 'Operations', cell: r => <SpaceBetween direction="horizontal" size="xs">
                    <Button variant="inline-link" onClick={() => void openLogs(r)}>Logs</Button>
                    <Button variant="inline-link" onClick={() => setPendingOp({ op: 'delete-pod', name: r.name, namespace: r.namespace, kind: 'pod' })}>{pt ? 'Excluir' : 'Delete'}</Button>
                  </SpaceBetween>,
                },
              ]}
              empty={<Box textAlign="center">{pt ? 'Nenhum pod.' : 'No pods.'}</Box>}
              />
            </SpaceBetween>,
          },
          {
            id: 'services', label: 'Services',
            content: <SpaceBetween size="m">
              <Table variant="embedded" header={<Header variant="h3" counter={`(${services?.services.length ?? 0})`}>Services</Header>} items={services?.services ?? []}
                columnDefinitions={[
                  { id: 'name', header: pt ? 'Nome' : 'Name', cell: r => r.name },
                  { id: 'ns', header: 'Namespace', cell: r => r.namespace },
                  { id: 'type', header: pt ? 'Tipo' : 'Type', cell: r => r.type },
                  { id: 'ip', header: 'Cluster IP', cell: r => r.clusterIP },
                  { id: 'ext', header: 'External', cell: r => r.external || '-' },
                  { id: 'ports', header: pt ? 'Portas' : 'Ports', cell: r => r.ports.join(', ') },
                ]} empty={<Box textAlign="center" variant="small">-</Box>} />
              <Table variant="embedded" header={<Header variant="h3" counter={`(${services?.ingresses.length ?? 0})`}>Ingresses</Header>} items={services?.ingresses ?? []}
                columnDefinitions={[
                  { id: 'name', header: pt ? 'Nome' : 'Name', cell: r => r.name },
                  { id: 'ns', header: 'Namespace', cell: r => r.namespace },
                  { id: 'hosts', header: 'Hosts', cell: r => r.hosts.join(', ') },
                ]} empty={<Box textAlign="center" variant="small">{pt ? 'Nenhum ingress.' : 'No ingresses.'}</Box>} />
            </SpaceBetween>,
          },
          {
            id: 'config', label: pt ? 'Config e Storage' : 'Config & Storage',
            content: <SpaceBetween size="m">
              <Table variant="embedded" header={<Header variant="h3" counter={`(${config?.configmaps.length ?? 0})`}>ConfigMaps</Header>} items={config?.configmaps ?? []}
                columnDefinitions={[
                  { id: 'name', header: pt ? 'Nome' : 'Name', cell: r => r.name },
                  { id: 'ns', header: 'Namespace', cell: r => r.namespace },
                  { id: 'keys', header: pt ? 'Chaves' : 'Keys', cell: r => r.keys.join(', ') || '-' },
                ]} empty={<Box textAlign="center" variant="small">-</Box>} />
              <Table variant="embedded" header={<Header variant="h3" counter={`(${config?.secrets.length ?? 0})`} description={pt ? 'Somente nomes e chaves; valores nunca saem do cluster.' : 'Names and keys only; values never leave the cluster.'}>Secrets</Header>} items={config?.secrets ?? []}
                columnDefinitions={[
                  { id: 'name', header: pt ? 'Nome' : 'Name', cell: r => r.name },
                  { id: 'ns', header: 'Namespace', cell: r => r.namespace },
                  { id: 'type', header: pt ? 'Tipo' : 'Type', cell: r => r.type },
                  { id: 'keys', header: pt ? 'Chaves' : 'Keys', cell: r => r.keys.join(', ') || '-' },
                ]} empty={<Box textAlign="center" variant="small">-</Box>} />
              <Table variant="embedded" header={<Header variant="h3" counter={`(${config?.pvcs.length ?? 0})`}>PersistentVolumeClaims</Header>} items={config?.pvcs ?? []}
                columnDefinitions={[
                  { id: 'name', header: pt ? 'Nome' : 'Name', cell: r => r.name },
                  { id: 'ns', header: 'Namespace', cell: r => r.namespace },
                  { id: 'phase', header: 'Status', cell: r => r.phase },
                  { id: 'cap', header: pt ? 'Capacidade' : 'Capacity', cell: r => r.capacity },
                  { id: 'sc', header: 'StorageClass', cell: r => r.storageClass },
                ]} empty={<Box textAlign="center" variant="small">-</Box>} />
            </SpaceBetween>,
          },
          {
            id: 'nodes', label: 'Nodes',
            content: <SpaceBetween size="s">
              <MetricsNotice view={nodeMetrics} locale={locale} />
              <Table header={<Header counter={`(${nodes.length})`}>Nodes</Header>} items={nodes}
              columnDefinitions={[
                { id: 'name', header: pt ? 'Nome' : 'Name', cell: r => r.name },
                { id: 'ready', header: 'Ready', cell: r => <StatusIndicator type={r.ready === 'True' ? 'success' : 'error'}>{r.ready}</StatusIndicator> },
                { id: 'type', header: pt ? 'Instância' : 'Instance', cell: r => r.instanceType },
                { id: 'cap', header: 'Capacity', cell: r => <Badge color={r.capacityType === 'SPOT' ? 'blue' : 'grey'}>{r.capacityType}</Badge> },
                { id: 'pool', header: 'Pool', cell: r => r.pool },
                { id: 'arch', header: 'Arch', cell: r => r.arch },
                { id: 'zone', header: 'AZ', cell: r => r.zone },
                { id: 'cpu', header: 'vCPU', cell: r => r.cpu },
                ...(nodeSamples ? metricColumns<NodeRow>(r => nodeSamples.get(r.name), locale) : []),
                { id: 'version', header: pt ? 'Versão' : 'Version', cell: r => r.version },
              ]} empty={<Box textAlign="center">-</Box>} />
            </SpaceBetween>,
          },
          {
            id: 'events', label: 'Events',
            content: <Table header={<Header counter={`(${events.length})`}>Events</Header>} items={events}
              columnDefinitions={[
                { id: 'type', header: pt ? 'Tipo' : 'Type', cell: r => <StatusIndicator type={r.type === 'Normal' ? 'success' : 'warning'}>{r.type}</StatusIndicator> },
                { id: 'reason', header: pt ? 'Motivo' : 'Reason', cell: r => r.reason },
                { id: 'obj', header: pt ? 'Objeto' : 'Object', cell: r => r.object },
                { id: 'msg', header: pt ? 'Mensagem' : 'Message', cell: r => r.message },
                { id: 'count', header: '#', cell: r => r.count ?? 1 },
                { id: 'last', header: pt ? 'Último' : 'Last', cell: r => r.last },
              ]} empty={<Box textAlign="center">{pt ? 'Nenhum evento.' : 'No events.'}</Box>} />,
          },
          {
            id: 'platform', label: pt ? 'Plataforma (kro/ACK)' : 'Platform (kro/ACK)',
            content: <SpaceBetween size="m">
              <Table variant="embedded" header={<Header variant="h3" counter={`(${platform?.rgds.length ?? 0})`}>ResourceGraphDefinitions</Header>} items={platform?.rgds ?? []}
                columnDefinitions={[
                  { id: 'name', header: pt ? 'Nome' : 'Name', cell: r => r.name },
                  { id: 'kind', header: 'Kind', cell: r => r.kind },
                  { id: 'state', header: 'State', cell: r => <StatusIndicator type={r.state === 'Active' ? 'success' : 'error'}>{r.state}</StatusIndicator> },
                  { id: 'topo', header: pt ? 'Recursos' : 'Resources', cell: r => r.topology },
                ]} empty={<Box textAlign="center" variant="small">-</Box>} />
              <Table variant="embedded" header={<Header variant="h3" counter={`(${platform?.instances.length ?? 0})`}>{pt ? 'Instâncias kro' : 'kro instances'}</Header>} items={platform?.instances ?? []}
                columnDefinitions={[
                  { id: 'name', header: pt ? 'Nome' : 'Name', cell: r => r.name },
                  { id: 'ns', header: 'Namespace', cell: r => r.namespace },
                  { id: 'kind', header: 'Kind', cell: r => r.kind },
                  { id: 'state', header: 'State', cell: r => <StatusIndicator type={r.state === 'ACTIVE' ? 'success' : 'in-progress'}>{r.state}</StatusIndicator> },
                  { id: 'synced', header: 'Synced', cell: r => <StatusIndicator type={r.synced === 'True' ? 'success' : 'warning'}>{r.synced}</StatusIndicator> },
                ]} empty={<Box textAlign="center" variant="small">-</Box>} />
            </SpaceBetween>,
          },
        ]} />
      </SpaceBetween>

      {logModal && <Modal size="max" visible header={`Logs: ${logModal.pod.name}`} onDismiss={() => setLogModal(null)}
        footer={logModal.pod.containers.length > 1 && <SpaceBetween direction="horizontal" size="xs">{logModal.pod.containers.map(c =>
          <Button key={c} variant={c === logModal.container ? 'primary' : 'normal'} onClick={() => void openLogs(logModal.pod, c)}>{c}</Button>)}</SpaceBetween>}>
        <Box variant="code"><pre style={{ whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto', fontSize: 12 }}>{logModal.text}</pre></Box>
      </Modal>}

      {detail && <Modal size="large" visible header={`Pod: ${detail.name}`} onDismiss={() => setDetail(null)}>
        <SpaceBetween size="m">
          <KeyValuePairs columns={3} items={[
            { label: 'Namespace', value: detail.namespace }, { label: 'Status', value: detail.phase },
            { label: 'Node', value: detail.node }, { label: 'IP', value: detail.ip },
            { label: 'QoS', value: detail.qos }, { label: 'ServiceAccount', value: detail.serviceAccount },
          ]} />
          <Table variant="embedded" header={<Header variant="h3">Containers</Header>} items={detail.containers}
            columnDefinitions={[
              { id: 'name', header: pt ? 'Nome' : 'Name', cell: (r: { name: string; image: string }) => r.name },
              { id: 'image', header: pt ? 'Imagem' : 'Image', cell: (r: { name: string; image: string }) => r.image },
            ]} empty={<Box>-</Box>} />
          <Table variant="embedded" header={<Header variant="h3">Events</Header>} items={detail.events}
            columnDefinitions={[
              { id: 'reason', header: pt ? 'Motivo' : 'Reason', cell: r => r.reason },
              { id: 'msg', header: pt ? 'Mensagem' : 'Message', cell: r => r.message },
              { id: 'last', header: pt ? 'Último' : 'Last', cell: r => r.last },
            ]} empty={<Box variant="small">{pt ? 'Sem eventos.' : 'No events.'}</Box>} />
        </SpaceBetween>
      </Modal>}

      {health && <Modal size="large" visible header={`${health.row.kind}: ${health.row.name} (${health.row.ready})`} onDismiss={() => setHealth(null)}>
        <SpaceBetween size="m">
          {!!health.error && <Alert type="error">{health.error}</Alert>}
          <Box variant="p">{pt
            ? 'Pods deste workload e os eventos recentes dele, dos ReplicaSets e dos pods (inclusive os já substituídos). Clique num pod para ver containers e eventos dele. Um pod recém-criado fica fora da contagem até passar na readiness probe.'
            : 'Pods of this workload and recent events for it, its ReplicaSets and its pods (including replaced ones). Click a pod for its containers and events. A new pod stays out of the count until it passes its readiness probe.'}</Box>
          <Table variant="embedded" loading={health.loading} header={<Header variant="h3" counter={`(${health.pods.length})`}>Pods</Header>} items={health.pods}
            columnDefinitions={[
              { id: 'name', header: pt ? 'Nome' : 'Name', cell: r => <Button variant="inline-link" onClick={() => { setHealth(null); void getPodDetail(r.namespace, r.name).then(setDetail).catch(cause => setError(errorMessage(cause, 'cluster API unavailable'))); }}>{r.name}</Button> },
              { id: 'phase', header: 'Status', cell: r => phaseIndicator(r.phase) },
              { id: 'ready', header: pt ? 'Pronto' : 'Ready', cell: r => readyIndicator(r.ready) },
              { id: 'restarts', header: 'Restarts', cell: r => r.restarts },
              { id: 'created', header: pt ? 'Criado' : 'Created', cell: r => r.created },
            ]} empty={<Box variant="small">{pt ? 'Nenhum pod encontrado para este workload.' : 'No pods found for this workload.'}</Box>} />
          <Table variant="embedded" loading={health.loading} header={<Header variant="h3" counter={`(${health.events.length})`}>Events</Header>} items={health.events}
            columnDefinitions={[
              { id: 'type', header: pt ? 'Tipo' : 'Type', cell: r => <StatusIndicator type={r.type === 'Normal' ? 'success' : 'warning'}>{r.type}</StatusIndicator> },
              { id: 'reason', header: pt ? 'Motivo' : 'Reason', cell: r => r.reason },
              { id: 'obj', header: pt ? 'Objeto' : 'Object', cell: r => r.object },
              { id: 'msg', header: pt ? 'Mensagem' : 'Message', cell: r => r.message },
              { id: 'last', header: pt ? 'Último' : 'Last', cell: r => r.last },
            ]} empty={<Box variant="small">{pt ? 'Sem eventos recentes (o Kubernetes guarda eventos por cerca de 1 hora).' : 'No recent events (Kubernetes keeps events for about 1 hour).'}</Box>} />
        </SpaceBetween>
      </Modal>}

      {scaleModal && <Modal visible header={`Scale: ${scaleModal.row.name}`} onDismiss={() => setScaleModal(null)}
        footer={<Box float="right"><Button variant="primary" onClick={() => { const m = scaleModal; setScaleModal(null); void runOp(() => scaleWorkload(m.row.namespace, m.row.kind, m.row.name, Number(m.replicas)), `${m.row.name}: escalado para ${m.replicas}`); }}>{pt ? 'Aplicar' : 'Apply'}</Button></Box>}>
        <FormField label={pt ? 'Réplicas' : 'Replicas'}>
          <Input value={scaleModal.replicas} inputMode="numeric" onChange={({ detail }) => setScaleModal({ ...scaleModal, replicas: detail.value.replace(/\D/g, '') })} />
        </FormField>
      </Modal>}
      <Day2ConfirmModal action={pendingOp} busy={opBusy} pt={pt} onCancel={() => setPendingOp(null)} onConfirm={action => void confirmOp(action)} />
    </ContentLayout>
  );
}
