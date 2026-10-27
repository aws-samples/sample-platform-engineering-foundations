// Loader do backlog vivo: platform/backlog/backlog.yaml empacotado no build.
// Mesmo contrato do catálogo - um agent edita o YAML via MR e o portal reflete.
import { parse } from 'yaml';

export type BacklogStatus = 'done' | 'doing' | 'todo' | 'blocked';
export type BacklogWiring = 'live' | 'mock' | 'n/a';
// P0 = próximo a ser feito (prioridade máxima), P1 = alta. Sem campo = sem prioridade definida.
export type BacklogPriority = 'P0' | 'P1' | 'P2';

export interface BacklogArea { id: string; name: string; namePt: string }
export interface BacklogItem {
  id: string;
  area: string;
  status: BacklogStatus;
  wiring: BacklogWiring;
  priority?: BacklogPriority;
  title: string;
  titlePt: string;
  detail: string;
  detailPt: string;
  // De onde o pedido veio (pessoa, conversa, data). Opcional para os itens antigos;
  // obrigatório na prática para item novo, para dar para rastrear a próxima feature.
  source?: string;
  // Ids de outros itens dos quais este depende. Opcional; quando existe, todo id precisa existir.
  dependsOn?: string[];
}

const PRIORITY_ORDER: Record<BacklogPriority, number> = { P0: 0, P1: 1, P2: 2 };

export function priorityRank(item: Pick<BacklogItem, 'priority'>): number {
  return item.priority ? PRIORITY_ORDER[item.priority] : 3;
}

interface BacklogFile { areas: BacklogArea[]; items: BacklogItem[] }

const files = import.meta.glob('../../platform/backlog/backlog.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const raw = Object.values(files)[0] ?? 'areas: []\nitems: []';
const parsed = parse(raw) as BacklogFile;

// No flavor oss o build entrega o YAML vazio (vite.config.ts): o backlog é gestão interna, não produto.
export const backlogAreas: BacklogArea[] = parsed.areas ?? [];
export const backlogItems: BacklogItem[] = parsed.items ?? [];

export function backlogProgress(items: BacklogItem[] = backlogItems): { done: number; doing: number; todo: number; blocked: number; total: number; percent: number } {
  const done = items.filter(i => i.status === 'done').length;
  const doing = items.filter(i => i.status === 'doing').length;
  const blocked = items.filter(i => i.status === 'blocked').length;
  const total = items.length;
  return { done, doing, blocked, todo: total - done - doing - blocked, total, percent: total ? Math.round((done / total) * 100) : 0 };
}
