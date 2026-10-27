/**
 * Route registry do shell: a ÚNICA lista de views do portal.
 *
 * Antes havia quatro enumerações paralelas da mesma coisa (o tipo `View` e `VALID_VIEWS` no shell,
 * `TITLES` em shellNavigation, `SEARCH_VIEWS` na busca global, `DRAFT_VIEWS` no contentKey), e um
 * teste de paridade segurava duas delas. Uma view nova exigia lembrar de quatro lugares; esquecer um
 * dava página sem título na aba ou invisível na busca, sem erro de compilação. Aqui cada view é uma
 * entrada e as outras listas DERIVAM dela: esquecer é impossível, e o tipo `ViewId` sai da própria
 * lista, então `view === 'x'` com id inexistente é erro de tipo.
 *
 * O que fica FORA daqui, de propósito: o render de cada view (props diferentes por página; o shell
 * continua dono do switch e um teste prende que todo id tem um branch) e os badges do menu, que são
 * JSX dependente de estado live (contagens). O menu lê texto e href daqui; o resto segue no shell.
 *
 * Fronteira para o aws-samples: a extension troca ou corta entradas aqui (sem Studio ou Admin, por
 * exemplo) sem tocar no shell. `canonicalPath` é o caminho relativo a `/agent-platform/` que a URL
 * sem hash vai usar; hoje o hash (`#id`) é a forma canônica de navegação, o caminho é aceito como
 * entrada e normalizado para o hash, preservando `?project=`.
 */

export interface RouteDef {
  /** Id estável: é o hash (`#id`), o `data-view` e a chave de telemetria. */
  readonly id: string;
  /** Título da aba e nome padrão no menu/busca. */
  readonly title: { readonly pt: string; readonly en: string };
  /**
   * Descrição curta mostrada na busca global. Ausente = a view não aparece na busca (telas
   * legadas, só alcançáveis por link antigo).
   */
  readonly searchHint?: { readonly pt: string; readonly en: string };
  /** Rótulo no menu e na busca quando difere do título da aba (ex.: "Studio" vs "Service Owner Studio"). */
  readonly label?: { readonly pt: string; readonly en: string };
  /** A view guarda rascunho: não remonta ao trocar de projeto e pede confirmação na troca. */
  readonly draft?: true;
  /** Aceita `#id/<routeId>` (plano, pedido): o shell lê o parâmetro com `routeParam`. */
  readonly acceptsParam?: true;
  /** Tela legada, mantida só para link antigo não quebrar; fora do menu e da busca. */
  readonly legacy?: true;
  /** Hashes antigos que ainda levam a esta view (`#old` -> `#id`). */
  readonly aliases?: readonly string[];
}

const T = (pt: string, en: string) => ({ pt, en } as const);

export const ROUTES = [
  { id: 'home', title: T('Início', 'Home'), searchHint: T('dashboard', 'dashboard') },
  { id: 'catalog', title: T('Catálogo', 'Catalog'), searchHint: T('serviços da plataforma', 'platform services') },
  { id: 'compositions', title: T('Composições', 'Compositions'), searchHint: T('ResourceGraphDefinitions do kro', 'kro ResourceGraphDefinitions') },
  { id: 'scorecards', title: T('Scorecards', 'Scorecards'), searchHint: T('padrões, níveis Bronze/Prata/Ouro', 'standards, Bronze/Silver/Gold levels') },
  { id: 'dependencies', title: T('Dependências', 'Dependencies'), searchHint: T('quem consome output de quem entre instâncias', 'who consumes whose outputs across instances') },
  { id: 'teams', title: T('Times', 'Teams'), searchHint: T('owners, contatos, Slack', 'owners, contacts, Slack') },
  { id: 'docs', title: T('Documentação', 'Documentation'), searchHint: T('tour, guias, golden paths, autoria', 'tour, guides, golden paths, authoring') },
  { id: 'overview', title: T('Visão geral', 'Overview'), searchHint: T('operações', 'operations') },
  { id: 'getting-started', title: T('Primeiros passos', 'Getting started'), searchHint: T('10 minutos', '10 minutes') },
  { id: 'provision', title: T('Provisionar', 'Provision'), searchHint: T('pedir um recurso', 'request a resource'), draft: true },
  { id: 'agent-builder', title: T('Agent Builder', 'Agent Builder'), searchHint: T('criar agent kagent', 'build a kagent agent'), draft: true },
  { id: 'studio', title: T('Service Owner Studio', 'Service Owner Studio'), label: T('Studio', 'Studio'), searchHint: T('Service Owner', 'Service Owner'), draft: true, acceptsParam: true },
  { id: 'assistant', title: T('Platform Assistant', 'Platform Assistant'), label: T('Assistant', 'Assistant'), searchHint: T('Platform Assistant', 'Platform Assistant'), acceptsParam: true },
  { id: 'project', title: T('Contexto do projeto', 'Project context'), label: T('Projeto', 'Project'), searchHint: T('contexto do projeto', 'project context') },
  { id: 'inventory', title: T('Inventário', 'Inventory'), legacy: true },
  { id: 'entity', title: T('Entidade', 'Entity'), legacy: true },
  { id: 'operate', title: T('Operar', 'Operate'), searchHint: T('Day 2', 'Day 2') },
  { id: 'gateway', title: T('AI Gateway', 'AI Gateway'), searchHint: T('Bedrock privado', 'private Bedrock') },
  { id: 'personas', title: T('Personas', 'Personas'), searchHint: T('chat com personas', 'chat with personas') },
  { id: 'cluster', title: T('Cluster', 'Cluster'), searchHint: T('workloads, pods, nodes', 'workloads, pods, nodes') },
  { id: 'help', title: T('Ajuda', 'Help'), searchHint: T('como usar', 'how to use') },
  { id: 'admin', title: T('Admin', 'Admin'), label: T('Administração da plataforma', 'Platform admin'), searchHint: T('administração', 'administration') },
  { id: 'integrations', title: T('Integrações', 'Integrations'), searchHint: T('saúde de Argo CD, kro, ACK, Keycloak, Langfuse, Grafana', 'health of Argo CD, kro, ACK, Keycloak, Langfuse, Grafana') },
  { id: 'audit', title: T('Auditoria', 'Audit log'), searchHint: T('quem fez o quê: pedidos, MRs, planos, ações Day 2', 'who did what: requests, MRs, plans, Day 2 actions') },
] as const satisfies readonly RouteDef[];

