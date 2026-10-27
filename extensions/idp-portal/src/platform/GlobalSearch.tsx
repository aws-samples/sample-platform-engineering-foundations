/*
 * Busca global (backlog global-search): uma caixa no topo do menu lateral que acha página, capability do
 * catálogo e instância live pelo nome, agrupadas por tipo, com teclado em primeiro lugar (o
 * Autosuggest do Cloudscape já é navegável por setas e Enter).
 *
 * Fontes, nesta ordem e por este motivo:
 *   1. páginas: lista estática das views, para "ir a uma tela pelo nome";
 *   2. capabilities: o catálogo embutido no bundle (nome, id, kind, descrição), sem rede;
 *   3. instâncias: GET /cluster/instances?q= da cluster-api, que já casa nome, namespace, kind,
 *      capability e owner no servidor e aplica o escopo do projeto ativo. Agents entram como
 *      instâncias quando o projeto Agent Builder está no escopo (são objetos kagent.dev listados).
 *
 * As páginas vêm do route registry (`SEARCHABLE_ROUTES`, routes/routeRegistry.ts): uma view nova
 * entra na busca sozinha, sem lista paralela aqui.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Autosuggest, { AutosuggestProps } from '@cloudscape-design/components/autosuggest';
import { SEARCHABLE_ROUTES, SearchableRoute } from './routes/routeRegistry';
import type { Capability } from './catalogLoader';
import { useI18n } from './i18n';
import { ALL_NAMESPACES, InstanceRow, InventoryError, listInstances } from './kdpInventoryApi';
import { detailPath } from './kdpInventoryModel';
import { servicePathFor } from './serviceCatalog';

export type SearchTarget =
  | { kind: 'view'; view: string }
  | { kind: 'path'; path: string };

export interface SearchHit {
  /** Único por tipo + id. É o `value` do Autosuggest, e por isso nunca é texto livre do usuário. */
  value: string;
  label: string;
  description: string;
  tags?: string[];
  target: SearchTarget;
}

export interface SearchGroup { label: string; options: SearchHit[] }

/** Páginas pesquisáveis pelo nome: derivadas do route registry (uma view nova entra sozinha). */
export const SEARCH_VIEWS: readonly SearchableRoute[] = SEARCHABLE_ROUTES;

const norm = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Casamento por substring, sem acento e sem caixa, em QUALQUER dos campos. */
export function matches(query: string, ...fields: string[]): boolean {
  const needle = norm(query.trim());
  if (!needle) return false;
  return fields.some(field => norm(field).includes(needle));
}

export function searchViews(query: string, pt: boolean): SearchHit[] {
  return SEARCH_VIEWS
    .filter(entry => matches(query, entry.pt, entry.en, entry.view, entry.hint.pt, entry.hint.en))
    .map(entry => ({ value: `view:${entry.view}`, label: pt ? entry.pt : entry.en, description: pt ? entry.hint.pt : entry.hint.en, target: { kind: 'view', view: entry.view } }));
}

export function searchCapabilities(query: string, catalog: readonly Capability[], pt: boolean): SearchHit[] {
  return catalog
    .filter(capability => capability.lifecycle !== 'deprecated')
    .filter(capability => matches(query, capability.displayName, capability.displayNamePt, capability.id, capability.liveCapability, capability.name, capability.description, capability.descriptionPt))
    .slice(0, 8)
    .map(capability => ({
      value: `capability:${capability.id}`,
      label: pt ? capability.displayNamePt || capability.displayName : capability.displayName,
      description: pt ? capability.descriptionPt || capability.description : capability.description,
      tags: [capability.engine, capability.lifecycle],
      target: { kind: 'path', path: servicePathFor(capability.id) },
    }));
}

export function instanceHits(rows: readonly InstanceRow[], pt: boolean): SearchHit[] {
  return rows.map(row => ({
    value: `instance:${row.capability}/${row.namespace}/${row.name}`,
    label: row.name,
    description: `${row.kind} · ${row.namespace}${row.owner ? ` · ${pt ? 'owner' : 'owner'} ${row.owner}` : ''}`,
    tags: [row.ready ? (pt ? 'pronto' : 'ready') : (pt ? 'não pronto' : 'not ready')],
    target: { kind: 'path', path: detailPath(row) },
  }));
}

/** Primeiro resultado na ordem dos grupos; é o que Enter abre quando o usuário não escolheu um. */
export function firstHit(groups: readonly SearchGroup[]): SearchHit | null {
  return groups.find(group => group.options.length > 0)?.options[0] ?? null;
}

