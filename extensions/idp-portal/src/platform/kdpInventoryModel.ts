/*
 * Modelo puro das páginas de inventário live (issues #8 e #9). Tudo aqui é função
 * sem efeito, e é de propósito: o que decide rótulo, ícone, cadência de refresh,
 * rota e ação governada fica testável sem browser, e a página só compõe.
 *
 * A regra que mais importa neste arquivo é negativa: NADA aqui deriva Ready. O
 * backend já resolve Ready exigindo condition real E observedGeneration atual
 * (invariante I-B), e devolve `ready` com o motivo em `readyBasis`. Se o browser
 * olhasse as conditions para decidir, um Ready stale voltaria a parecer saudável,
 * que é exatamente o defeito que a issue #9 nomeia. As funções abaixo consomem
 * `ready` e `readyBasis`; nenhuma lê `conditions` para concluir prontidão.
 */
import type {
  ConditionRow, Freshness, InstanceDetail, InstanceRow, InstancesResponse,
  ReadyBasis, SortField,
} from './kdpInventoryApi';
import { ALL_NAMESPACES, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, SORT_FIELDS } from './kdpInventoryApi';
import { GIT_WEB_BASE } from './deployment';

/** Tipos do StatusIndicator do Cloudscape que esta UI usa. */
export type IndicatorType = 'error' | 'warning' | 'success' | 'info' | 'stopped' | 'pending' | 'in-progress';

/** Status sempre texto + ícone: o par é indivisível, nunca só a cor. */
export interface Indicator { type: IndicatorType; text: string }

/* -------------------------------------------------------------------------- */
/* Idade e frescor                                                             */
/* -------------------------------------------------------------------------- */

