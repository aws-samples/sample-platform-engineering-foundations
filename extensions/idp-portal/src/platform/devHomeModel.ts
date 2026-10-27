/*
 * Modelo da home do Dev (Developer Platform). Tudo aqui é DERIVADO de leituras que já existem:
 *
 *   catálogo        platform/catalog/** + contagem live (`/cluster/capabilities?counts=true`)
 *   recentes        `/cluster/instances?ns=_all&sort=created&order=desc`
 *   em andamento    `/cluster/instances?ns=_all&ready=false`
 *   atividade       `/cluster/events?ns=_all`
 *   saúde           `/cluster/overview` + `/cluster/platform`
 *
 * Nenhuma função inventa um número. Cada bloco tem quatro estados distintos e a UI renderiza os
 * quatro como eles mesmos: carregando, erro de leitura, lido e vazio, lido mas não sabido
 * (`unknown`). "Não sabido" nunca vira zero e nunca herda o lifecycle do arquivo.
 *
 * As funções são puras (sem React, sem fetch) para que os testes afirmem o comportamento sem
 * browser.
 */
import type { ClusterOverview, EventRow, PlatformView } from './clusterApi';
import type { InstanceRow, LiveSource } from './kdpInventoryApi';
import type { ServiceEntry } from './serviceCatalog';

/* -------------------------------------------------------------------------- */
/* Estado remoto                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Uma leitura e seus estados. `partial` e `failedSources` são do contrato da cluster-api: com
 * `partial` a lista é piso, e zero resultado não é conclusão.
 */
export type Remote<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T; partial?: boolean; sources?: LiveSource[]; readAt?: number };

export const LOADING = { status: 'loading' } as const;

/* -------------------------------------------------------------------------- */
/* Catálogo                                                                    */
/* -------------------------------------------------------------------------- */

export interface CatalogSummary {
  total: number;
  added: number;
  /** Disponíveis ou em preview: o que o Dev pode pedir agora. */
  requestable: number;
  /** Serviços cuja contagem live não foi lida. */
  unknown: number;
  /** Soma das instâncias live; `null` quando alguma contagem não foi lida. */
  instances: number | null;
}

export function catalogSummary(entries: ServiceEntry[]): CatalogSummary {
  let instances: number | null = 0;
  let added = 0;
  let requestable = 0;
  let unknown = 0;
  for (const entry of entries) {
    if (entry.state === 'added') added += 1;
    if (entry.state === 'unknown') unknown += 1;
    if (entry.lifecycle === 'available' || entry.lifecycle === 'preview') requestable += 1;
    instances = instances === null || entry.instanceCount === null ? null : instances + entry.instanceCount;
  }
  return { total: entries.length, added, requestable, unknown, instances };
}

/**
 * Os serviços em destaque na home: os adicionados primeiro (é onde o Dev já trabalha), depois o
 * que pode ser pedido agora. Planejado e descontinuado ficam só no catálogo completo.
 */
