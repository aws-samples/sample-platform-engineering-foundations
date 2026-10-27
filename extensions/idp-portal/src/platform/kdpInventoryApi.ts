/*
 * Client das três rotas de LEITURA do inventário live (issues #8 e #9), servidas pela
 * cluster-api que já existe. O contrato é o do backend em backend/cluster_api:
 *
 *   GET /cluster/capabilities  capabilities vivas, com contagem por kind opcional
 *   GET /cluster/instances     listagem por capability/kind/namespace, com busca,
 *                              filtro, ordenação e paginação por cursor
 *   GET /cluster/instance      detalhe de uma instância, com conditions e trail
 *
 * Duas decisões que este arquivo carrega, e o motivo:
 *
 * 1. Filtro, ordenação e paginação são do SERVIDOR. A issue #8 exige que o namespace
 *    filtre no servidor, e o backend já aplica o namespace na URL do API server e a
 *    autorização antes de qualquer leitura. Reproduzir isso no browser seria filtrar
 *    um universo que o browser não deveria ter recebido.
 *
 * 2. O erro de origem é um objeto, não uma string. `sources[]` e `partial` existem no
 *    contrato justamente para que falha de leitura não vire lista vazia (invariante
 *    I-A do backend). Colapsar para `new Error(mensagem)` perderia o status e o nome
 *    da fonte, que é o que a UI precisa para dizer "degradado" em vez de "nada aqui".
 */
import { scopedPath } from './scope/activeScope';
import { apiFetch } from './auth/authAdapter';


/** Uma fonte lida pelo backend, com o erro dela quando houve. */
export interface LiveSource { source: string; ok: boolean; error: string }

/**
 * Falha de leitura do inventário, com o que a UI precisa para classificar:
 * 404 é "não existe", 502 é "não deu para ler", 403 é "não autorizado". Nenhum
 * dos três é empty state.
 */
export class InventoryError extends Error {
  readonly status: number;
  readonly sources: LiveSource[];
  readonly partial: boolean;
  /**
   * `true` quando a leitura foi CANCELADA por quem pediu (consulta trocou, componente desmontou).
   * Quem chama tem de distinguir isso de falha: pintar erro por um cancelamento próprio mostraria
   * um problema que não existe.
   */
  readonly aborted: boolean;
  constructor(status: number, message: string, sources: LiveSource[] = [], partial = false, aborted = false) {
    super(message);
    this.name = 'InventoryError';
    this.status = status;
    this.sources = sources;
    this.partial = partial;
    this.aborted = aborted;
  }
}

/** `true` quando a falha é um cancelamento pedido pelo próprio browser, e não um erro de leitura. */
export function isAborted(error: unknown): boolean {
  return error instanceof InventoryError && error.aborted;
}

/** `true` quando a falha é de leitura da origem, e não ausência do objeto. */
export function isSourceFailure(error: unknown): boolean {
  return error instanceof InventoryError && error.status !== 404;
}

/** `true` quando a capability, o kind ou o objeto não existem no cluster vivo. */
export function isNotFound(error: unknown): boolean {
  return error instanceof InventoryError && error.status === 404;
}

function asSources(value: unknown): LiveSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    return [{ source: String(row.source ?? ''), ok: Boolean(row.ok), error: String(row.error ?? '') }];
  });
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    // Escopo de projeto ativo (issue #10): pedido aqui, decidido no servidor.
    response = await apiFetch('cluster', scopedPath(path), { signal });
  } catch (cause) {
    // Cancelamento é um resultado esperado, não falha de leitura: ele vem marcado para que a UI
    // descarte a resposta em silêncio em vez de pintar erro de algo que ela mesma abortou.
    const aborted = (cause instanceof Error && cause.name === 'AbortError') || Boolean(signal?.aborted);
    if (aborted) throw new InventoryError(0, 'request aborted', [], false, true);
    // Rede ou assinatura: status 0 porque não houve resposta HTTP nenhuma.
    throw new InventoryError(0, cause instanceof Error && cause.message ? cause.message : 'cluster API unreachable');
  }
  const body: unknown = await response.json().catch(() => ({}));
  const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof payload.error === 'string' && payload.error ? payload.error : `HTTP ${response.status}`;
    throw new InventoryError(response.status, message, asSources(payload.sources), Boolean(payload.partial));
  }
  return body as T;
}

