import { describe, expect, it } from 'vitest';
import {
  asScopeContext, canPropose, needsSelector, readUrlScope, resolveSelection, roleAllows, scopeQuery, writeUrlScope,
} from './scopeModel';
import { context, project } from './scopeFixtures';

describe('URL scope', () => {
  it('reads project and ns and drops anything that is not a DNS label', () => {
    expect(readUrlScope('?project=team-a&ns=ns-a')).toEqual({ project: 'team-a', namespace: 'ns-a' });
    expect(readUrlScope('?project=../etc&ns=NS')).toEqual({});
    expect(readUrlScope('?project=a%3Cscript%3E')).toEqual({});
  });

  it('writes only project and ns, preserving the other params', () => {
    const next = writeUrlScope('?view=inventory&ns=old', { project: 'team-b', namespace: 'ns-b' });
    expect(next.toString()).toBe('view=inventory&ns=ns-b&project=team-b');
    expect(writeUrlScope(next, { project: 'team-a' }).get('ns')).toBeNull();
    expect(writeUrlScope(next, {}).toString()).toBe('view=inventory');
  });

  it('never carries a credential-looking value because only DNS labels survive', () => {
    expect(writeUrlScope('', { project: 'ASIAXXXXXXXX/secret' }).toString()).toBe('');
  });
});

describe('resolveSelection', () => {
  const a = project({ id: 'team-a' });
  const b = project({ id: 'team-b' });

  it('stays simple with a single project: implicit selection, no selector', () => {
    const ctx = context([a]);
    expect(resolveSelection(ctx, {})).toEqual({ status: 'ready', project: a, namespace: 'ns-team-a', implicit: true });
    expect(needsSelector(ctx)).toBe(false);
  });

  it('asks for a choice with several projects instead of inventing a default', () => {
    expect(resolveSelection(context([a, b]), {})).toEqual({ status: 'unselected' });
    expect(needsSelector(context([a, b]))).toBe(true);
  });

  it('reports an unknown or inaccessible project the same way', () => {
    expect(resolveSelection(context([a]), { project: 'team-b' })).toEqual({ status: 'not-found', requested: 'team-b' });
  });

  it('rejects a namespace from another project', () => {
    expect(resolveSelection(context([a, b]), { project: 'team-a', namespace: 'ns-team-b' }).status).toBe('namespace-out-of-scope');
  });

  it('is empty when the caller belongs to no project, and hides retired ones', () => {
    expect(resolveSelection(context([]), {})).toEqual({ status: 'empty' });
    expect(resolveSelection(context([project({ id: 'old', lifecycle: { state: 'retired' } })]), {})).toEqual({ status: 'empty' });
  });

  it('leaves the namespace open on a multi-namespace project', () => {
    const multi = project({ id: 'multi', namespaces: ['x', 'y'] });
    expect(resolveSelection(context([multi]), {})).toMatchObject({ status: 'ready', namespace: null });
    expect(needsSelector(context([multi]))).toBe(true);
  });
});

describe('scopeQuery and role hints', () => {
  it('builds the query the server validates, and nothing without a ready selection', () => {
    const a = project({ id: 'team-a' });
    expect(scopeQuery(resolveSelection(context([a]), {}))).toBe('project=team-a&ns=ns-team-a');
    expect(scopeQuery({ status: 'unselected' })).toBe('');
  });

  it('mirrors the server role ladder', () => {
    expect(roleAllows('viewer', 'read')).toBe(true);
    expect(roleAllows('viewer', 'propose')).toBe(false);
    expect(roleAllows('contributor', 'operate')).toBe(false);
    expect(canPropose(project({ id: 'p', lifecycle: { state: 'read-only' } }))).toBe(false);
  });
});

describe('asScopeContext', () => {
  it('drops malformed projects instead of filling gaps', () => {
    const parsed = asScopeContext({
      organization: { id: 'appmod-latam', name: 'AppMod LATAM' }, enforcement: 'compat',
      projects: [
        { id: 'ok', role: 'viewer', namespaces: ['ns'], lifecycle: { state: 'active' } },
        { id: 'no-role', namespaces: ['ns'], lifecycle: { state: 'active' } },
        { id: 'BAD', role: 'viewer', namespaces: ['ns'], lifecycle: { state: 'active' } },
        { id: 'no-ns', role: 'viewer', namespaces: [], lifecycle: { state: 'active' } },
      ],
    });
    expect(parsed.projects.map(p => p.id)).toEqual(['ok']);
  });

  it('defaults to strict and to no kubeconfig when the server says nothing', () => {
    const parsed = asScopeContext({});
    expect(parsed.enforcement).toBe('strict');
    expect(parsed.kubeconfig.offered).toBe(false);
    expect(parsed.projects).toEqual([]);
  });
});