export function featuredServices(entries: ServiceEntry[], limit = 3): ServiceEntry[] {
  const rank = (entry: ServiceEntry) => entry.state === 'added' ? 0
    : entry.state === 'available' ? 1
      : entry.state === 'preview' ? 2
        : entry.state === 'unknown' && (entry.lifecycle === 'available' || entry.lifecycle === 'preview') ? 3
          : 9;
  return entries
    .filter(entry => rank(entry) < 9)
    .sort((a, b) => rank(a) - rank(b) || (b.instanceCount ?? 0) - (a.instanceCount ?? 0) || a.displayName.localeCompare(b.displayName))
    .slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Operações em andamento                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Fase de um recurso que ainda não está pronto. A classificação usa o `readyBasis` e o
 * `freshness` que o BACKEND calculou; o browser não deriva Ready de condition (invariante I-B).
 *
 *  - blocked     o controller disse False (ou uma condition negativa está True): precisa de ação
 *  - slow        passou do tempo de convergência previsto
 *  - stale       o status está atrás do spec ou sem observedGeneration
 *  - converging  ainda dentro do tempo previsto
 */
export type OperationPhase = 'blocked' | 'slow' | 'stale' | 'converging';

const PHASE_ORDER: Record<OperationPhase, number> = { blocked: 0, slow: 1, stale: 2, converging: 3 };

export interface OperationItem {
  row: InstanceRow;
  phase: OperationPhase;
  /** Segundos desde a criação, na hora da leitura. `null` sem `created` legível. */
  elapsedSeconds: number | null;
  budgetSeconds: number | null;
  /**
   * Percentual do tempo previsto já gasto, de 0 a 95. É uma ESTIMATIVA por tempo, e a UI diz isso:
   * o controller não reporta percentual. Nunca chega a 100 antes de Ready, e é `null` quando não
   * há como calcular, para a barra não aparecer com um número inventado.
   */
  percent: number | null;
}

export function operationPhase(row: Pick<InstanceRow, 'readyBasis' | 'statusStale' | 'freshness'>): OperationPhase {
  if (row.readyBasis === 'CONDITION_FALSE' || row.readyBasis === 'NEGATIVE_CONDITION') return 'blocked';
  if (row.freshness?.staleReasons?.includes('CONVERGE_BUDGET_EXCEEDED')) return 'slow';
  if (row.statusStale || row.readyBasis === 'STATUS_STALE' || row.readyBasis === 'OBSERVED_GENERATION_MISSING') return 'stale';
  return 'converging';
}

function secondsSince(iso: string | null | undefined, nowSeconds: number): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor(nowSeconds - parsed / 1000));
}

/**
 * Recursos que ainda não estão prontos, do mais urgente ao mais tranquilo. Recebe só as linhas
 * não prontas, mas filtra de novo: uma linha pronta que escape do filtro do servidor não pode
 * aparecer como operação em andamento.
 */
export function operationsInProgress(rows: InstanceRow[], readAtSeconds?: number): OperationItem[] {
  return rows
    .filter(row => !row.ready)
    .map(row => {
      const now = readAtSeconds ?? row.freshness?.readAt ?? Math.floor(Date.now() / 1000);
      const elapsedSeconds = secondsSince(row.created, now);
      const budget = row.freshness?.convergeBudgetSeconds;
      const budgetSeconds = typeof budget === 'number' && budget > 0 ? budget : null;
      const phase = operationPhase(row);
      const percent = elapsedSeconds === null || budgetSeconds === null
        ? null
        : Math.min(95, Math.round((elapsedSeconds / budgetSeconds) * 100));
      return { row, phase, elapsedSeconds, budgetSeconds, percent };
    })
    .sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || (a.elapsedSeconds ?? 0) - (b.elapsedSeconds ?? 0));
}

export function phaseIndicator(phase: OperationPhase, pt: boolean): { type: 'error' | 'warning' | 'in-progress'; text: string } {
  switch (phase) {
    case 'blocked': return { type: 'error', text: pt ? 'Falhou, precisa de ação' : 'Failed, needs action' };
    case 'slow': return { type: 'warning', text: pt ? 'Mais lento que o previsto' : 'Slower than expected' };
    case 'stale': return { type: 'warning', text: pt ? 'Status desatualizado' : 'Status out of date' };
    default: return { type: 'in-progress', text: pt ? 'Provisionando' : 'Provisioning' };
  }
}

/** A barra de progresso do Cloudscape: `error` para travado, `in-progress` para o resto. */
export function progressStatus(phase: OperationPhase): 'error' | 'in-progress' {
  return phase === 'blocked' ? 'error' : 'in-progress';
}

/* -------------------------------------------------------------------------- */
/* Recursos recentes                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Os mais recentes primeiro. O servidor já ordena por `created desc`; ordenar de novo aqui protege
 * a home de uma resposta fora de ordem, e quem não tem `created` vai para o fim em vez de subir.
 */