/* -------------------------------------------------------------------------- */
/* Tipos do contrato                                                           */
/* -------------------------------------------------------------------------- */

export type Engine = 'kro' | 'ack';

export interface LiveCapability {
  capability: string;
  engine: Engine;
  kind: string;
  apiVersion: string;
  plural: string;
  /** `false` quando o plural não saiu da discovery: aparece, mas não dá para listar. */
  listable: boolean;
  basePath: string;
  state: string;
  /** Quantos recursos o RGD compõe. 0 para ACK. */
  topology: number;
  /** Só com `counts: true`. `null` quando a contagem daquela fonte falhou. */
  instances?: number | null;
}

export interface CapabilitiesResponse {
  capabilities: LiveCapability[];
  namespace: string;
  partial: boolean;
  sources: LiveSource[];
  readAt: number;
}

/**
 * Por que Ready é false, quando é false. O backend é a única fonte disto: o
 * browser nunca deriva Ready de condition nem de generation (invariante I-B).
 * `CONDITION_<STATUS>` é gerado a partir do status real da condition, então o
 * tipo aceita string para não quebrar com um status que o controller invente.
 */
export type ReadyBasis =
  | 'CONDITION_TRUE'
  | 'CONDITION_FALSE'
  | 'CONDITION_UNKNOWN'
  | 'NO_READY_CONDITION'
  | 'STATUS_STALE'
  | 'NEGATIVE_CONDITION'
  | 'OBSERVED_GENERATION_MISSING'
  | (string & {});

export interface Freshness {
  readAt: number;
  ageSeconds: number | null;
  lastTransitionAgeSeconds: number | null;
  stale: boolean;
  staleReasons: string[];
  convergeBudgetSeconds: number;
}

export interface InstanceRow {
  name: string;
  namespace: string;
  created: string | null;
  labels: Record<string, string>;
  capability: string;
  engine: Engine;
  /** `platform.appmod/owner` ou `spec.owner`; vazio quando o objeto não declara (nunca o do projeto). */
  owner: string;
  kind: string;
  apiVersion: string;
  uid: string;
  state: string;
  synced: string;
  ready: boolean;
  readyBasis: ReadyBasis;
  generation: number | null;
  observedGeneration: number | null;
  statusStale: boolean;
  conditionCount: number;
  freshness: Freshness;
  /** Nível e contagem contra os padrões em Git; `null` quando o servidor não pôde carregar as regras. */
  scorecard: ScorecardSummary | null;
}

export interface InstancesPage {
  limit: number;
  offset: number;
  returned: number;
  /** `null` na última página. O cursor é preso à consulta que o gerou. */
  nextCursor: string | null;
}

export interface InstancesResponse {
  items: InstanceRow[];
  total: number;
  namespace: string;
  capabilities: { capability: string; kind: string; engine: Engine }[];
  kinds: string[];
  page: InstancesPage;
  partial: boolean;
  truncated: boolean;
  truncatedSources?: string[];
  instancesTruncated?: boolean;
  sources: LiveSource[];
  readAt: number;
}

export interface ConditionRow {
  type: string;
  status: string;
  reason: string;
  /** Vazia quando o backend detectou credencial na mensagem do controller. */
  message: string;
  lastTransition: string | null;
  ageSeconds: number | null;
}