/** Idade legível a partir de segundos. `null` vira "-", não vira zero. */
export function relativeAge(seconds: number | null | undefined, pt: boolean): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '-';
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}min`;
  if (value < 86400) return `${Math.floor(value / 3600)}h`;
  return pt ? `${Math.floor(value / 86400)}d` : `${Math.floor(value / 86400)}d`;
}

const STALE_REASONS: Record<string, { pt: string; en: string }> = {
  GENERATION_LAG: { pt: 'status atrás do spec', en: 'status behind spec' },
  OBSERVED_GENERATION_MISSING: { pt: 'sem observedGeneration', en: 'no observedGeneration' },
  NO_CONDITIONS: { pt: 'sem conditions', en: 'no conditions' },
  ARGO_UNKNOWN: { pt: 'Argo CD ilegível', en: 'Argo CD unreadable' },
  CONVERGE_BUDGET_EXCEEDED: { pt: 'passou do tempo de convergência', en: 'past converge budget' },
};

export function staleReasonLabel(reason: string, pt: boolean): string {
  const known = STALE_REASONS[reason];
  if (known) return pt ? known.pt : known.en;
  return reason.toLowerCase().replace(/_/g, ' ');
}

/**
 * Frescor da leitura. Fresca é sucesso; stale é aviso com o motivo por extenso -
 * nunca um ícone sozinho, porque o motivo é o que diz se vale agir.
 */
export function freshnessIndicator(freshness: Freshness | undefined, pt: boolean): Indicator {
  if (!freshness) return { type: 'info', text: pt ? 'sem leitura' : 'no read' };
  const age = relativeAge(freshness.ageSeconds, pt);
  if (!freshness.stale) return { type: 'success', text: pt ? `leitura fresca · ${age}` : `fresh · ${age}` };
  const reasons = freshness.staleReasons.map(reason => staleReasonLabel(reason, pt)).join(', ');
  return { type: 'warning', text: `${pt ? 'desatualizada' : 'stale'}${reasons ? `: ${reasons}` : ''} · ${age}` };
}

/* -------------------------------------------------------------------------- */
/* Ready, State, Synced                                                        */
/* -------------------------------------------------------------------------- */

const READY_BASIS: Record<string, { pt: string; en: string }> = {
  CONDITION_TRUE: { pt: 'condition de prontidão em True e status do spec atual', en: 'ready condition True and status current' },
  CONDITION_FALSE: { pt: 'condition de prontidão em False', en: 'ready condition is False' },
  CONDITION_UNKNOWN: { pt: 'condition de prontidão em Unknown', en: 'ready condition is Unknown' },
  NO_READY_CONDITION: { pt: 'o objeto não publicou condition de prontidão', en: 'object published no ready condition' },
  STATUS_STALE: { pt: 'o status ainda fala de uma geração anterior do spec', en: 'status still reports an earlier spec generation' },
  NEGATIVE_CONDITION: { pt: 'uma condition terminal ou degradada está em True', en: 'a terminal or degraded condition is True' },
  OBSERVED_GENERATION_MISSING: { pt: 'sem observedGeneration, então não há como provar que o status é do spec atual', en: 'no observedGeneration, so the status cannot be tied to the current spec' },
};

/** Por que o backend concluiu o que concluiu sobre Ready, em uma frase. */
export function readyBasisLabel(basis: ReadyBasis, pt: boolean): string {
  const known = READY_BASIS[basis];
  if (known) return pt ? known.pt : known.en;
  const match = /^CONDITION_(.+)$/.exec(String(basis));
  if (match) return pt ? `condition de prontidão em ${match[1].toLowerCase()}` : `ready condition is ${match[1].toLowerCase()}`;
  return String(basis);
}

/** `true` quando o `state` do servidor é, na verdade, o fallback de readyBasis. */
export function stateIsReadyBasis(state: string): boolean {
  return state in READY_BASIS || /^CONDITION_[A-Z]+$/.test(state);
}

const KRO_STATE: Record<string, IndicatorType> = {
  ACTIVE: 'success',
  IN_PROGRESS: 'in-progress',
  INPROGRESS: 'in-progress',
  PENDING: 'pending',
  FAILED: 'error',
  ERROR: 'error',
  DELETING: 'stopped',
  TERMINATING: 'stopped',
  INACTIVE: 'stopped',
};

/**
 * State da instância. Dois vocabulários chegam no mesmo campo: kro escreve
 * `status.state` (ACTIVE, IN_PROGRESS...), e ACK normalmente não escreve nada,
 * então o backend cai no readyBasis. Mostrar `CONDITION_TRUE` como se fosse um
 * state inventaria um vocabulário que o objeto não tem: nesse caso o rótulo
 * passa a ser Ready / Not ready, que é o que o dado realmente diz.
 */
export function stateIndicator(row: Pick<InstanceRow, 'state' | 'ready' | 'readyBasis'>, pt: boolean): Indicator {
  const state = String(row.state || '');
  if (!state || stateIsReadyBasis(state)) {
    return row.ready
      ? { type: 'success', text: pt ? 'Pronto' : 'Ready' }
      : { type: readyPendingType(row.readyBasis), text: pt ? 'Não pronto' : 'Not ready' };
  }
  const type = KRO_STATE[state.toUpperCase().replace(/[^A-Z]/g, '')] ?? 'info';
  return { type, text: state };
}

/**
 * Um objeto que não está pronto está convergindo ou travado, e o readyBasis é
 * quem sabe: False de controller é problema, ausência de condition é "ainda não
 * respondeu", status velho é aviso.
 */
function readyPendingType(basis: ReadyBasis): IndicatorType {
  if (basis === 'CONDITION_FALSE' || basis === 'NEGATIVE_CONDITION') return 'error';
  if (basis === 'STATUS_STALE' || basis === 'OBSERVED_GENERATION_MISSING') return 'warning';
  return 'in-progress';
}

/** Ready vem do servidor. Esta função só escolhe ícone e texto. */
export function readyIndicator(row: Pick<InstanceRow, 'ready' | 'readyBasis'>, pt: boolean): Indicator {
  if (row.ready) return { type: 'success', text: pt ? 'Pronto' : 'Ready' };
  return { type: readyPendingType(row.readyBasis), text: pt ? 'Não pronto' : 'Not ready' };
}

/** Synced é o status da condition de prontidão, como o backend o devolve. */
export function syncedIndicator(synced: string, pt: boolean): Indicator {
  const value = String(synced || 'Unknown');
  if (value === 'True') return { type: 'success', text: value };
  if (value === 'False') return { type: 'error', text: value };
  return { type: 'pending', text: pt && value === 'Unknown' ? 'Unknown' : value };
}

const NEGATIVE_CONDITIONS = new Set(['ACK.Terminal', 'ACK.Recoverable', 'Degraded', 'Stalled', 'Failed']);

/**
 * Ícone da condition. `True` não é sempre bom: numa condition negativa (Degraded,
 * ACK.Terminal) True é o problema. Por isso o tipo depende do par type+status, e
 * não do status sozinho.
 */
export function conditionIndicator(condition: Pick<ConditionRow, 'type' | 'status'>): Indicator {
  const negative = NEGATIVE_CONDITIONS.has(condition.type);
  const status = String(condition.status || 'Unknown');
  if (status === 'True') return { type: negative ? 'error' : 'success', text: status };
  if (status === 'False') return { type: negative ? 'success' : 'warning', text: status };
  return { type: 'pending', text: status };
}

/* -------------------------------------------------------------------------- */
/* Atualização automática                                                      */
/* -------------------------------------------------------------------------- */

export const REFRESH_CONVERGING_MS = 10_000;
export const REFRESH_DEGRADED_MS = 20_000;
export const REFRESH_SETTLED_MS = 60_000;

/**
 * Cadência do próximo refresh, em ms. A issue #8 pede que um objeto criado
 * apareça sem reload manual: enquanto algo converge a lista reconsulta rápido, e
 * quando tudo assentou desacelera para não bater na API sem motivo.
 */
export function nextRefreshDelay(input: { items: Pick<InstanceRow, 'ready' | 'freshness'>[]; partial?: boolean }): number {
  const converging = input.items.some(row => !row.ready && !row.freshness?.staleReasons?.includes('CONVERGE_BUDGET_EXCEEDED'));
  if (converging) return REFRESH_CONVERGING_MS;
  if (input.partial || input.items.some(row => row.freshness?.stale)) return REFRESH_DEGRADED_MS;
  return REFRESH_SETTLED_MS;
}

/** Mesma cadência para o detalhe, a partir de um único objeto. */
export function detailRefreshDelay(detail: Pick<InstanceDetail, 'ready' | 'freshness' | 'partial'> | null): number {
  if (!detail) return REFRESH_CONVERGING_MS;
  return nextRefreshDelay({ items: [{ ready: detail.ready, freshness: detail.freshness }], partial: detail.partial });
}

/* -------------------------------------------------------------------------- */
/* Rotas e estado da listagem na URL                                           */
/* -------------------------------------------------------------------------- */

export const SERVICES_BASE = '/agent-platform/services';

/*
 * A capability de ACK é `<grupo>/<plural>` (`s3/buckets`), logo tem barra e não
 * cabe cru num segmento de rota. `~` não pertence ao alfabeto de capability
 * (CAPABILITY_PATTERN aceita [a-z0-9.-]), então a troca é reversível sem
 * ambiguidade e sem depender de como o router trata %2F.
 */
export function capabilitySlug(capability: string): string {
  return capability.replace(/\//g, '~');
}
export function capabilityFromSlug(slug: string): string {
  return slug.replace(/~/g, '/');
}

/** Keeps the service menu item active on both list and nested resource-detail routes. */
export function serviceNavHref(pathname: string): string {
  const match = /^(\/agent-platform\/services\/[^/]+)/.exec(pathname);
  return match ? match[1] : pathname;
}

export interface ListState {
  namespace: string;
  /** Aba por kind. Vazio = todos os kinds da capability. */
  kind: string;
  search: string;
  state: string;
  synced: string;
  /** '' | 'true' | 'false' */
  ready: string;
  sort: SortField;
  order: 'asc' | 'desc';
  limit: number;
  /** Cursor da página corrente. Vazio = primeira página. */
  cursor: string;
  /** Página 1-based, só para exibição; o servidor pagina por cursor. */
  page: number;
}

export const DEFAULT_LIST_STATE: ListState = {
  namespace: ALL_NAMESPACES, kind: '', search: '', state: '', synced: '', ready: '',
  sort: 'name', order: 'asc', limit: PAGE_SIZE_DEFAULT, cursor: '', page: 1,
};

function clampLimit(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return PAGE_SIZE_DEFAULT;
  return Math.min(Math.floor(value), PAGE_SIZE_MAX);
}

/**
 * Lê o estado da listagem da query string. Parâmetro ausente volta ao default,
 * e valor fora do vocabulário do backend é descartado em vez de ser repassado -
 * `sort=; DROP` não deve chegar à API só porque estava na URL.
 */
export function decodeListState(search: string | URLSearchParams): ListState {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const sort = String(params.get('sort') ?? '') as SortField;
  const ready = String(params.get('ready') ?? '');
  const page = Number(params.get('page'));
  return {
    namespace: params.get('ns') || ALL_NAMESPACES,
    kind: params.get('kind') ?? '',
    search: params.get('q') ?? '',
    state: params.get('state') ?? '',
    synced: params.get('synced') ?? '',
    ready: ready === 'true' || ready === 'false' ? ready : '',
    sort: SORT_FIELDS.includes(sort) ? sort : DEFAULT_LIST_STATE.sort,
    order: params.get('order') === 'desc' ? 'desc' : 'asc',
    limit: clampLimit(params.get('limit')),
    cursor: params.get('cursor') ?? '',
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}

/**
 * Serializa só o que difere do default. É isto que faz o Back do browser voltar
 * com os filtros: a URL É o estado, então voltar na history restaura a consulta
 * sem precisar guardar nada em memória de componente.
 */
export function encodeListState(state: ListState): string {
  const params = new URLSearchParams();
  if (state.namespace && state.namespace !== ALL_NAMESPACES) params.set('ns', state.namespace);
  if (state.kind) params.set('kind', state.kind);
  if (state.search) params.set('q', state.search);
  if (state.state) params.set('state', state.state);
  if (state.synced) params.set('synced', state.synced);
  if (state.ready) params.set('ready', state.ready);
  if (state.sort !== DEFAULT_LIST_STATE.sort) params.set('sort', state.sort);
  if (state.order !== DEFAULT_LIST_STATE.order) params.set('order', state.order);
  if (state.limit !== DEFAULT_LIST_STATE.limit) params.set('limit', String(state.limit));
  if (state.cursor) params.set('cursor', state.cursor);
  if (state.page > 1) params.set('page', String(state.page));
  return params.toString();
}

export function listPath(capability: string, state?: Partial<ListState>): string {
  const query = state ? encodeListState({ ...DEFAULT_LIST_STATE, ...state }) : '';
  return `${SERVICES_BASE}/${capabilitySlug(capability)}${query ? `?${query}` : ''}`;
}

/**
 * O que vai para a URL: os filtros, sem a posição na paginação.
 *
 * O cursor é preso ao digest da consulta no backend, então um cursor em URL
 * compartilhada ou em entrada de history envelhece e a próxima leitura levaria
 * 400. Deixar a paginação fora da URL custa voltar para a página 1 ao usar o
 * Back, e paga a garantia de que a consulta restaurada SEMPRE é válida - que é
 * o que "voltar sem perder filtros" precisa significar para ser confiável.
 */
export function filtersOnly(state: ListState): ListState {
  return { ...state, cursor: '', page: 1 };
}

/** Caminho do wizard governado de criação, com capability e namespace prontos. */
export function createRequestHref(capability: string, namespace: string): string {
  const params = new URLSearchParams({ capability });
  if (namespace && namespace !== ALL_NAMESPACES) params.set('ns', namespace);
  return `/agent-platform/?${params.toString()}#provision`;
}

