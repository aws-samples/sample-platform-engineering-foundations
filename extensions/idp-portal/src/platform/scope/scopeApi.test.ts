import { afterEach, describe, expect, it, vi } from 'vitest';
import { getScopeContext, ScopeRequestError } from './scopeApi';

const ok = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe('getScopeContext', () => {
  it('reads the context from the platform API and normalises it', async () => {
    const fetchImpl = vi.fn((_input: string, _init?: RequestInit) => ok({ organization: { id: 'appmod-latam', name: 'AppMod LATAM' }, enforcement: 'compat',
      projects: [{ id: 'agent-platform', role: 'contributor', namespaces: ['appmod'], lifecycle: { state: 'active' } }] }));
    const context = await getScopeContext(undefined, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/\/platform\/scope$/);
    expect(context.projects.map(p => p.id)).toEqual(['agent-platform']);
  });

  it.each([[403, 'caller is not an authorized platform session'], [503, 'scope registry not found in this deployment']])(
    'keeps status %i as an error, never as an empty context', async (status, error) => {
      const failure = await getScopeContext(undefined, () => ok({ error, code: 'x' }, status)).catch(e => e);
      expect(failure).toBeInstanceOf(ScopeRequestError);
      expect(failure).toMatchObject({ status, message: error, code: 'x', aborted: false });
    });

  it('marks its own cancellation so the UI does not paint an error', async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const failure = await getScopeContext(controller.signal, () => Promise.reject(abort)).catch(e => e);
    expect(failure).toMatchObject({ status: 0, aborted: true });
  });

  it('reports a network failure with status 0', async () => {
    const failure = await getScopeContext(undefined, () => Promise.reject(new Error('Failed to fetch'))).catch(e => e);
    expect(failure).toMatchObject({ status: 0, message: 'Failed to fetch', aborted: false });
  });

  it('never writes the scope to browser storage', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem, getItem: () => null });
    vi.stubGlobal('sessionStorage', { setItem, getItem: () => null });
    await getScopeContext(undefined, () => ok({ projects: [] }));
    expect(setItem).not.toHaveBeenCalled();
  });
});
