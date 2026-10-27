// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { ChildrenTable, RevisionsTable, RolloutTable, rolloutIndicator, rolloutText } from './CompositionRevisionParts';
import type { ChildResource, CompositionRevisions, InstanceRollout } from './kdpInventoryApi';

class ResizeObserverStub { observe(): void { /* jsdom */ } unobserve(): void { /* noop */ } disconnect(): void { /* noop */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Renderiza num host próprio e devolve o texto; sem testing-library, como o resto da suíte. */
async function textOf(element: JSX.Element): Promise<string> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(element); });
  const text = host.textContent ?? '';
  await act(async () => { root.unmount(); });
  host.remove();
  return text;
}
const count = (text: string, needle: string) => text.split(needle).length - 1;

const revisions: CompositionRevisions = {
  items: [
    { revision: 3, generation: 5, ready: false, hash: 'h3', created: '2026-10-25T00:00:00Z', resources: 4 },
    { revision: 2, generation: 4, ready: true, hash: 'h2', created: '2026-10-20T00:00:00Z', resources: 4 },
  ],
  latest: { revision: 2, generation: 4, ready: true, hash: 'h2', created: '2026-10-20T00:00:00Z', resources: 4 },
  pending: { revision: 3, generation: 5, ready: false, hash: 'h3', created: '2026-10-25T00:00:00Z', resources: 4 },
  lastIssued: 3, error: '',
};

describe('rollout indicator and text', () => {
  it('quatro estados, texto distinto cada um, nunca erro para o não medido', () => {
    expect(rolloutIndicator('current', true)).toEqual({ type: 'success', text: 'Na revisão atual' });
    expect(rolloutIndicator('behind', false)).toEqual({ type: 'warning', text: 'Behind the definition' });
    expect(rolloutIndicator('unknown', true)).toEqual({ type: 'pending', text: 'Revisão não medida' });
    expect(rolloutIndicator('no-children', false)).toEqual({ type: 'stopped', text: 'No child resources' });
  });

  it('texto conta filhos na revisão e os sem hash', () => {
    expect(rolloutText({ status: 'behind', children: 3, withHash: 2, onLatest: 1, latestRevision: 4 }, true))
      .toBe('1 de 3 filho(s) na revisão 4; 1 sem hash de revisão');
    expect(rolloutText({ status: 'no-children', children: 0, withHash: 0, onLatest: 0, latestRevision: null }, false)).toBe('no children listed');
  });
});

describe('tables', () => {
  it('RevisionsTable marca a ativa, mostra pendente como pendente, e explica a lista vazia', async () => {
    const text = await textOf(<RevisionsTable revisions={revisions} pt />);
    expect(text).toContain('(ativa)');
    expect(text).toContain('pendente');
    expect(text).toContain('pronta');
    expect(await textOf(<RevisionsTable revisions={{ items: [], latest: null, pending: null, lastIssued: null, error: '' }} pt={false} />)).toContain('No GraphRevision for this definition');
    expect(await textOf(<RevisionsTable revisions={{ items: [], latest: null, pending: null, lastIssued: null, error: 'http_403' }} pt />)).toContain('Revisões não lidas (http_403).');
  });

  it('RolloutTable lista cada instância com o estado e o resumo dos filhos', async () => {
    const rollout: InstanceRollout[] = [
      { name: 'a', namespace: 'ns', rollout: { status: 'current', children: 2, withHash: 2, onLatest: 2, latestRevision: 2 } },
      { name: 'b', namespace: 'ns', rollout: { status: 'unknown', children: 1, withHash: 0, onLatest: 0, latestRevision: 2 } },
    ];
    const text = await textOf(<RolloutTable rollout={rollout} pt={false} />);
    expect(text).toContain('On current revision');
    expect(text).toContain('Revision not measured');
    expect(text).toContain('0 of 1 child(ren) on revision 2; 1 without a revision hash');
  });

  it('ChildrenTable mostra política de deleção e a comparação de revisão em três estados', async () => {
    const base = { apiVersion: 's3.services.k8s.aws/v1alpha1', namespace: 'ns', ready: true, readyBasis: 'READY_CONDITION_CURRENT' as ChildResource['readyBasis'], created: null };
    const children: ChildResource[] = [
      { ...base, node: 'bucket', kind: 'Bucket', name: 'b1', deletionPolicy: 'retain', revisionHash: 'h2', onLatest: true },
      { ...base, node: 'policy', kind: 'BucketPolicy', name: 'p1', deletionPolicy: null, revisionHash: 'h1', onLatest: false },
      { ...base, node: 'dist', kind: 'Distribution', name: 'd1', deletionPolicy: null, revisionHash: null, onLatest: null },
    ];
    const text = await textOf(<ChildrenTable children={children} pt />);
    expect(text).toContain('retain');
    expect(count(text, 'não declarada')).toBe(2);
    expect(text).toContain('atual');
    expect(text).toContain('antiga');
    expect(text).toContain('sem hash');
  });
});