/**
 * O MESMO destino, partido nas três partes que o `navigate` do router recebe.
 *
 * Existe porque `window.location.assign(createRequestHref(...))` recarregava a aplicação inteira:
 * novo bundle, novo fetch de tudo, estado do shell perdido. O href continua para `<a href>` e para
 * link compartilhável; a navegação interna usa este.
 */
export function createRequestPath(capability: string, namespace: string): { pathname: string; search: string; hash: string } {
  const href = createRequestHref(capability, namespace);
  const [pathAndQuery, hash] = href.split('#');
  const [pathname, search] = pathAndQuery.split('?');
  return { pathname, search: search ? `?${search}` : '', hash: hash ? `#${hash}` : '' };
}

/**
 * Rota do detalhe. Carrega o estado da listagem em `from`, para que o Back do
 * detalhe devolva a MESMA consulta mesmo quando o usuário chegou por link.
 */
export function detailPath(row: Pick<InstanceRow, 'capability' | 'namespace' | 'name' | 'kind'>, from?: ListState): string {
  const params = new URLSearchParams({ kind: row.kind });
  const back = from ? encodeListState(from) : '';
  if (back) params.set('from', back);
  return `${SERVICES_BASE}/${capabilitySlug(row.capability)}/${encodeURIComponent(row.namespace)}/${encodeURIComponent(row.name)}?${params.toString()}`;
}