export type ViewId = (typeof ROUTES)[number]['id'];

/** Todo id, na ordem do registry. É o que era `VALID_VIEWS`. */
export const VIEW_IDS: readonly ViewId[] = ROUTES.map(route => route.id);

const BY_ID: ReadonlyMap<string, RouteDef> = new Map(ROUTES.map(route => [route.id, route]));
const BY_ALIAS: ReadonlyMap<string, ViewId> = new Map(
  ROUTES.flatMap(route => (route as RouteDef).aliases?.map(alias => [alias, route.id] as const) ?? []),
);

export function isViewId(value: string): value is ViewId {
  return BY_ID.has(value);
}

export function routeDef(view: ViewId): RouteDef {
  return BY_ID.get(view) as RouteDef;
}

/** Views que guardam rascunho (não remontam na troca de projeto). Era `DRAFT_VIEWS`. */
export const DRAFT_VIEW_IDS: ReadonlySet<string> = new Set(ROUTES.filter(route => (route as RouteDef).draft).map(route => route.id));

/** Prefixo canônico da SPA. Todo caminho de view é relativo a ele. */
export const APP_BASE = '/agent-platform/';

export const ROUTE_ID = /^[0-9a-f]{32}$/;

export interface ResolvedRoute {
  readonly view: ViewId;
  /** `#view/<id>` quando a view aceita parâmetro e ele tem a forma de route id. */
  readonly param: string | null;
  /** O hash veio de alias ou de caminho e deve ser normalizado para `canonical` (replace, não push). */
  readonly redirect: boolean;
  /** Hash canônico desta resolução. */
  readonly canonical: string;
  /** Hash pedido que não existe (nem id, nem alias): a home mostra o aviso de página inexistente. */
  readonly unknown: string | null;
}

/**
 * Resolve um location em view. Ordem: caminho canônico (`/agent-platform/<id>`), depois hash
 * (`#id` ou `#id/<routeId>`), depois alias. Hash vazio ou desconhecido cai na home, decisão do
 * shell desde o início (teste `test_unknown_hash_lands_on_dev_home`); o desconhecido vem nomeado em
 * `unknown` para a home avisar em vez de fingir que o link existia.
 */
export function resolveRoute(location: { pathname?: string; hash?: string }): ResolvedRoute {
  const pathname = String(location.pathname ?? '');
  const hash = String(location.hash ?? '').replace(/^#/, '');
  const fromPath = pathname.startsWith(APP_BASE) ? pathname.slice(APP_BASE.length).replace(/\/+$/, '') : '';
  // Caminho canônico: só um segmento e sem hash próprio. `services/...` é rota do router, não view.
  if (fromPath && !fromPath.includes('/') && isViewId(fromPath) && !hash) {
    return { view: fromPath, param: null, redirect: true, canonical: `#${fromPath}`, unknown: null };
  }
  if (!hash) return { view: 'home', param: null, redirect: false, canonical: '#home', unknown: null };
  const [head, rawParam] = hash.split('/');
  if (isViewId(head)) {
    const def = routeDef(head);
    const param = def.acceptsParam && rawParam && ROUTE_ID.test(rawParam) ? rawParam : null;
    return { view: head, param, redirect: false, canonical: param ? `#${head}/${param}` : `#${head}`, unknown: null };
  }
  const aliased = BY_ALIAS.get(head);
  if (aliased) return { view: aliased, param: null, redirect: true, canonical: `#${aliased}`, unknown: null };
  return { view: 'home', param: null, redirect: false, canonical: '#home', unknown: head };
}

/** Título da aba por view, para leitor de tela e histórico do browser distinguirem as telas. */
export function titleOf(view: string, pt: boolean): string | null {
  const def = BY_ID.get(view);
  return def ? (pt ? def.title.pt : def.title.en) : null;
}

export interface SearchableRoute {
  readonly view: ViewId;
  readonly pt: string;
  readonly en: string;
  readonly hint: { readonly pt: string; readonly en: string };
}

/** Páginas pesquisáveis pelo nome. Era `SEARCH_VIEWS`; agora deriva do registry. */
export const SEARCHABLE_ROUTES: readonly SearchableRoute[] = ROUTES
  .filter((route): route is (typeof ROUTES)[number] & { searchHint: { pt: string; en: string } } => Boolean((route as RouteDef).searchHint))
  .map(route => {
    const def = route as RouteDef;
    const label = def.label ?? def.title;
    return { view: route.id, pt: label.pt, en: label.en, hint: def.searchHint as { pt: string; en: string } };
  });

/** Rótulo de menu e busca: `label` quando existe, senão o título da aba. */
export function labelOf(view: ViewId, pt: boolean): string {
  const def = routeDef(view);
  const label = def.label ?? def.title;
  return pt ? label.pt : label.en;
}

/** Href de menu/link para uma view: sempre o hash canônico. */
export function viewHref(view: ViewId): string {
  return `#${view}`;
}