export interface InstanceTrail {
  request: { requestId: string | null; requester: string | null };
  /**
   * Plano e passo do Platform Assistant que criaram o objeto (labels `plan-id`/`plan-step`).
   * O plano em si, com o MR de cada passo, só abre pela API do Assistant, que confere o projeto.
   * Opcional porque backend anterior não manda o campo.
   */
  plan?: { planId: string; step: string } | null;
  /** Arquivo de origem no GitOps, só quando o Argo prova que o objeto veio de `platform/instances`. */
  gitopsPath?: string | null;
  /** `null` quando não há annotation, ou quando a URL não é do GitLab interno. */
  mergeRequest: { url: string } | null;
  argo: {
    application: string; sync: string; health: string; revision: string;
    readable: boolean; trackedBy: string; tracked: boolean;
  };
  resource: {
    apiVersion: string; kind: string; namespace: string; name: string;
    uid: string; resourceVersion: string; capability: string;
  };
}

export interface InstanceDetail {
  capability: string;
  engine: Engine;
  owner: string;
  /** Scorecard completo (regras avaliadas no servidor). `null` quando as regras não carregaram. */
  scorecard: Scorecard | null;
  /** Grafo da RGD lido do cluster. `null` para ACK ou quando a RGD não pôde ser lida (ver `sources`). */
  composition?: CompositionGraph | null;
  /** Filhos da instância (um list por kind do grafo). `null` quando não há grafo. */
  children?: ChildResource[] | null;
  /** Revisão da definição e rollout nos filhos. `null` quando não há grafo. */
  revision?: InstanceRevision | null;
  /** `spec` sanitizado no servidor (só instância kro): insumo da promoção entre ambientes. `null` para ACK. */
  spec?: Record<string, unknown> | null;
  kind: string;
  apiVersion: string;
  metadata: {
    name: string; namespace: string; uid: string; resourceVersion: string;
    created: string | null; labels: Record<string, string>;
    annotations: Record<string, string>; finalizers: string[]; deleting: boolean;
  };
  ready: boolean;
  readyBasis: ReadyBasis;
  readyCondition: string | null;
  readyReason: string;
  generation: number | null;
  observedGeneration: number | null;
  statusStale: boolean;
  state: string;
  conditions: ConditionRow[];
  outputs: Record<string, string>;
  freshness: Freshness;
  trail: InstanceTrail;
  /** Leitura do gate. A imposição fica nos handlers POST governados. */
  actions: { day2Enforcement: string; callerIsAdmin: boolean; writePathForThisObject: string };
  partial: boolean;
  sources: LiveSource[];
  readAt: number;
}

/* -------------------------------------------------------------------------- */
/* Scorecards (backlog scorecards-standards), avaliados no servidor             */
/* -------------------------------------------------------------------------- */

export type ScorecardLevel = 'none' | 'bronze' | 'silver' | 'gold';
export const SCORECARD_LEVELS: readonly ScorecardLevel[] = ['none', 'bronze', 'silver', 'gold'];

export interface ScorecardSummary { level: ScorecardLevel; passed: number; total: number }

export interface ScorecardRuleResult {
  id: string;
  level: Exclude<ScorecardLevel, 'none'>;
  passed: boolean;
  /** Texto curto do servidor dizendo o que foi medido (`owner=team-x`, `spec.environment missing`). */
  evidence: string;
  /** Nome da regra como está em Git, para o detalhe não depender do arquivo de padrões. */
  title: string;
  titlePt: string;
}

export interface Scorecard extends ScorecardSummary {
  rules: ScorecardRuleResult[];
  /** `false` quando o Argo CD não pôde ser lido: a regra de GitOps sai como "não verificável". */
  argoReadable: boolean;
}

/** Uma regra como está no Git (platform/scorecards/standards.json), com o texto bilíngue. */
export interface StandardRule {
  id: string;
  level: Exclude<ScorecardLevel, 'none'>;
  check: string;
  engines: Engine[] | null;
  title: string;
  titlePt: string;
  description: string;
  descriptionPt: string;
}

export interface ScorecardItem {
  name: string;
  namespace: string;
  kind: string;
  capability: string;
  engine: Engine;
  owner: string;
  ready: boolean;
  scorecard: Scorecard;
}

