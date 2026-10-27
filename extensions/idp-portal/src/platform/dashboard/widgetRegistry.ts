/*
 * Registry dos widgets da Home.
 *
 * O layout é um Cloudscape Board de 4 colunas: `columnSpan` vai de 1 a 4 e `rowSpan` começa em 2
 * (limite do próprio Board). Em telas estreitas o Board reflui sozinho para 2 e 1 coluna, então não
 * existe layout separado por viewport.
 *
 * Este arquivo é candidato ao core publicável: nada aqui conhece scope, alias ou contrato interno.
 */
export const WIDGET_IDS = [
  'overview-summary',
  'recent-resources',
  'in-progress-operations',
  'catalog-highlights',
  'next-steps',
  'platform-health',
  'activity',
  'scorecards',
] as const;

export type WidgetId = typeof WIDGET_IDS[number];
export type WidgetCapability = 'project:read';

export const BOARD_COLUMNS = 4;
export const MIN_ROW_SPAN = 2;
export const MAX_ROW_SPAN = 12;

export interface WidgetBoardDefinition {
  defaultColumnSpan: number;
  defaultRowSpan: number;
  minColumnSpan: number;
  minRowSpan: number;
}

export interface WidgetDefinition {
  id: WidgetId;
  title: { pt: string; en: string };
  description: { pt: string; en: string };
  board: WidgetBoardDefinition;
  requiredCapability: WidgetCapability;
}

// Quatro tiles de KPI (~180 px) não cabem em 2 linhas do Board (~155 px de conteúdo): o item
// rolava e cortava o quarto tile (medido 24/10/2026). Mínimo 3 também corrige layout já salvo.
const KPIS: WidgetBoardDefinition = { defaultColumnSpan: 4, defaultRowSpan: 3, minColumnSpan: 2, minRowSpan: 3 };
const HALF: WidgetBoardDefinition = { defaultColumnSpan: 2, defaultRowSpan: 4, minColumnSpan: 1, minRowSpan: MIN_ROW_SPAN };
const WIDE: WidgetBoardDefinition = { defaultColumnSpan: 4, defaultRowSpan: 4, minColumnSpan: 2, minRowSpan: MIN_ROW_SPAN };
const THIRD: WidgetBoardDefinition = { defaultColumnSpan: 1, defaultRowSpan: 4, minColumnSpan: 1, minRowSpan: MIN_ROW_SPAN };

export const WIDGET_REGISTRY: Readonly<Record<WidgetId, WidgetDefinition>> = {
  'overview-summary': {
    id: 'overview-summary',
    title: { pt: 'Resumo da plataforma', en: 'Platform summary' },
    description: { pt: 'Serviços em uso, instâncias live, operações e saúde em quatro indicadores.', en: 'Services in use, live instances, operations and health in four indicators.' },
    board: KPIS,
    requiredCapability: 'project:read',
  },
  'recent-resources': {
    id: 'recent-resources',
    title: { pt: 'Recursos recentes', en: 'Recent resources' },
    description: { pt: 'Instâncias kro de todos os serviços, as mais novas primeiro.', en: 'kro instances across every service, newest first.' },
    board: HALF,
    requiredCapability: 'project:read',
  },
  'in-progress-operations': {
    id: 'in-progress-operations',
    title: { pt: 'Operações em andamento', en: 'Operations in progress' },
    description: { pt: 'O que ainda não convergiu, com progresso estimado.', en: 'What has not converged yet, with estimated progress.' },
    board: HALF,
    requiredCapability: 'project:read',
  },
  'catalog-highlights': {
    id: 'catalog-highlights',
    title: { pt: 'Do catálogo', en: 'From the catalog' },
    description: { pt: 'Os serviços em uso primeiro, depois o que você pode pedir agora.', en: 'Services in use first, then what you can request now.' },
    board: WIDE,
    requiredCapability: 'project:read',
  },
  'next-steps': {
    id: 'next-steps',
    title: { pt: 'Próximos passos', en: 'Next steps' },
    description: { pt: 'Sugeridos a partir do que a plataforma leu agora.', en: 'Suggested from what the platform read just now.' },
    board: HALF,
    requiredCapability: 'project:read',
  },
  'platform-health': {
    id: 'platform-health',
    title: { pt: 'Saúde da plataforma', en: 'Platform health' },
    description: { pt: 'Nodes, pods e compositions lidos da cluster-api.', en: 'Nodes, pods and compositions read from the cluster-api.' },
    board: THIRD,
    requiredCapability: 'project:read',
  },
  activity: {
    id: 'activity',
    title: { pt: 'Atividade', en: 'Activity' },
    description: { pt: 'Eventos do cluster, mais recentes primeiro.', en: 'Cluster events, newest first.' },
    board: THIRD,
    requiredCapability: 'project:read',
  },
  scorecards: {
    id: 'scorecards',
    title: { pt: 'Scorecards', en: 'Scorecards' },
    description: { pt: 'Quantos recursos atingem Bronze, Prata e Ouro contra os padrões em Git.', en: 'How many resources attain Bronze, Silver and Gold against the Git standards.' },
    board: HALF,
    requiredCapability: 'project:read',
  },
};

export function isWidgetId(value: unknown): value is WidgetId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WIDGET_REGISTRY, value);
}