export function recentResources(rows: InstanceRow[], limit = 6): InstanceRow[] {
  const at = (row: InstanceRow) => {
    const parsed = row.created ? Date.parse(row.created) : NaN;
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  return [...rows].sort((a, b) => at(b) - at(a) || a.name.localeCompare(b.name)).slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Atividade                                                                   */
/* -------------------------------------------------------------------------- */

export interface ActivityItem {
  key: string;
  type: 'warning' | 'info';
  reason: string;
  object: string;
  namespace: string;
  message: string;
  count: number;
  /** Segundos desde o último registro; `null` quando o evento não traz horário. */
  ageSeconds: number | null;
}

/**
 * Eventos do cluster, mais recentes primeiro. Evento sem horário vai para o fim: ele não pode
 * empurrar um aviso de agora para fora da lista.
 */
export function activityFeed(events: EventRow[], nowMs: number = Date.now(), limit = 8): ActivityItem[] {
  return events
    .map((event, index) => {
      const parsed = event.last ? Date.parse(event.last) : NaN;
      return {
        key: `${event.namespace}/${event.object}/${event.reason}/${index}`,
        type: String(event.type).toLowerCase() === 'warning' ? 'warning' as const : 'info' as const,
        reason: event.reason || '-',
        object: event.object || '-',
        namespace: event.namespace || '-',
        message: event.message || '',
        count: Number.isFinite(event.count) && event.count > 0 ? event.count : 1,
        ageSeconds: Number.isFinite(parsed) ? Math.max(0, Math.floor((nowMs - parsed) / 1000)) : null,
        sortAt: Number.isFinite(parsed) ? parsed : -Infinity,
      };
    })
    .sort((a, b) => b.sortAt - a.sortAt)
    .slice(0, limit)
    .map(({ sortAt: _sortAt, ...item }) => item);
}

/* -------------------------------------------------------------------------- */
/* Saúde                                                                       */
/* -------------------------------------------------------------------------- */

export type HealthLevel = 'success' | 'warning' | 'error' | 'unknown';

export interface HealthSignal {
  id: 'nodes' | 'pods' | 'compositions' | 'instances';
  label: string;
  level: HealthLevel;
  value: string;
}

/**
 * Sinais de saúde a partir de duas leituras independentes. Uma leitura que falhou deixa os SEUS
 * sinais como `unknown`, sem derrubar os da outra, e nunca vira "0/0" verde.
 */
export function healthSignals(overview: ClusterOverview | null, platform: PlatformView | null, pt: boolean): HealthSignal[] {
  const notRead = pt ? 'não lido' : 'not read';
  const signals: HealthSignal[] = [];
  if (overview) {
    const { nodes, pods } = overview;
    signals.push({
      id: 'nodes',
      label: pt ? 'Nodes do EKS' : 'EKS nodes',
      level: nodes.total === 0 ? 'error' : nodes.ready === nodes.total ? 'success' : 'warning',
      value: `${nodes.ready}/${nodes.total} ready${overview.version ? ` · ${overview.version}` : ''}`,
    });
    signals.push({
      id: 'pods',
      label: 'Pods',
      level: pods.failed > 0 ? 'warning' : 'success',
      value: `${pods.running}/${pods.total} running${pods.failed ? ` · ${pods.failed} failed` : ''}${pods.pending ? ` · ${pods.pending} pending` : ''}`,
    });
  } else {
    signals.push({ id: 'nodes', label: pt ? 'Nodes do EKS' : 'EKS nodes', level: 'unknown', value: notRead });
    signals.push({ id: 'pods', label: 'Pods', level: 'unknown', value: notRead });
  }
  if (platform) {
    const rgdsActive = platform.rgds.filter(rgd => rgd.state === 'Active').length;
    const instancesActive = platform.instances.filter(instance => instance.state === 'ACTIVE').length;
    signals.push({
      id: 'compositions',
      label: pt ? 'Compositions (kro)' : 'Compositions (kro)',
      level: platform.rgds.length === 0 ? 'warning' : rgdsActive === platform.rgds.length ? 'success' : 'warning',
      value: `${rgdsActive}/${platform.rgds.length} Active`,
    });
    signals.push({
      id: 'instances',
      label: pt ? 'Instâncias kro' : 'kro instances',
      level: instancesActive === platform.instances.length ? 'success' : 'warning',
      value: `${instancesActive}/${platform.instances.length} ACTIVE`,
    });
  } else {
    signals.push({ id: 'compositions', label: 'Compositions (kro)', level: 'unknown', value: notRead });
    signals.push({ id: 'instances', label: pt ? 'Instâncias kro' : 'kro instances', level: 'unknown', value: notRead });
  }
  return signals;
}

/** O pior nível vence; `unknown` só vence o sucesso, porque um erro lido é mais informação. */
export function overallHealth(signals: HealthSignal[]): HealthLevel {
  const levels = new Set(signals.map(signal => signal.level));
  if (levels.has('error')) return 'error';
  if (levels.has('warning')) return 'warning';
  if (levels.has('unknown')) return 'unknown';
  return signals.length ? 'success' : 'unknown';
}

/** StatusIndicator do Cloudscape para um nível. `unknown` é aviso: ninguém leu aquele número. */
export function healthIndicatorType(level: HealthLevel): 'success' | 'warning' | 'error' {
  return level === 'unknown' ? 'warning' : level;
}

/* -------------------------------------------------------------------------- */
/* Próximos passos                                                             */
/* -------------------------------------------------------------------------- */

/** Destino de um passo: uma view do shell (`#hash`) ou uma rota do router. */
export type StepTarget = { view: string } | { path: string };

export interface NextStep {
  id: string;
  title: string;
  description: string;
  action: string;
  target: StepTarget;
  /** `primary` no máximo para UM passo: é o que a home recomenda fazer agora. */
  primary?: boolean;
}

export interface NextStepInput {
  pt: boolean;
  catalog: CatalogSummary | null;
  /** `null` enquanto a leitura de operações não respondeu. */
  operations: OperationItem[] | null;
  /** Nome do agent que o Agent Builder está acompanhando neste browser, se houver. */
  trackedAgent?: string | null;
  /** Caminho do detalhe de um recurso; injetado para o modelo não depender do router. */
  detailPathOf(row: InstanceRow): string;
}

/**
 * Até quatro passos, do mais urgente ao mais exploratório. As regras são poucas e explícitas:
 * falha antes de progresso, progresso antes de primeira vez, e o catálogo sempre como saída.
 */
export function nextSteps(input: NextStepInput): NextStep[] {
  const { pt, catalog, operations } = input;
  const steps: NextStep[] = [];
  const blocked = operations?.filter(item => item.phase === 'blocked') ?? [];
  const moving = operations?.filter(item => item.phase !== 'blocked') ?? [];

  if (catalog && catalog.total > 0 && catalog.unknown === catalog.total) {
    steps.push({
      id: 'access',
      title: pt ? 'O estado live não foi lido' : 'The live state was not read',
      description: pt
        ? 'A cluster-api não respondeu. Confira o acesso e o onboarding antes de pedir algo novo.'
        : 'The cluster-api did not answer. Check access and onboarding before requesting anything new.',
      action: pt ? 'Ver acesso e onboarding' : 'Check access and onboarding',
      target: { view: 'help' },
    });
  }
  if (blocked.length) {
    steps.push({
      id: 'blocked',
      title: pt
        ? `${blocked.length} ${blocked.length === 1 ? 'recurso falhou' : 'recursos falharam'}`
        : `${blocked.length} ${blocked.length === 1 ? 'resource failed' : 'resources failed'}`,
      description: pt
        ? `Comece por ${blocked[0].row.name}: as conditions do controller dizem o motivo.`
        : `Start with ${blocked[0].row.name}: the controller conditions say why.`,
      action: pt ? 'Ver as conditions' : 'See the conditions',
      target: { path: input.detailPathOf(blocked[0].row) },
    });
  }
  if (moving.length) {
    steps.push({
      id: 'progress',
      title: pt
        ? `${moving.length} ${moving.length === 1 ? 'recurso provisionando' : 'recursos provisionando'}`
        : `${moving.length} ${moving.length === 1 ? 'resource provisioning' : 'resources provisioning'}`,
      description: pt
        ? `Acompanhe ${moving[0].row.name} até ficar pronto. A página atualiza sozinha.`
        : `Follow ${moving[0].row.name} until it is ready. The page refreshes on its own.`,
      action: pt ? 'Acompanhar' : 'Follow it',
      target: { path: input.detailPathOf(moving[0].row) },
    });
  }
  if (input.trackedAgent) {
    steps.push({
      id: 'agent',
      title: pt ? `Seu agent ${input.trackedAgent}` : `Your agent ${input.trackedAgent}`,
      description: pt
        ? 'O Agent Builder está acompanhando este agent neste browser.'
        : 'The Agent Builder is tracking this agent in this browser.',
      action: pt ? 'Abrir no Agent Builder' : 'Open in Agent Builder',
      target: { view: 'agent-builder' },
    });
  }
  if (catalog && catalog.unknown < catalog.total && catalog.added === 0) {
    steps.push({
      id: 'first-run',
      title: pt ? 'Seu primeiro site em 10 minutos' : 'Your first site in 10 minutes',
      description: pt
        ? 'Um clique cria um site de verdade pelo caminho GitOps, e você acompanha cada etapa.'
        : 'One click creates a real site through the GitOps path, and you watch every step.',
      action: pt ? 'Começar' : 'Get started',
      target: { view: 'getting-started' },
    });
  }
  steps.push({
    id: 'catalog',
    title: pt ? 'Escolha um serviço' : 'Pick a service',
    description: pt
      ? 'Bancos, filas, APIs, sites e agents com o mesmo caminho governado: wizard, MR e Argo CD.'
      : 'Databases, queues, APIs, sites and agents through the same governed path: wizard, MR and Argo CD.',
    action: pt ? 'Abrir o catálogo' : 'Open the catalog',
    target: { view: 'catalog' },
  });
  steps.push({
    id: 'agent-builder',
    title: pt ? 'Crie um agent' : 'Build an agent',
    description: pt
      ? 'Descreva em linguagem natural. A plataforma valida, abre o MR e você testa por A2A.'
      : 'Describe it in plain language. The platform validates, opens the MR and you test it over A2A.',
    action: pt ? 'Abrir o Agent Builder' : 'Open the Agent Builder',
    target: { view: 'agent-builder' },
  });

  const unique = steps.filter((step, index) => steps.findIndex(other => other.id === step.id) === index).slice(0, 4);
  return unique.map((step, index) => (index === 0 ? { ...step, primary: true } : step));
}

/* -------------------------------------------------------------------------- */
/* Layout responsivo                                                           */
/* -------------------------------------------------------------------------- */

type Colspan = { colspan: { default: number; xs?: number; s?: number; m?: number; l?: number; xl?: number } };

/**
 * O grid da home, nomeado para ser testável. Toda coluna ocupa 12 na menor largura: no celular a
 * home vira uma coluna só, na ordem de leitura (o que precisa de ação vem antes do que é contexto).
 * Os breakpoints do Grid do Cloudscape medem o CONTAINER, e a navegação lateral come ~280px, então
 * `m` (a partir de 1120px de conteúdo) é o desktop comum; esperar `l` deixava tudo empilhado.
 */
// Os KPIs saíram daqui em 24/10/2026: dentro do Board o Grid media a largura cedo demais e
// ficava em 2 por linha; eles usam ColumnLayout com minColumnWidth (auto-fit em CSS).
export const HOME_LAYOUT: Record<'work' | 'context', Colspan[]> = {
  work: [
    { colspan: { default: 12, m: 7 } },
    { colspan: { default: 12, m: 5 } },
  ],
  context: [
    { colspan: { default: 12, s: 6, m: 4 } },
    { colspan: { default: 12, s: 6, m: 4 } },
    { colspan: { default: 12, m: 4 } },
  ],
};
