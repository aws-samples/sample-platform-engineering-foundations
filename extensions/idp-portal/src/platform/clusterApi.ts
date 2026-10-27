// Client da cluster-api (explorer Kubernetes nativo do portal). Autenticação pelo auth adapter.
// Toda requisição leva o escopo de projeto ativo (issue #10); o servidor decide com o alias da sessão.
import { scopedPath } from './scope/activeScope';
import { errorMessage } from './errors';
import { apiFetch } from './auth/authAdapter';
import { MetricsView, NodeMetricRow, PodMetricRow, metricsFailure, parseNodeMetrics, parsePodMetrics } from './clusterMetrics';

async function request<T>(path: string, init?: RequestInit, namespace?: string): Promise<T> {
  const response = await apiFetch('cluster', scopedPath(path, { namespace }), init);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

// Métricas (cluster-metrics): 503/502 trazem um corpo com `metrics.status` que a tela precisa ler, então
// esta leitura não lança no !ok. Falha de rede/the internal gateway vira o estado `error`, nunca uma exceção.
async function readMetrics<Row>(path: string, parse: (http: number, body: unknown) => MetricsView<Row>): Promise<MetricsView<Row>> {
  try {
    const response = await apiFetch('cluster', path);
    const body: unknown = await response.json().catch(() => null);
    return parse(response.status, body);
  } catch (cause) {
    return metricsFailure(errorMessage(cause, 'cluster API unavailable'));
  }
}

export interface ClusterOverview {
  version: string;
  namespaces: string[];
  nodes: { total: number; ready: number; spot: number };
  pods: { total: number; running: number; pending: number; failed: number };
}
export interface WorkloadRow { name: string; namespace: string; kind: string; ready?: string; schedule?: string; suspend?: boolean; lastRun?: string; created: string }
export interface PodRow { name: string; namespace: string; phase: string; ready: string; restarts: number; node: string; containers: string[]; ip: string; created: string }
export interface PodDetail extends Omit<PodRow, 'containers'> {
  containers: { name: string; image: string }[];
  qos: string; serviceAccount: string;
  conditions: { type: string; status: string }[];
  events: { reason: string; message: string; type: string; count: number; last: string }[];
}
export interface NodeRow { name: string; ready: string; instanceType: string; capacityType: string; pool: string; arch: string; zone: string; version: string; cpu: string; memory: string }
export interface EventRow { namespace: string; reason: string; type: string; object: string; message: string; count: number; last: string }
export interface PlatformView {
  rgds: { name: string; state: string; kind: string; topology: number; created: string }[];
  // outputs: campos string do status da instância (url, distributionStatus...), lidos pelo trail do tour.
  instances: { name: string; namespace: string; kind: string; state: string; synced: string; created: string; outputs?: Record<string, string> }[];
}
export interface ServicesView {
  services: { name: string; namespace: string; type: string; clusterIP: string; external: string; ports: string[] }[];
  ingresses: { name: string; namespace: string; hosts: string[] }[];
}
export interface ConfigView {
  configmaps: { name: string; namespace: string; keys: string[] }[];
  secrets: { name: string; namespace: string; type: string; keys: string[] }[];
  pvcs: { name: string; namespace: string; phase: string; capacity: string; storageClass: string }[];
}

const ns = (namespace: string) => `?ns=${encodeURIComponent(namespace)}`;

export const getOverview = () => request<ClusterOverview>('/cluster/overview');
export const getWorkloads = (namespace: string) => request<Record<string, WorkloadRow[]>>(`/cluster/workloads${ns(namespace)}`);
export const getPods = (namespace: string) => request<{ pods: PodRow[] }>(`/cluster/pods${ns(namespace)}`);
export const getPodDetail = (namespace: string, name: string) => request<PodDetail>(`/cluster/pod${ns(namespace)}&name=${encodeURIComponent(name)}`);
export const getLogs = (namespace: string, name: string, container?: string) =>
  request<{ logs: string }>(`/cluster/logs${ns(namespace)}&name=${encodeURIComponent(name)}&tail=300${container ? `&container=${encodeURIComponent(container)}` : ''}`);
export const getServices = (namespace: string) => request<ServicesView>(`/cluster/services${ns(namespace)}`);
export const getConfig = (namespace: string) => request<ConfigView>(`/cluster/config${ns(namespace)}`);
export const getNodes = () => request<{ nodes: NodeRow[] }>('/cluster/nodes');
export const getEvents = (namespace: string) => request<{ events: EventRow[] }>(`/cluster/events${ns(namespace)}`);
// Contrato: pod-metrics é escopada (ns + project); node-metrics não tem query e não leva escopo.
export const getPodMetrics = (namespace: string): Promise<MetricsView<PodMetricRow>> =>
  readMetrics(scopedPath(`/cluster/pod-metrics${ns(namespace)}`), parsePodMetrics);
export const getNodeMetrics = (): Promise<MetricsView<NodeMetricRow>> => readMetrics('/cluster/node-metrics', parseNodeMetrics);
export const getPlatformView = () => request<PlatformView>('/cluster/platform');
export const scaleWorkload = (namespace: string, kind: string, name: string, replicas: number) =>
  request('/cluster/scale', { method: 'POST', body: JSON.stringify({ ns: namespace, kind, name, replicas }) }, namespace);
export const restartWorkload = (namespace: string, kind: string, name: string) =>
  request('/cluster/restart', { method: 'POST', body: JSON.stringify({ ns: namespace, kind, name }) }, namespace);
export const deletePod = (namespace: string, name: string) =>
  request('/cluster/delete-pod', { method: 'POST', body: JSON.stringify({ ns: namespace, name }) }, namespace);
