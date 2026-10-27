// @vitest-environment jsdom
/*
 * Scorecards (scorecards-standards).
 *
 * O que se prova: o nível é sempre texto + ícone (nunca só cor); regras que falharam vêm primeiro; a
 * página lê GET /cluster/scorecards uma vez, mostra o agregado por nível e por regra, lista pior nível
 * primeiro, troca o detalhe pela seleção e abre o detalhe do recurso; Argo ilegível vira aviso; erro de
 * leitura vira LoadFailure, nunca uma lista vazia de sucesso; `null` do servidor é "Não avaliado".
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scorecard, ScorecardItem, ScorecardsResponse } from './kdpInventoryApi';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub { observe(): void { /* jsdom */ } unobserve(): void { /* noop */ } disconnect(): void { /* noop */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const listScorecards = vi.fn<(namespace: string, signal?: AbortSignal) => Promise<ScorecardsResponse>>();
vi.mock('./kdpInventoryApi', async () => {
  const actual = await vi.importActual<typeof import('./kdpInventoryApi')>('./kdpInventoryApi');
  return { ...actual, listScorecards: (namespace: string, signal?: AbortSignal) => listScorecards(namespace, signal) };
});

const { ScorecardsPage, ruleRows } = await import('./ScorecardsPage');
const { levelIndicator, orderRules } = await import('./scorecardParts');
const { InventoryError } = await import('./kdpInventoryApi');
const { I18nProvider } = await import('./i18n');

const STANDARDS: ScorecardsResponse['standards'] = {
  version: 1, levels: ['bronze', 'silver', 'gold'],
  rules: [
    { id: 'ready', level: 'bronze', check: 'ready', engines: null, title: 'Resource is Ready', titlePt: 'Recurso está Ready', description: 'd', descriptionPt: 'd' },
    { id: 'owner-declared', level: 'bronze', check: 'owner', engines: null, title: 'Owner declared', titlePt: 'Owner declarado', description: 'd', descriptionPt: 'd' },
    { id: 'gitops-tracked', level: 'silver', check: 'gitops-tracked', engines: null, title: 'Managed by GitOps', titlePt: 'Gerido por GitOps', description: 'd', descriptionPt: 'd' },
    { id: 'environment-declared', level: 'silver', check: 'spec-field', engines: ['kro'], title: 'Environment declared', titlePt: 'Environment declarado', description: 'd', descriptionPt: 'd' },
  ],
};

function card(level: Scorecard['level'], failing: string[] = []): Scorecard {
  const rules = STANDARDS.rules.map(rule => ({ id: rule.id, level: rule.level, passed: !failing.includes(rule.id), evidence: failing.includes(rule.id) ? `${rule.id} missing` : `${rule.id} ok`, title: rule.title, titlePt: rule.titlePt }));
  return { level, passed: rules.filter(rule => rule.passed).length, total: rules.length, rules, argoReadable: true };
}

function item(name: string, level: Scorecard['level'], failing: string[] = []): ScorecardItem {
  return { name, namespace: 'appmod', kind: 'StaticWebApp', capability: 'static-web-app', engine: 'kro', owner: 'platform-team', ready: true, scorecard: card(level, failing) };
}

function response(items: ScorecardItem[], patch: Partial<ScorecardsResponse> = {}): ScorecardsResponse {
  const byLevel = { none: 0, bronze: 0, silver: 0, gold: 0 };
  items.forEach(entry => { byLevel[entry.scorecard.level] += 1; });
  const rules = STANDARDS.rules.map(rule => ({
    id: rule.id,
    applicable: items.length,
    passed: items.filter(entry => entry.scorecard.rules.find(row => row.id === rule.id)?.passed).length,
  }));
  // O servidor devolve pior nível primeiro; a página confia nessa ordem, então a fixture a reproduz.
  const rank = { none: 0, bronze: 1, silver: 2, gold: 3 };
  const sorted = [...items].sort((a, b) => rank[a.scorecard.level] - rank[b.scorecard.level] || a.name.localeCompare(b.name));
  return { namespace: '_all', standards: STANDARDS, summary: { total: items.length, byLevel }, rules, items: sorted, argoReadable: true, partial: false, truncatedSources: [], sources: [{ source: 'static-web-app:StaticWebApp', ok: true, error: '' }], readAt: 1, ...patch };
}

describe('scorecard parts (pure)', () => {
  it('names the level in words next to the count and never relies on colour alone', () => {
    expect(levelIndicator({ level: 'gold', passed: 7, total: 7 }, true)).toEqual({ type: 'success', text: 'Ouro · 7/7' });
    expect(levelIndicator({ level: 'none', passed: 2, total: 7 }, false)).toEqual({ type: 'error', text: 'No level · 2/7' });
    expect(levelIndicator(null, true)).toEqual({ type: 'pending', text: 'Não avaliado' });
    const types = new Set((['none', 'bronze', 'silver', 'gold'] as const).map(level => levelIndicator({ level, passed: 0, total: 0 }, true).type));
    expect(types.size).toBe(4); // quatro glifos distintos
  });

  it('orders failed rules first, then bronze before gold', () => {
    const ordered = orderRules(card('none', ['gitops-tracked', 'owner-declared']).rules).map(rule => rule.id);
    expect(ordered).toEqual(['owner-declared', 'gitops-tracked', 'ready', 'environment-declared']);
  });

  it('computes the pass rate per rule and keeps a rule with no applicable resource as null', () => {
    const rows = ruleRows({ standards: STANDARDS, rules: [{ id: 'ready', applicable: 4, passed: 3 }, { id: 'owner-declared', applicable: 0, passed: 0 }] });
    expect(rows.find(row => row.id === 'ready')?.percent).toBe(75);
    expect(rows.find(row => row.id === 'owner-declared')?.percent).toBeNull();
    expect(rows.find(row => row.id === 'gitops-tracked')?.applicable).toBe(0);
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  listScorecards.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(onOpenDetail = vi.fn()) {
  await act(async () => { root.render(<I18nProvider><ScorecardsPage onOpenDetail={onOpenDetail} /></I18nProvider>); });
  await act(async () => { await Promise.resolve(); });
  return { onOpenDetail };
}
const textOf = () => host.textContent ?? '';

describe('ScorecardsPage', () => {
  it('reads the scope once and shows levels, pass rates and the worst resource first', async () => {
    listScorecards.mockResolvedValue(response([item('gold-one', 'gold'), item('orphan', 'none', ['owner-declared']), item('silverish', 'silver', ['environment-declared'])]));
    await mount();
    expect(listScorecards).toHaveBeenCalledTimes(1);
    expect(listScorecards).toHaveBeenCalledWith('_all', expect.any(AbortSignal));
    const text = textOf();
    expect(text).toContain('Ouro');
    expect(text).toContain('Prata');
    expect(text).toContain('Sem nível');
    expect(text).toContain('Owner declarado');
    expect(text).toContain('2/3'); // owner-declared passou em 2 de 3
    const tables = Array.from(host.querySelectorAll('table'));
    const names = Array.from(tables[tables.length - 1].querySelectorAll('tbody tr td:nth-child(2)'));
    expect(names.map(cell => cell.textContent)).toEqual(['orphan', 'silverish', 'gold-one']);
  });

  it('shows the selected resource rules, failed first, and opens its detail', async () => {
    listScorecards.mockResolvedValue(response([item('orphan', 'none', ['owner-declared'])]));
    const { onOpenDetail } = await mount();
    const radio = host.querySelector('table input[type="radio"]') as HTMLInputElement | null;
    expect(radio).not.toBeNull();
    await act(async () => { radio!.click(); });
    const text = textOf();
    expect(text).toContain('orphan · Sem nível');
    expect(text).toContain('owner-declared missing');
    const firstRule = host.querySelectorAll('table')[2]?.querySelector('tbody tr td')?.textContent ?? '';
    expect(firstRule).toContain('Owner declarado');
    const open = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('Abrir detalhe'));
    await act(async () => { open!.click(); });
    expect(onOpenDetail).toHaveBeenCalledWith(expect.stringContaining('/appmod/orphan'));
  });

  it('warns when Argo CD was unreadable and names a failed source', async () => {
    listScorecards.mockResolvedValue(response([item('x', 'bronze', ['gitops-tracked'])], {
      argoReadable: false, partial: true,
      sources: [{ source: 'static-web-app:StaticWebApp', ok: true, error: '' }, { source: 'web-api:WebApi', ok: false, error: 'http_403' }],
    }));
    await mount();
    const text = textOf();
    expect(text).toContain('Argo CD não pôde ser lido');
    expect(text).toContain('web-api:WebApi');
  });

  it('turns a read failure into LoadFailure with retry, never an empty success list', async () => {
    listScorecards.mockRejectedValueOnce(new InventoryError(503, 'standards invalid: unknown check'));
    listScorecards.mockResolvedValueOnce(response([item('later', 'gold')]));
    await mount();
    expect(textOf()).toContain('standards invalid: unknown check');
    expect(textOf()).not.toContain('Nenhum recurso no escopo');
    const retry = Array.from(host.querySelectorAll('button')).find(button => /Tentar de novo|Ler de novo/.test(button.textContent ?? ''));
    await act(async () => { retry!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(textOf()).toContain('later');
  });
});
