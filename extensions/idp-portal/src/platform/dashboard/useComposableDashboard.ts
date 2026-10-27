import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgentBuilderMe } from '../agentBuilderApi';
import { errorMessage } from '../errors';
import { getActiveScope } from '../scope/activeScope';
import { getScopeContext } from '../scope/scopeApi';
import {
  defaultLayout, layoutProjectId, LayoutAction, normalizeLayout, paletteWidgets, reduceLayout, SavedLayout, WidgetPlacement,
} from './layoutModel';
import { LayoutStore, LocalLayoutStore } from './layoutStore';
import { authorizedWidgetsFrom } from './scopeAuthorization';
import { WidgetId } from './widgetRegistry';

export type DashboardIssue = '' | 'conflict' | 'unavailable' | 'invalid';

export type ComposableDashboardState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; layout: SavedLayout; palette: WidgetId[]; issue: DashboardIssue };

export interface ComposableDashboardController {
  state: ComposableDashboardState;
  /** Recebe os itens que o Board emitiu em `onItemsChange` (mover, redimensionar, inserir, remover). */
  setWidgets(widgets: readonly WidgetPlacement[]): Promise<DashboardIssue>;
  reset(): Promise<DashboardIssue>;
}

interface ReadyContext {
  userId: string;
  store: LayoutStore;
  layout: SavedLayout;
  persistedRevision: number | null;
  authorizedWidgets: ReadonlySet<WidgetId>;
}

export function useComposableDashboard(): ComposableDashboardController {
  const [state, setState] = useState<ComposableDashboardState>({ status: 'loading' });
  const ready = useRef<ReadyContext | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let active = true;
    let featureConfirmed = false;
    setState({ status: 'loading' });
    getAgentBuilderMe()
      .then(async me => {
        if (!active) return;
        if (me.features?.composableDashboard !== true) {
          ready.current = null;
          setState({ status: 'disabled' });
          return;
        }
        featureConfirmed = true;
        const scope = await getScopeContext();
        if (!active) return;
        const activeProject = getActiveScope().project;
        const projectId = layoutProjectId(activeProject);
        const authorizedWidgets = authorizedWidgetsFrom(scope, activeProject);
        if (authorizedWidgets.size === 0) {
          ready.current = null;
          setState({ status: 'error', message: 'no authorized dashboard widgets' });
          return;
        }
        const store = new LocalLayoutStore(window.localStorage);
        const stored = await store.load(me.alias, projectId);
        if (!active) return;
        const context = { projectId, authorizedWidgets };
        const normalized = normalizeLayout(stored ?? defaultLayout(context), context).layout;
        ready.current = { userId: me.alias, store, layout: normalized, persistedRevision: stored?.revision ?? null, authorizedWidgets };
        setState({ status: 'ready', layout: normalized, palette: paletteWidgets(normalized, authorizedWidgets), issue: '' });
      })
      .catch(cause => {
        if (!active) return;
        ready.current = null;
        setState(featureConfirmed
          ? { status: 'error', message: errorMessage(cause, 'dashboard unavailable') }
          : { status: 'disabled' });
      });
    return () => { active = false; };
  }, []);

  const publish = (context: ReadyContext, layout: SavedLayout, issue: DashboardIssue) => {
    context.layout = layout;
    setState({ status: 'ready', layout, palette: paletteWidgets(layout, context.authorizedWidgets), issue });
  };

  const apply = useCallback((action: LayoutAction): Promise<DashboardIssue> => {
    const context = ready.current;
    if (!context) return Promise.resolve('invalid');
    const operation = queue.current.then(async (): Promise<DashboardIssue> => {
      if (ready.current !== context) return 'invalid';
      const next = reduceLayout(context.layout, action, context.authorizedWidgets);
      if (next === null) {
        publish(context, context.layout, 'invalid');
        return 'invalid';
      }
      if (next === context.layout) return '';
      const result = await context.store.save(context.userId, { layout: next, expectedRevision: context.persistedRevision });
      if (ready.current !== context) return 'invalid';
      if (result.status === 'saved') {
        context.persistedRevision = result.layout.revision;
        publish(context, result.layout, '');
        return '';
      }
      const layoutContext = { projectId: context.layout.projectId, authorizedWidgets: context.authorizedWidgets };
      if (result.status === 'conflict') {
        const normalized = normalizeLayout(result.current ?? defaultLayout(layoutContext), layoutContext).layout;
        context.persistedRevision = result.current?.revision ?? null;
        publish(context, normalized, 'conflict');
        return 'conflict';
      }
      const issue = result.status === 'unavailable' ? 'unavailable' : 'invalid';
      publish(context, next, issue);
      return issue;
    });
    queue.current = operation.then(() => undefined);
    return operation;
  }, []);

  const reset = useCallback((): Promise<DashboardIssue> => {
    const context = ready.current;
    if (!context) return Promise.resolve('invalid');
    const operation = queue.current.then(async (): Promise<DashboardIssue> => {
      if (ready.current !== context) return 'invalid';
      const hadPersistedLayout = context.persistedRevision !== null;
      await context.store.reset(context.userId, context.layout.projectId);
      const stored = await context.store.load(context.userId, context.layout.projectId);
      if (ready.current !== context) return 'invalid';
      const layoutContext = { projectId: context.layout.projectId, authorizedWidgets: context.authorizedWidgets };
      const normalized = normalizeLayout(stored ?? defaultLayout(layoutContext), layoutContext).layout;
      const issue = hadPersistedLayout && !stored ? 'unavailable' : '';
      context.persistedRevision = stored?.revision ?? null;
      publish(context, normalized, issue);
      return issue;
    });
    queue.current = operation.then(() => undefined);
    return operation;
  }, []);

  return {
    state,
    setWidgets: widgets => apply({ type: 'set-widgets', widgets }),
    reset,
  };
}