/** Para onde o Back do detalhe volta: a consulta que veio em `from`, se veio. */
export function backToListPath(capability: string, from: string | null | undefined): string {
  const query = from ? encodeListState(decodeListState(from)) : '';
  return `${SERVICES_BASE}/${capabilitySlug(capability)}${query ? `?${query}` : ''}`;
}

/* -------------------------------------------------------------------------- */
/* Ordenação e paginação                                                       */
/* -------------------------------------------------------------------------- */

/** Coluna do Cloudscape -> campo de ordenação que o backend aceita. */
export function sortFieldOfColumn(columnId: string | undefined): SortField {
  const field = String(columnId ?? '') as SortField;
  return SORT_FIELDS.includes(field) ? field : DEFAULT_LIST_STATE.sort;
}

/**
 * Paginação por cursor: o backend só devolve o cursor da PRÓXIMA página, preso
 * ao digest da consulta. Então as páginas visitadas ficam numa pilha, e o
 * Pagination anda livremente para trás e um passo para frente - `openEnd` diz
 * que há mais sem afirmar quantas. Fingir um total de páginas navegável
 * sintetizaria cursores que o backend recusaria.
 */
export interface CursorStack { cursors: string[]; nextCursor: string | null }

export const EMPTY_CURSOR_STACK: CursorStack = { cursors: [''], nextCursor: null };