export interface ScorecardsResponse {
  namespace: string;
  standards: { version: number; levels: Exclude<ScorecardLevel, 'none'>[]; rules: StandardRule[] };
  summary: { total: number; byLevel: Record<ScorecardLevel, number> };
  /** Por regra: a quantas instâncias se aplicou e quantas passaram. */
  rules: { id: string; applicable: number; passed: number }[];
  /** Pior nível primeiro. */
  items: ScorecardItem[];
  argoReadable: boolean;
  partial: boolean;
  truncatedSources: string[];
  sources: LiveSource[];
  readAt: number;
}

/** GET /cluster/scorecards?ns=: toda instância do escopo pontuada, com o agregado por nível e por regra. */
/* ------------------------------------------------------------------ grafo entre instâncias */

export type InstanceRelation = 'consumes' | 'declared' | 'promoted-from';

/** Nó do grafo entre instâncias (cross-instance-graph). `external` = fora do escopo (origem de uma promoção). */
export interface InstanceGraphNode {
  id: string; name: string; namespace: string; kind: string; capability: string; engine: string;
  project: string; owner: string; ready: boolean | null; external: boolean; dependsOn: string[];
}

export interface InstanceGraphEdge { from: string; to: string; relation: InstanceRelation; evidence: string }

/** GET /cluster/instance-graph. Arestas só por evidência observável; `evidence` diz o caminho exato. */
export interface InstanceGraphResponse {
  namespace: string;
  nodes: InstanceGraphNode[];
  edges: InstanceGraphEdge[];
  layers: string[][];
  cycle: string[];
  relations: Record<InstanceRelation, number>;
  partial: boolean;
  sources: LiveSource[];
  readAt: number;
}

export function getInstanceGraph(namespace: string = ALL_NAMESPACES, signal?: AbortSignal): Promise<InstanceGraphResponse> {
  const params = new URLSearchParams({ ns: namespace });
  return request<InstanceGraphResponse>(`/cluster/instance-graph?${params.toString()}`, signal);
}

/* ------------------------------------------------------------------ saúde das integrações */

export type IntegrationStatus = 'ok' | 'degraded' | 'failed' | 'unknown';

/** Uma ferramenta da plataforma, com o que o servidor MEDIU agora (integrations-health). */
export interface IntegrationRow {
  id: string; name: string; plane: string; status: IntegrationStatus; detail: string; hint: string; readAt: number;
}

export interface IntegrationsResponse { items: IntegrationRow[]; summary: Record<IntegrationStatus, number>; readAt: number }

export function getIntegrations(signal?: AbortSignal): Promise<IntegrationsResponse> {
  return request<IntegrationsResponse>('/cluster/integrations', signal);
}

export function listScorecards(namespace: string = ALL_NAMESPACES, signal?: AbortSignal): Promise<ScorecardsResponse> {
  const params = new URLSearchParams({ ns: namespace });
  return request<ScorecardsResponse>(`/cluster/scorecards?${params.toString()}`, signal);
}

/* -------------------------------------------------------------------------- */
/* Composição kro (grafo da ResourceGraphDefinition), lida do cluster           */
/* -------------------------------------------------------------------------- */

export interface CompositionNode {
  id: string;
  kind: string;
  apiVersion: string;
  /** `externalRef`: objeto que a composição referencia mas não cria. */
  external: boolean;
  dependsOn: string[];
  /** Lê algo de `schema` (o que o usuário pediu na instância). */
  usesSchema: boolean;
  readyWhen: number;
  includeWhen: number;
}

export interface CompositionGraph {
  name: string;
  kind: string;
  state: string;
  nodes: CompositionNode[];
  edges: { from: string; to: string }[];
  /** Camadas topológicas, determinísticas: o mesmo spec desenha sempre igual. */
  layers: string[][];
  /** Ids que não couberam em camada nenhuma: dependência circular no spec. */
  cycle: string[];
  outputs: { name: string; from: string[] }[];
  /** `status.topologicalOrder` do controller, quando publicado. Só para comparação. */
  controllerOrder: string[];
}

export interface CompositionGraphResponse extends CompositionGraph {
  sources: LiveSource[];
  partial: boolean;
  readAt: number;
}

