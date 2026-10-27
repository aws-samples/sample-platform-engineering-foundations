// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposableDashboardController, useComposableDashboard } from './useComposableDashboard';
import { WIDGET_IDS } from './widgetRegistry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const KEY = 'agent-platform:dashboard-layout:v2:user-a:agent-platform';
const mocks = vi.hoisted(() => ({
  enabled: true as boolean | undefined,
  readable: true,
  meFails: false,
}));
vi.mock('../agentBuilderApi', () => ({
  getAgentBuilderMe: () => {
    if (mocks.meFails) return Promise.reject(new Error('platform API unavailable'));
    return Promise.resolve({ alias: 'user-a', isAdmin: false, features: { composableDashboard: mocks.enabled } });
  },
}));
vi.mock('../scope/activeScope', () => ({ getActiveScope: () => ({ project: 'agent-platform', owners: {} }) }));
vi.mock('../scope/scopeApi', () => ({
  getScopeContext: () => Promise.resolve({
    version: 1, enforcement: 'strict', source: 'test', viewer: { alias: 'user-a', isAdmin: false },
    projects: mocks.readable
      ? [{ id: 'agent-platform', displayName: 'Agent Platform', role: 'viewer', namespaces: ['appmod'], gitopsPath: 'platform/instances', lifecycle: { state: 'active' } }]
      : [],
  }),
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  mocks.enabled = true;
  mocks.readable = true;
  mocks.meFails = false;
});

function Harness({ expose }: { expose(controller: ComposableDashboardController): void }): JSX.Element {
  const controller = useComposableDashboard();
  useEffect(() => expose(controller), [controller, expose]);
  if (controller.state.status !== 'ready') return <div>{controller.state.status}</div>;
  return <div>{`board:${controller.state.layout.widgets.map(item => item.widgetId).join(',')}|palette:${controller.state.palette.join(',')}`}</div>;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function mount(): Promise<() => ComposableDashboardController> {
  let controller: ComposableDashboardController | null = null;
  const expose = (value: ComposableDashboardController) => { controller = value; };
  act(() => root.render(<Harness expose={expose} />));
  await settle();
  return () => controller!;
}

it('loads authorized defaults, persists board changes by user and project, and exposes the palette', async () => {
  const controller = await mount();
  expect(host.textContent).toBe(`board:${WIDGET_IDS.join(',')}|palette:`);
  const widgets = controller().state.status === 'ready' ? (controller().state as { layout: { widgets: readonly { widgetId: string; columnSpan: number; rowSpan: number; columnOffset: object }[] } }).layout.widgets : [];
  const [first, ...rest] = widgets;
  await act(async () => { await controller().setWidgets([...rest, { ...first, rowSpan: 3 }] as never); });
  await settle();
  expect(host.textContent).toBe(`board:${[...WIDGET_IDS.slice(1), WIDGET_IDS[0]].join(',')}|palette:`);
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  expect(saved.revision).toBe(1);
  expect(saved.widgets.at(-1)).toMatchObject({ widgetId: 'overview-summary', rowSpan: 3 });
  await act(async () => { await controller().setWidgets(rest as never); });
  await settle();
  expect(host.textContent).toBe(`board:${WIDGET_IDS.slice(1).join(',')}|palette:overview-summary`);
  await act(async () => { await controller().reset(); });
  await settle();
  expect(host.textContent).toBe(`board:${WIDGET_IDS.join(',')}|palette:`);
  expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').revision).toBe(3);
});

it('returns the same layout and writes nothing when the board emits an identical arrangement', async () => {
  const controller = await mount();
  const widgets = (controller().state as { layout: { widgets: unknown[] } }).layout.widgets;
  const result = await controller().setWidgets(widgets as never);
  expect(result).toBe('');
  expect(localStorage.getItem(KEY)).toBeNull();
});

it('reports a conflict and reloads the newer layout when another tab saved first', async () => {
  const controller = await mount();
  const widgets = (controller().state as { layout: { widgets: readonly { widgetId: string }[] } }).layout.widgets;
  await act(async () => { await controller().setWidgets(widgets.slice(1) as never); });
  await settle();
  const other = JSON.parse(localStorage.getItem(KEY)!);
  other.revision = 7;
  other.widgets = other.widgets.slice(1);
  localStorage.setItem(KEY, JSON.stringify(other));
  let issue = '';
  await act(async () => { issue = await controller().setWidgets([] as never); });
  await settle();
  expect(issue).toBe('conflict');
  expect(host.textContent).toBe(`board:${WIDGET_IDS.slice(2).join(',')}|palette:${WIDGET_IDS.slice(0, 2).join(',')}`);
});

it.each([false, undefined])('keeps the existing Home path when the deployment flag is %s', async enabled => {
  mocks.enabled = enabled;
  const controller = await mount();
  expect(controller().state.status).toBe('disabled');
  expect(localStorage.length).toBe(0);
});

it('treats a platform-me failure as feature disabled and keeps the fixed Home', async () => {
  mocks.meFails = true;
  const controller = await mount();
  expect(controller().state.status).toBe('disabled');
});

it('falls back to the fixed Home instead of rendering an empty dashboard when scope has no widgets', async () => {
  mocks.readable = false;
  const controller = await mount();
  expect(controller().state.status).toBe('error');
  expect(localStorage.length).toBe(0);
});