export function pushCursor(stack: CursorStack, page: number, nextCursor: string | null): CursorStack {
  const cursors = stack.cursors.slice(0, Math.max(1, page));
  return { cursors, nextCursor };
}

/** Cursor de uma página 1-based já visitada; `null` quando não foi visitada. */
export function cursorForPage(stack: CursorStack, page: number): string | null {
  if (page < 1) return null;
  if (page <= stack.cursors.length) return stack.cursors[page - 1];
  if (page === stack.cursors.length + 1 && stack.nextCursor) return stack.nextCursor;
  return null;
}

export function pagesCount(stack: CursorStack): number {
  return stack.cursors.length;
}

/* -------------------------------------------------------------------------- */
/* Abas por kind                                                               */
/* -------------------------------------------------------------------------- */

export interface KindTab { id: string; label: string; count?: number }

/**
 * Abas por kind, só quando a capability expõe mais de um objeto (issue #8). Com
 * um kind só, uma aba única seria enfeite.
 */
export function kindTabs(response: Pick<InstancesResponse, 'kinds'> | null, pt: boolean): KindTab[] {
  const kinds = response?.kinds ?? [];
  if (kinds.length < 2) return [];
  return [{ id: '', label: pt ? 'Todos' : 'All' }, ...kinds.map(kind => ({ id: kind, label: kind }))];
}

/* -------------------------------------------------------------------------- */
/* Cópia segura                                                                */
/* -------------------------------------------------------------------------- */

/*
 * O backend já sanitiza outputs, labels, annotations e mensagem de condition
 * (invariante I-C). Esta segunda checagem no browser existe porque a área de
 * transferência é um destino que sai do produto: uma regressão em QUALQUER um
 * dos dois lados deixaria de ser silenciosa aqui. É defesa em profundidade, não
 * substituição - o servidor continua sendo o filtro que vale.
 */