export function groupHits(views: SearchHit[], caps: SearchHit[], instances: SearchHit[], pt: boolean): SearchGroup[] {
  const groups: SearchGroup[] = [];
  if (views.length) groups.push({ label: pt ? 'Páginas' : 'Pages', options: views });
  if (caps.length) groups.push({ label: pt ? 'Capabilities' : 'Capabilities', options: caps });
  if (instances.length) groups.push({ label: pt ? 'Instâncias' : 'Instances', options: instances });
  return groups;
}

export interface GlobalSearchProps {
  catalog: readonly Capability[];
  onNavigate(target: SearchTarget): void;
  /** Injetável para teste. Default: GET /cluster/instances?q= no escopo ativo. */
  findInstances?: (query: string, signal: AbortSignal) => Promise<InstanceRow[]>;
}

const INSTANCE_LIMIT = 8;
const DEBOUNCE_MS = 250;

async function defaultFindInstances(query: string, signal: AbortSignal): Promise<InstanceRow[]> {
  const page = await listInstances({ namespace: ALL_NAMESPACES, search: query, sort: 'created', order: 'desc', limit: INSTANCE_LIMIT }, signal);
  return page.items;
}

export function GlobalSearch({ catalog, onNavigate, findInstances = defaultFindInstances }: GlobalSearchProps): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [query, setQuery] = useState('');
  const [instances, setInstances] = useState<InstanceRow[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [errorText, setErrorText] = useState('');
  const gate = useRef(new AbortController());

  useEffect(() => {
    gate.current.abort();
    const trimmed = query.trim();
    // Resultado da consulta ANTERIOR sai na hora: instância de "hello" listada sob "composicoes"
    // lia como resultado da nova consulta (medido live, 24/10/2026).
    setInstances([]);
    if (trimmed.length < 2) { setStatus('idle'); return; }
    const controller = new AbortController();
    gate.current = controller;
    setStatus('loading');
    const timer = setTimeout(() => {
      findInstances(trimmed, controller.signal).then(rows => {
        if (controller.signal.aborted) return;
        setInstances(rows);
        setStatus('idle');
      }).catch(cause => {
        if (controller.signal.aborted || (cause instanceof InventoryError && cause.aborted)) return;
        setInstances([]);
        setErrorText(cause instanceof Error ? cause.message : 'cluster API unavailable');
        setStatus('error');
      });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, findInstances]);

  const groups = useMemo(() => groupHits(searchViews(query, pt), searchCapabilities(query, catalog, pt), instanceHits(instances, pt), pt), [query, catalog, instances, pt]);
  const options: AutosuggestProps.Options = groups.map(group => ({ label: group.label, options: group.options.map(hit => ({ value: hit.value, label: hit.label, description: hit.description, tags: hit.tags })) }));
  const hits = new Map(groups.flatMap(group => group.options.map(hit => [hit.value, hit] as const)));

  return (
    <Autosuggest
      value={query}
      onChange={({ detail }) => setQuery(detail.value)}
      onSelect={({ detail }) => {
        // Enter na linha "Buscar ..." (texto digitado) abre o PRIMEIRO resultado, na ordem dos grupos.
        const hit = hits.get(detail.value) ?? firstHit(groups);
        if (!hit) return;
        setQuery('');
        onNavigate(hit.target);
      }}
      options={options}
      statusType={status === 'loading' ? 'loading' : status === 'error' ? 'error' : 'finished'}
      loadingText={pt ? 'Lendo instâncias do cluster' : 'Reading instances from the cluster'}
      errorText={pt ? `Instâncias não lidas: ${errorText}` : `Instances not read: ${errorText}`}
      recoveryText={pt ? 'Tentar de novo' : 'Retry'}
      empty={query.trim().length < 2 ? (pt ? 'Digite 2+ letras: página, serviço, instância ou owner.' : 'Type 2+ letters: page, service, instance or owner.') : (pt ? 'Nada com esse nome.' : 'Nothing with that name.')}
      enteredTextLabel={value => (pt ? `Buscar "${value}"` : `Search "${value}"`)}
      placeholder={pt ? 'Buscar página, serviço, instância, owner' : 'Search page, service, instance, owner'}
      ariaLabel={pt ? 'Busca global' : 'Global search'}
      filteringType="manual"
      expandToViewport
    />
  );
}
