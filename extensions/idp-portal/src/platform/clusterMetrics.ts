/*
 * Métricas de CPU e memória (backlog cluster-metrics), no formato do `kubectl top`.
 *
 * Mapeamento puro da resposta da cluster-api para o que o Cluster Explorer mostra. O contrato é
 * tests/fixtures/cluster-metrics/contract.json (do integrador). Regras que este arquivo garante:
 *
 *   - cada um dos cinco estados vira uma visão distinta; fora de `available` não existe lista, então
 *     a tela nunca mostra tabela vazia nem zero no lugar de dado ausente;
 *   - valor ilegível (null) vira "sem leitura", nunca 0;
 *   - amostra antiga sai marcada com TEXTO (o operador é daltônico), não só com cor;
 *   - resposta fora do contrato (status desconhecido, `available` sem lista) é tratada como erro.
 */

export type MetricsStatus = 'available' | 'not_installed' | 'unavailable' | 'forbidden' | 'error';
export type MetricsFailureStatus = Exclude<MetricsStatus, 'available' | 'not_installed'>;

export interface PodMetricRow {
  name: string;
  namespace: string;
  timestamp: string | null;
  windowSeconds: number | null;
  stale: boolean;
  cpuMillicores: number | null;
  memoryBytes: number | null;
  containers: { name: string; cpuMillicores: number | null; memoryBytes: number | null }[];
}

export interface NodeMetricRow {
  name: string;
  timestamp: string | null;
  windowSeconds: number | null;
  stale: boolean;
  cpuMillicores: number | null;
  memoryBytes: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
}

export type MetricsView<Row> =
  | { status: 'available'; rows: Row[]; truncated: boolean }
  | { status: 'not_installed'; reason: string }
  | { status: MetricsFailureStatus; reason: string; message: string };

export const METRICS_COLLECTION = { pods: 'pods', nodes: 'nodes' } as const;
export type MetricsKind = keyof typeof METRICS_COLLECTION;

const STATUSES: readonly MetricsStatus[] = ['available', 'not_installed', 'unavailable', 'forbidden', 'error'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Falha local (rede, the internal gateway, corpo ilegível): o mesmo formato de erro que o servidor usa. */
export function metricsFailure<Row>(message: string, reason = 'client_error'): MetricsView<Row> {
  return { status: 'error', reason, message };
}

/** Resposta HTTP (status + corpo JSON) para a visão. Nunca lança. */
export function toMetricsView<Row>(http: number, body: unknown, kind: MetricsKind, row: (raw: Record<string, unknown>) => Row): MetricsView<Row> {
  if (!isRecord(body) || !isRecord(body.metrics)) return metricsFailure(`HTTP ${http}: unexpected metrics response`, 'invalid_response');
  const status = body.metrics.status as MetricsStatus;
  const reason = str(body.metrics.reason);
  if (!STATUSES.includes(status)) return metricsFailure(`HTTP ${http}: unknown metrics status`, 'invalid_response');
  if (status === 'available') {
    const collection = body[METRICS_COLLECTION[kind]];
    if (!Array.isArray(collection)) return metricsFailure(`HTTP ${http}: metrics available without ${kind}`, 'invalid_response');
    return { status, truncated: body.truncated === true, rows: collection.filter(isRecord).map(row) };
  }
  if (status === 'not_installed') return { status, reason };
  return { status, reason, message: str(body.error) || `HTTP ${http}` };
}

export function podMetricRow(raw: Record<string, unknown>): PodMetricRow {
  const containers = Array.isArray(raw.containers) ? raw.containers.filter(isRecord) : [];
  return {
    name: str(raw.name), namespace: str(raw.namespace), timestamp: str(raw.timestamp) || null,
    windowSeconds: num(raw.windowSeconds), stale: raw.stale === true,
    cpuMillicores: num(raw.cpuMillicores), memoryBytes: num(raw.memoryBytes),
    containers: containers.map(c => ({ name: str(c.name), cpuMillicores: num(c.cpuMillicores), memoryBytes: num(c.memoryBytes) })),
  };
}

export function nodeMetricRow(raw: Record<string, unknown>): NodeMetricRow {
  return {
    name: str(raw.name), timestamp: str(raw.timestamp) || null,
    windowSeconds: num(raw.windowSeconds), stale: raw.stale === true,
    cpuMillicores: num(raw.cpuMillicores), memoryBytes: num(raw.memoryBytes),
    cpuPercent: num(raw.cpuPercent), memoryPercent: num(raw.memoryPercent),
  };
}

export const parsePodMetrics = (http: number, body: unknown) => toMetricsView(http, body, 'pods', podMetricRow);
export const parseNodeMetrics = (http: number, body: unknown) => toMetricsView(http, body, 'nodes', nodeMetricRow);

/** CPU como o `kubectl top`: millicores inteiros. `null` quando a amostra não tem leitura. */
export function formatCpu(millicores: number | null): string | null {
  return millicores === null ? null : `${Math.round(millicores)}m`;
}

/** Memória como o `kubectl top`: Mi (Ki abaixo de 1 Mi). `null` quando a amostra não tem leitura. */
export function formatMemory(bytes: number | null): string | null {
  if (bytes === null) return null;
  const mi = bytes / (1024 * 1024);
  return mi >= 1 ? `${Math.round(mi)}Mi` : `${Math.round(bytes / 1024)}Ki`;
}

export function formatPercent(percent: number | null): string | null {
  return percent === null ? null : `${Math.round(percent)}%`;
}

/** Valor com percentual do allocatable, quando o servidor conseguiu ler o allocatable. */
export function withPercent(value: string | null, percent: number | null): string | null {
  const pct = formatPercent(percent);
  return value === null ? null : pct === null ? value : `${value} (${pct})`;
}

export const podMetricKey = (namespace: string, name: string) => `${namespace}/${name}`;

export function indexPodMetrics(rows: PodMetricRow[]): Map<string, PodMetricRow> {
  return new Map(rows.map(r => [podMetricKey(r.namespace, r.name), r]));
}

export function indexNodeMetrics(rows: NodeMetricRow[]): Map<string, NodeMetricRow> {
  return new Map(rows.map(r => [r.name, r]));
}

/** Chave de texto (traduzida em i18n.tsx) que explica cada estado sem dados. */
export const METRICS_NOTICE: Record<Exclude<MetricsStatus, 'available'>, string> = {
  not_installed: 'metrics-server is not installed in this cluster, so CPU and memory are not shown.',
  unavailable: 'Metrics unavailable: the metrics API is registered but did not answer. CPU and memory are not shown.',
  forbidden: 'Metrics forbidden: the cluster refused the metrics read. CPU and memory are not shown.',
  error: 'Metrics error: the metrics read failed. CPU and memory are not shown.',
};