/** Um campo do simpleschema (`spec.schema.spec`) da RGD, achatado em `caminho.ponto`. */
export interface SchemaField {
  path: string;
  type: string;
  required: boolean;
  default: string | null;
  description: string;
  /** Marcadores que o portal não interpreta (ex.: `enum`, `minimum`). Saem como o autor escreveu. */
  markers: Record<string, string>;
}

export interface CompositionInstances {
  /** `null` quando a fonte falhou: erro nomeado em `error`, nunca zero. */
  total: number | null;
  ready: number | null;
  notReady: number | null;
  truncated: boolean;
  error: string;
}

export interface CompositionSummary {
  name: string;
  kind: string;
  apiVersion: string;
  state: string;
  created: string | null;
  generation: number | null;
  observedGeneration: number | null;
  conditions: ConditionRow[];
  plural: string;
  /** Sem plural na discovery não há como listar instâncias; a definição segue visível. */
  listable: boolean;
  graph: CompositionGraph;
  schema: { spec: SchemaField[]; status: string[] };
  /** `null` quando `listable` é false. */
  instances: CompositionInstances | null;
  /** GraphRevisions da definição (kro >= 0.9). `items` vazio com `error` vazio = CRD ausente ou sem revisão. */
  revisions: CompositionRevisions;
  /** Rollout da revisão ativa por instância (só com `listable`). */
  rollout: InstanceRollout[];
  /** Caminho do fonte da definição no repo, para o link de edição. */
  source: string;
}

/** Um GraphRevision: snapshot imutável de uma spec da RGD. */
export interface CompositionRevision {
  revision: number | null;
  generation: number | null;
  ready: boolean;
  /** `kro.run/graph-revision-hash`; é o que os filhos levam quando são aplicados. */
  hash: string | null;
  created: string | null;
  resources: number;
}

export interface CompositionRevisions {
  items: CompositionRevision[];
  /** A revisão ativa (Ready) mais recente: é contra ela que o controller reconcilia. */
  latest: CompositionRevision | null;
  /** Emitida e ainda não pronta (compilando ou falhou). */
  pending: CompositionRevision | null;
  lastIssued: number | null;
  error: string;
}

/**
 * `current`: todo filho leva o hash da revisão ativa. `behind`: algum filho leva hash antigo.
 * `unknown`: filho sem hash (aplicado antes do hash existir) ou sem revisão lida. `no-children`: nada listado.
 */
export type RolloutStatus = 'current' | 'behind' | 'unknown' | 'no-children';

export interface RolloutSummary {
  status: RolloutStatus;
  children: number;
  withHash: number;
  onLatest: number;
  latestRevision: number | null;
}

export interface InstanceRollout { name: string; namespace: string; rollout: RolloutSummary }

/** Recurso filho de uma instância kro (label `kro.run/instance-id`). */
export interface ChildResource {
  node: string | null;
  kind: string;
  apiVersion: string;
  name: string;
  namespace: string;
  ready: boolean;
  readyBasis: ReadyBasis;
  /** `services.k8s.aws/deletion-policy` (ACK) ou `spec.deletionPolicy`; null quando não declarado. */
  deletionPolicy: string | null;
  revisionHash: string | null;
  /** null = sem hash para comparar; true/false = comparado com a revisão ativa. */
  onLatest: boolean | null;
  created: string | null;
}

export interface InstanceRevision extends RolloutSummary {
  latest: CompositionRevision | null;
  pending: CompositionRevision | null;
  error: string;
}

export interface CompositionsResponse {
  items: CompositionSummary[];
  total: number;
  namespace: string;
  partial: boolean;
  truncated: boolean;
  sources: LiveSource[];
  readAt: number;
}

/* -------------------------------------------------------------------------- */
/* Consultas                                                                   */
/* -------------------------------------------------------------------------- */

/** GET /cluster/rgds: toda ResourceGraphDefinition com grafo, schema e saúde das instâncias. */
export function listCompositions(namespace: string, signal?: AbortSignal): Promise<CompositionsResponse> {
  return request<CompositionsResponse>(`/cluster/rgds?${new URLSearchParams({ ns: namespace }).toString()}`, signal);
}