const SENSITIVE_KEY_TOKENS = [
  'secret', 'token', 'password', 'passwd', 'passphrase', 'credential', 'cred',
  'privatekey', 'apikey', 'accesskey', 'sessionkey', 'signature', 'bearer',
  'authorization', 'auth', 'certificate', 'cert', 'keymaterial', 'connectionstring',
  'dsn', 'dbpassword', 'clientsecret', 'sharedkey', 'sas', 'pem', 'pfx', 'keystore',
];
const SENSITIVE_KEY_ALLOW = new Set([
  'secretsmanagerarn', 'secretarn', 'secretname', 'secretref', 'kmskeyarn',
  'kmskeyid', 'certificatearn', 'authmode', 'authtype',
]);
const SENSITIVE_VALUE_PATTERNS = [
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
  /-{3,}\s*BEGIN[A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\bghp_[A-Za-z0-9]{20,}\b|\bglpat-[A-Za-z0-9_-]{15,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/,
  /(?:^|[\s,;&?"'{\[])(?:aws[-_]?secret[-_]?access[-_]?key|client[-_]?key[-_]?data|client[-_]?certificate[-_]?data|client[-_]?secret|access[-_]?token|refresh[-_]?token|session[-_]?token|id[-_]?token|private[-_]?token|bearer[-_]?token|private[-_]?key|api[-_]?key|apikey|access[-_]?key|secret[-_]?key|password|passwd|pwd|secret|token|authorization)\s*[:=]\s*\S/i,
  /[?&]x-amz-(?:signature|credential|security-token)=/i,
  /[?&](?:sig|signature)=\S/i,
];

export function isSensitiveKey(key: string): boolean {
  const flat = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_KEY_ALLOW.has(flat)) return false;
  return SENSITIVE_KEY_TOKENS.some(token => flat.includes(token));
}

export function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some(pattern => pattern.test(String(value)));
}

export interface CopyField { key: string; label: string; value: string }

/**
 * Identidade copiável do objeto: name, namespace, apiVersion e os outputs não
 * sensíveis (issue #9). Campo vazio não entra - um botão de copiar que copia ""
 * é ruído.
 */
export function copyableFields(detail: InstanceDetail, pt: boolean): CopyField[] {
  const fields: CopyField[] = [
    { key: 'name', label: pt ? 'Nome' : 'Name', value: detail.metadata.name },
    { key: 'namespace', label: 'Namespace', value: detail.metadata.namespace },
    { key: 'apiVersion', label: 'apiVersion', value: detail.apiVersion },
    { key: 'uid', label: 'UID', value: detail.metadata.uid },
  ];
  for (const [key, value] of Object.entries(detail.outputs ?? {})) {
    if (isSensitiveKey(key) || isSensitiveValue(value)) continue;
    fields.push({ key: `output:${key}`, label: key, value });
  }
  return fields.filter(field => field.value && !isSensitiveValue(field.value));
}

/* -------------------------------------------------------------------------- */
/* Ações governadas                                                            */
/* -------------------------------------------------------------------------- */

/** Kinds que os handlers POST governados da cluster-api aceitam. */
const DAY2_KINDS = new Set(['deployment', 'statefulset']);

export interface GovernedAction {
  id: 'request-change' | 'restart';
  label: string;
  /** Onde a autorização é imposta. Vem da resposta da API, não do botão. */
  enforcement: string;
  enabled: boolean;
  disabledReason?: string;
  /** `write-path` abre o caminho de escrita por MR; `day2-api` chama um POST governado. */
  via: 'write-path' | 'day2-api';
  /** Destino externo (GitLab). Ação com href é um link, e o portal não escreve nada. */
  href?: string;
}

const GITLAB_PROJECT_URL = GIT_WEB_BASE;
/** Caminho relativo ao repo, sem `..`, sem barra inicial, só caracteres de nome de arquivo. */
const GITOPS_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,240}\.ya?ml$/;

/**
 * Página de edição do arquivo no GitLab. Com `main` protegida, salvar ali obriga a criar branch
 * e abrir merge request: é o MR que o botão promete, feito pela ferramenta que de fato o faz.
 * Caminho fora da forma devolve null em vez de montar um link para qualquer lugar.
 */
export function gitlabEditUrl(path: string | null | undefined): string | null {
  if (!path || !GITOPS_PATH.test(path)) return null;
  return `${GITLAB_PROJECT_URL}/-/edit/main/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Rota do plano no Platform Assistant. Mesmo formato de id que o servidor aceita. */
export function planHref(planId: string | null | undefined): string | null {
  return planId && /^[0-9a-f]{32}$/.test(planId) ? `/agent-platform/#assistant/${planId}` : null;
}

/**
 * Ações oferecidas no detalhe, derivadas do que a API DECLARA - nunca de uma
 * suposição local. Três consequências de propósito:
 *
 *  - `enabled` sai de `actions.callerIsAdmin`, que é leitura do gate, e a
 *    imposição continua no handler POST. Botão desabilitado é cortesia de UI;
 *    o 403 é a autorização. A issue #9 pede exatamente essa separação.
 *  - Day-2 só aparece para kind que os handlers aceitam. Para uma instância kro
 *    ou ACK o caminho de escrita é o MR, e inventar um Scale aqui ofereceria uma
 *    ação que a API recusaria.
 *  - `enforcement` é texto do servidor, e é mostrado na UI: o usuário lê onde a
 *    regra vive em vez de deduzir pelo estado do botão.
 *
 * NÃO existe Scale aqui, e a ausência é deliberada. `POST /cluster/scale` exige
 * `replicas`, e a tela não tem de onde tirar esse número: a versão anterior
 * mandava `metadata.generation`, que é o contador de revisões do spec e não tem
 * nenhuma relação com réplicas - escalar um Deployment na sétima revisão o
 * levava para 7 réplicas. Oferecer a ação de novo depende de um input de
 * replicas de verdade, com o valor atual lido do objeto; até lá o caminho é o MR.
 */
export function governedActions(detail: InstanceDetail, pt: boolean): GovernedAction[] {
  const actions: GovernedAction[] = [];
  const kind = String(detail.kind || '').toLowerCase();
  const notAdmin = pt ? 'Requer perfil de admin da plataforma.' : 'Requires the platform admin role.';

  if (detail.actions?.writePathForThisObject === 'git-merge-request') {
    /*
     * O Create do portal e o bot de MR são create-only (scripts/open_provision_mrs.py recusa
     * arquivo que já existe na main). Por isso esta ação NÃO abre o wizard: ele abria um Create
     * vazio para um objeto que já existe, prometendo um update que o backend não faz. A ação
     * verdadeira é editar o arquivo de origem no GitLab, que vira MR; ela só fica ativa quando o
     * Argo provou de qual arquivo o objeto veio (`trail.gitopsPath`).
     */
    const href = gitlabEditUrl(detail.trail?.gitopsPath);
    actions.push({
      id: 'request-change',
      label: pt ? 'Editar no GitLab (abre MR)' : 'Edit in GitLab (opens an MR)',
      enforcement: pt
        ? 'O portal não altera instância existente: a mudança é um merge request no arquivo GitOps, revisado e aplicado pelo Argo CD'
        : 'The portal does not change an existing instance: the change is a merge request on the GitOps file, reviewed and applied by Argo CD',
      enabled: Boolean(href),
      disabledReason: href ? undefined : (pt
        ? 'O Argo não comprova de qual arquivo em platform/instances este objeto veio, então não há arquivo para editar com segurança.'
        : 'Argo does not prove which platform/instances file this object came from, so there is no file to edit safely.'),
      via: 'write-path',
      href: href ?? undefined,
    });
  }
  if (DAY2_KINDS.has(kind)) {
    actions.push({
      id: 'restart',
      label: pt ? 'Reiniciar' : 'Restart',
      enforcement: detail.actions?.day2Enforcement ?? 'POST /cluster/{scale,restart,delete-pod}',
      enabled: Boolean(detail.actions?.callerIsAdmin),
      disabledReason: detail.actions?.callerIsAdmin ? undefined : notAdmin,
      via: 'day2-api',
    });
  }
  return actions;
}

/* -------------------------------------------------------------------------- */
/* Corrida de resposta                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Porteiro de leituras concorrentes: diz qual resposta vale e cancela as anteriores.
 *
 * O problema que ele resolve é de ORDEM, não de erro. A listagem e o detalhe disparam leitura em
 * vários gatilhos (filtro, refresh automático, botão Atualizar, troca de objeto), e duas podem
 * estar no ar ao mesmo tempo. Sem porteiro, quem pinta a tela é a que CHEGA por último, que não é
 * necessariamente a que foi pedida por último: o usuário via a lista do filtro anterior com o
 * filtro novo selecionado, e um erro antigo apagava um detalhe que já havia carregado.
 *
 * `begin()` aborta a leitura anterior e devolve o par (token, signal) da nova. `isCurrent(token)`
 * é o que cada resposta consulta antes de escrever estado. É um objeto comum, sem React, para que
 * essa decisão seja testável com resoluções intercaladas de verdade.
 */
export interface RequestGate {
  begin(): { token: number; signal: AbortSignal };
  isCurrent(token: number): boolean;
  /** Cancela o que está no ar sem abrir leitura nova (desmontar o componente). */
  abort(): void;
}

export function createRequestGate(): RequestGate {
  let token = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      token += 1;
      return { token, signal: controller.signal };
    },
    isCurrent(candidate: number) {
      return candidate === token;
    },
    abort() {
      controller?.abort();
      controller = null;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Classificação da falha                                                      */
/* -------------------------------------------------------------------------- */

/** As fontes que falharam, para o aviso de degradado nomear quem caiu. */
export function failedSources(sources: { source: string; ok: boolean; error: string }[] | undefined): string[] {
  return (sources ?? []).filter(source => !source.ok).map(source => `${source.source}${source.error ? ` (${source.error})` : ''}`);
}
