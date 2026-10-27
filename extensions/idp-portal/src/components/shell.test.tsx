/*
 * Shell do portal no One Theme: os componentes da moldura não têm cor escrita à mão (vem dos componentes
 * Cloudscape ou dos design tokens) e continuam com o mesmo contrato de props e o mesmo conteúdo.
 * Render de servidor dentro de um MemoryRouter, porque o projeto não tem jsdom.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { CategoryIndex } from './CategoryIndex';
import { TwoColumnIndex } from './TwoColumnIndex';
import { MaintenancePage } from './MaintenancePage';
import { Header } from './Header';

const SHELL = ['/src/App.tsx', '/src/components/Header.tsx', '/src/components/UserInfoBar.tsx', '/src/components/CategoryIndex.tsx',
  '/src/components/TwoColumnIndex.tsx', '/src/components/MaintenancePage.tsx', '/src/components/ReportList.tsx',
  '/src/components/IconMap.tsx', '/src/components/ItemList.tsx', '/index.html'];
const sources = import.meta.glob(['/src/App.tsx', '/src/components/*.tsx', '/index.html'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const inRouter = (node: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const reports = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Report ${i + 1}`, path: `/r/${i + 1}`, date: `2026-10-${String(i + 1).padStart(2, '0')}` }));

const originalError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return;
    originalError(...args);
  });
});
afterAll(() => { vi.restoreAllMocks(); });

describe('shell sem cor escrita à mão', () => {
  it.each(SHELL)('%s não tem cor hex nem rgba', path => {
    expect(sources[path], `${path} not loaded`).toBeTypeOf('string');
    expect(sources[path].match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []).toEqual([]);
  });

  it('nenhum componente da moldura usa hover feito à mão em style inline', () => {
    for (const path of SHELL) expect(sources[path]).not.toMatch(/onMouseEnter|onMouseLeave/);
  });
});

describe('shell renderiza o mesmo conteúdo', () => {
  it('Header mostra o nome do app e o atalho para o Portal', () => {
    const t = text(inRouter(<Header appName="AppMod LATAM" showBack />));
    expect(t).toContain('AppMod LATAM');
    expect(t).toContain('Portal');
  });

  it('MaintenancePage mantém o aviso em en-US e pt-BR e o link de volta', () => {
    const html = inRouter(<MaintenancePage appName="Pipeline" />);
    const t = text(html);
    expect(html).toContain('role="status"');
    expect(t).toContain('Pipeline: under maintenance');
    expect(t).toContain('O que mudou');
    expect(t).toContain('#platform-team');
    expect(t).toContain('Back to Hub / Voltar ao Hub');
  });

  it('CategoryIndex mostra o mais novo primeiro, 5 por página, com paginação', () => {
    const html = inRouter(<CategoryIndex categoryName="Guardian" reports={reports(7)} />);
    const t = text(html);
    expect(t).toContain('Guardian');
    expect(t.indexOf('Report 7')).toBeLessThan(t.indexOf('Report 6'));
    expect(t).not.toContain('Report 2 ');
    expect(html).toContain('aria-label="Next page"');
    expect(t).toMatch(/\b1 2\b/);
  });

  it('CategoryIndex vazio diz que não há reports', () => {
    expect(text(inRouter(<CategoryIndex categoryName="Guardian" reports={[]} />))).toContain('No reports yet');
  });

  it('TwoColumnIndex mostra busca, contador por seção e os itens', () => {
    const t = text(inRouter(<TwoColumnIndex sections={[{ name: 'A', reports: reports(2) }, { name: 'B', reports: [] }]} />));
    expect(t).toContain('(2)');
    expect(t).toContain('Report 1');
    expect(t).toContain('No reports yet');
  });
});