/** GET /cluster/rgd-graph: grafo de UMA ResourceGraphDefinition (cluster-scoped). */
export function getCompositionGraph(name: string, signal?: AbortSignal): Promise<CompositionGraphResponse> {
  if (!name) throw new InventoryError(400, 'invalid resource graph definition name');
  return request<CompositionGraphResponse>(`/cluster/rgd-graph?${new URLSearchParams({ name }).toString()}`, signal);
}

export const ALL_NAMESPACES = '_all';
export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 200;

export type SortField = 'name' | 'namespace' | 'kind' | 'capability' | 'state' | 'created' | 'ready';
export const SORT_FIELDS: readonly SortField[] = ['name', 'namespace', 'kind', 'capability', 'state', 'created', 'ready'];

/** Consulta da listagem. Só o que o backend aceita entra na URL. */
export interface InstancesQuery {
  capability?: string;
  kind?: string;
  namespace?: string;
  search?: string;
  state?: string;
  synced?: string;
  /** `'true' | 'false'`; qualquer outra coisa o backend ignora. */
  ready?: string;
  sort?: SortField;
  order?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
  engine?: Engine | 'all';
}

/**
 * Monta a query string da listagem. Campo vazio não vai, para que o cursor -
 * que o backend prende ao digest da consulta - não mude de identidade só por
 * um parâmetro vazio ter aparecido.
 */
export function instancesQueryString(query: InstancesQuery): string {
  const params = new URLSearchParams();
  const put = (key: string, value: string | undefined) => { if (value) params.set(key, value); };
  put('capability', query.capability);
  put('kind', query.kind);
  put('ns', query.namespace);
  put('q', query.search);
  put('state', query.state);
  put('synced', query.synced);
  put('ready', query.ready === 'true' || query.ready === 'false' ? query.ready : undefined);
  put('sort', query.sort);
  put('order', query.order);
  put('engine', query.engine);
  if (query.limit) params.set('limit', String(Math.min(Math.max(1, query.limit), PAGE_SIZE_MAX)));
  put('cursor', query.cursor);
  const search = params.toString();
  return search ? `?${search}` : '';
}

export function listCapabilities(options: { namespace?: string; engine?: Engine | 'all'; counts?: boolean } = {}, signal?: AbortSignal): Promise<CapabilitiesResponse> {
  const params = new URLSearchParams();
  if (options.namespace) params.set('ns', options.namespace);
  if (options.engine) params.set('engine', options.engine);
  if (options.counts) params.set('counts', 'true');
  const search = params.toString();
  return request<CapabilitiesResponse>(`/cluster/capabilities${search ? `?${search}` : ''}`, signal);
}

export function listInstances(query: InstancesQuery, signal?: AbortSignal): Promise<InstancesResponse> {
  return request<InstancesResponse>(`/cluster/instances${instancesQueryString(query)}`, signal);
}

/**
 * Detalhe de uma instância. `ns` e `name` são obrigatórios, e um dos dois entre
 * `capability` e `kind` - o backend recusa com 400 se faltar, e recusar aqui
 * antes do fetch deixa o erro legível em vez de virar um HTTP 400 genérico.
 */
export function getInstance(input: { namespace: string; name: string; capability?: string; kind?: string }, signal?: AbortSignal): Promise<InstanceDetail> {
  if (!input.namespace || input.namespace === ALL_NAMESPACES) throw new InventoryError(400, 'ns is required for a single instance');
  if (!input.name) throw new InventoryError(400, 'invalid instance name');
  if (!input.capability && !input.kind) throw new InventoryError(400, 'kind or capability is required');
  const params = new URLSearchParams({ ns: input.namespace, name: input.name });
  if (input.capability) params.set('capability', input.capability);
  if (input.kind) params.set('kind', input.kind);
  return request<InstanceDetail>(`/cluster/instance?${params.toString()}`, signal);
}
