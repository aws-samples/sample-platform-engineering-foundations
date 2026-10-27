import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getScopeContext, ScopeRequestError } from './scopeApi';
import { readUrlScope, resolveSelection, ScopeContext, ScopeSelection, writeUrlScope } from './scopeModel';

export type ScopeLoadState =
  | { status: 'loading' }
  | { status: 'error'; error: ScopeRequestError }
  | { status: 'loaded'; context: ScopeContext };

export interface ProjectScope {
  state: ScopeLoadState;
  /** `null` enquanto o contexto não carregou. */
  selection: ScopeSelection | null;
  select(project: string, namespace?: string): void;
  retry(): void;
}

type Loader = (signal: AbortSignal) => Promise<ScopeContext>;

/**
 * Contexto do usuário + seleção persistida SÓ na URL (`project`, `ns`). Trocar de projeto empurra
 * uma entrada no histórico, então voltar no browser volta ao projeto anterior. Sem storage local.
 */
export function useProjectScope(load: Loader = getScopeContext): ProjectScope {
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<ScopeLoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    load(controller.signal)
      .then(context => setState({ status: 'loaded', context }))
      .catch((error: unknown) => {
        if (error instanceof ScopeRequestError && error.aborted) return;
        const failure = error instanceof ScopeRequestError ? error : new ScopeRequestError(0, error instanceof Error ? error.message : 'unknown error');
        setState({ status: 'error', error: failure });
      });
    return () => controller.abort();
  }, [load, attempt]);

  const url = useMemo(() => readUrlScope(searchParams), [searchParams]);
  const selection = state.status === 'loaded' ? resolveSelection(state.context, url) : null;

  const select = useCallback((project: string, namespace?: string) => {
    setSearchParams(current => writeUrlScope(current, { project, namespace }));
  }, [setSearchParams]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);

  return { state, selection, select, retry };
}
