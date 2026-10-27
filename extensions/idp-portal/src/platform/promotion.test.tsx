// @vitest-environment jsdom
/*
 * environments-promotion: o plano de promoção é determinístico, o alvo vem do registry (projeto dono
 * -> promotesTo) e o botão só aparece quando existe alvo e a instância é promovível. O modal mostra o
 * manifest exato e grava o pedido no projeto ALVO com `promotedFrom`.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceDetail } from './kdpInventoryApi';
import type { ProvisionRequestInput } from './platformApi';
import { project } from './scope/scopeFixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getInstance = vi.fn<(...args: unknown[]) => Promise<InstanceDetail>>();
vi.mock('./kdpInventoryApi', async () => {
  const actual = await vi.importActual<typeof import('./kdpInventoryApi')>('./kdpInventoryApi');
  return { ...actual, getInstance: (...args: unknown[]) => getInstance(...args) };
});
const createProvisionRequest = vi.fn<(input: ProvisionRequestInput) => Promise<{ requestId: string; status: string; path: string }>>();
vi.mock('./platformApi', async () => {
  const actual = await vi.importActual<typeof import('./platformApi')>('./platformApi');
  return { ...actual, createProvisionRequest: (input: ProvisionRequestInput) => createProvisionRequest(input) };
});

const { buildPromotionPlan, isPromotable, promotedNameFor, rewriteIdentity, ENVIRONMENT_LABEL, PROMOTED_FROM_KEY } = await import('./promotion');
const { promotionTargetFor, setActiveScope } = await import('./scope/activeScope');
const { LiveResourceDetailView } = await import('./LiveResourceDetailPage');
const { I18nProvider } = await import('./i18n');

const lab = project({ id: 'agent-platform', name: 'Agent Platform', namespaces: ['appmod'], promotesTo: 'agent-platform-staging' });
const staging = project({
  id: 'agent-platform-staging', name: 'Agent Platform (Staging)', namespaces: ['appmod-staging'],
  environment: { id: 'staging', name: 'Staging', cluster: 'appmod-agent-platform-lab', region: 'sa-east-1', promotesTo: null },
});

const detail = (patch: Partial<InstanceDetail> = {}): InstanceDetail => ({
  capability: 'frontend/static-site', engine: 'kro', owner: 'platform-team', kind: 'StaticSite', apiVersion: 'kro.run/v1alpha1',
  scorecard: null, composition: null, children: null, revision: null,
  spec: { name: 'hello-site', indexDocument: 'index.html', tags: [{ key: 'env', value: 'lab' }] },
  metadata: {
    name: 'hello-site', namespace: 'appmod', uid: 'u', resourceVersion: '1', created: null,
    labels: { 'platform.appmod/owner': 'platform-team', 'platform.appmod/project': 'agent-platform', 'kro.run/instance-id': 'u', 'app.kubernetes.io/instance': 'x' },
    annotations: { 'argocd.argoproj.io/tracking-id': 'x' }, finalizers: [], deleting: false,
  },
  ready: true, readyBasis: 'CONDITION_TRUE', readyCondition: 'Ready', readyReason: '', generation: 1, observedGeneration: 1,
  statusStale: false, state: 'ACTIVE', conditions: [], outputs: {}, freshness: { label: 'fresh', ageSeconds: 1, basis: 'x' } as never,
  trail: {
    request: { requestId: null, requester: null }, mergeRequest: null,
    argo: { application: 'a', sync: 'Synced', health: 'Healthy', revision: 'r', readable: true, trackedBy: 'a', tracked: true },
    resource: { apiVersion: 'kro.run/v1alpha1', kind: 'StaticSite', namespace: 'appmod', name: 'hello-site', uid: 'u', resourceVersion: '1', capability: 'frontend/static-site' },
  } as never,
  actions: { day2Enforcement: 'x', callerIsAdmin: false, writePathForThisObject: 'git-merge-request' },
  partial: false, sources: [], readAt: 1, ...patch,
});

describe('promotionTargetFor', () => {
  it('resolves the promotesTo project of the owning project with its single namespace', () => {
    setActiveScope({ project: 'agent-platform', owners: { appmod: 'agent-platform', 'appmod-staging': 'agent-platform-staging' }, projects: [lab, staging] });
    const target = promotionTargetFor('appmod');
    expect(target?.project.id).toBe('agent-platform-staging');
    expect(target?.namespace).toBe('appmod-staging');
    expect(target?.source.id).toBe('agent-platform');
    expect(promotionTargetFor('appmod-staging')).toBeNull();        // terminal
    expect(promotionTargetFor('unknown')).toBeNull();
  });

  it('returns null when the target is not visible, not active or has several namespaces', () => {
    setActiveScope({ project: null, owners: { appmod: 'agent-platform' }, projects: [lab] });
    expect(promotionTargetFor('appmod')).toBeNull();
    setActiveScope({ project: null, owners: { appmod: 'agent-platform' }, projects: [lab, { ...staging, lifecycle: { state: 'read-only' } }] });
    expect(promotionTargetFor('appmod')).toBeNull();
    setActiveScope({ project: null, owners: { appmod: 'agent-platform' }, projects: [lab, { ...staging, namespaces: ['a', 'b'] }] });
    expect(promotionTargetFor('appmod')).toBeNull();
  });
});

describe('provisionRequestPath', () => {
  it('a promotion request is scoped to the TARGET namespace owner, not the active project', async () => {
    const { provisionRequestPath } = await vi.importActual<typeof import('./platformApi')>('./platformApi');
    setActiveScope({ project: 'agent-platform', owners: { appmod: 'agent-platform', 'appmod-staging': 'agent-platform-staging' }, projects: [lab, staging] });
    expect(provisionRequestPath({ namespace: 'appmod-staging', promotedFrom: 'agent-platform/appmod/hello-site' })).toContain('project=agent-platform-staging');
    // Pedido comum continua no projeto ativo (comportamento anterior).
    expect(provisionRequestPath({ namespace: 'appmod-staging' })).toContain('project=agent-platform');
    expect(provisionRequestPath({ namespace: 'appmod-staging' })).not.toContain('agent-platform-staging');
  });
});

describe('buildPromotionPlan', () => {
  const target = { project: staging, namespace: 'appmod-staging', source: lab };

  it('copies apiVersion, kind and spec, renames with the environment suffix and rewrites the labels', () => {
    const plan = buildPromotionPlan(detail(), target);
    expect(plan.name).toBe('hello-site-staging');
    expect(plan.namespace).toBe('appmod-staging');
    expect(plan.promotedFrom).toBe('agent-platform/appmod/hello-site');
    const doc = parse(plan.manifest) as Record<string, never>;
    expect(doc.apiVersion).toBe('kro.run/v1alpha1');
    expect(doc.kind).toBe('StaticSite');
    expect(doc.metadata).toEqual({
      name: 'hello-site-staging', namespace: 'appmod-staging',
      labels: { 'platform.appmod/owner': 'platform-team', 'platform.appmod/project': 'agent-platform', [ENVIRONMENT_LABEL]: 'staging', [PROMOTED_FROM_KEY]: 'hello-site' },
      annotations: { [PROMOTED_FROM_KEY]: 'agent-platform/appmod/hello-site' },
    });
    // spec.name embute o nome da instância: ganha o sufixo (identidade global na mesma conta); o resto fica.
    expect(doc.spec).toEqual({ name: 'hello-site-staging', indexDocument: 'index.html', tags: [{ key: 'env', value: 'lab' }] });
    expect(plan.manifest).not.toContain('kro.run/instance-id');
    expect(plan.manifest).not.toContain('argocd');
  });

  it('keeps the name when the target applies a different GitOps directory, and the plan is deterministic', () => {
    const other = { ...target, project: { ...staging, gitopsPath: 'platform/instances-staging' } };
    expect(buildPromotionPlan(detail(), other).name).toBe('hello-site');
    expect(buildPromotionPlan(detail(), target).manifest).toBe(buildPromotionPlan(detail(), target).manifest);
  });

  it('rewrites the instance name embedded in global identities of the spec, only within the same directory', () => {
    const d = detail({ spec: { name: 'appmod-hello-site-111122223333', environment: 'lab', note: 'hello-sites are nice', list: ['hello-site', 'x-hello-site.y'] } });
    const plan = buildPromotionPlan(d, target);
    const doc = parse(plan.manifest) as { spec: Record<string, unknown> };
    expect(doc.spec.name).toBe('appmod-hello-site-staging-111122223333');
    expect(doc.spec.note).toBe('hello-sites are nice');           // palavra parcial não é identidade
    expect(doc.spec.list).toEqual(['hello-site-staging', 'x-hello-site-staging.y']);
    expect(doc.spec.environment).toBe('staging');                  // campo de ambiente leva o ambiente ALVO
    expect(plan.rewrites.map((r) => r.path)).toEqual(['spec.name', 'spec.list[0]', 'spec.list[1]', 'spec.environment']);
    const other = { ...target, project: { ...staging, gitopsPath: 'platform/instances-staging' } };
    // Diretório distinto: nome e identidades ficam; só o ambiente muda.
    expect(buildPromotionPlan(d, other).rewrites).toEqual([{ path: 'spec.environment', from: 'lab', to: 'staging' }]);
    expect(rewriteIdentity({ a: 1, b: true, c: null }, 'x', 'y').rewrites).toEqual([]);
  });

  it('promotedNameFor stays a DNS label and never doubles the suffix', () => {
    expect(promotedNameFor('a'.repeat(63), 'staging', true)).toHaveLength(63);
    expect(promotedNameFor('a'.repeat(63), 'staging', true).endsWith('-staging')).toBe(true);
    expect(promotedNameFor('hello-staging', 'staging', true)).toBe('hello-staging');
    expect(promotedNameFor('hello', 'staging', false)).toBe('hello');
  });

  it('isPromotable: kro with spec, not deleting, not ephemeral', () => {
    expect(isPromotable(detail())).toBe(true);
    expect(isPromotable(detail({ engine: 'ack' }))).toBe(false);
    expect(isPromotable(detail({ spec: null }))).toBe(false);
    expect(isPromotable(detail({ spec: { lifecycle: 'ephemeral' } }))).toBe(false);
    expect(isPromotable(detail({ metadata: { ...detail().metadata, deleting: true } }))).toBe(false);
  });
});

describe('detail page: Promote button and modal', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { getInstance.mockReset(); createProvisionRequest.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const render = async () => {
    await act(async () => {
      root.render(<I18nProvider><LiveResourceDetailView capability="frontend/static-site" namespace="appmod" name="hello-site" kind="StaticSite" onBack={() => undefined} /></I18nProvider>);
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  };

  it('shows "Promover para Staging" only when the owning project has a target, and submits to the target project', async () => {
    setActiveScope({ project: 'agent-platform', owners: { appmod: 'agent-platform', 'appmod-staging': 'agent-platform-staging' }, projects: [lab, staging] });
    getInstance.mockResolvedValue(detail());
    createProvisionRequest.mockResolvedValue({ requestId: 'f'.repeat(32), status: 'pending', path: 'platform/instances/hello-site-staging.yaml' });
    await render();
    const button = host.querySelector('[data-testid="promote-button"]') as HTMLButtonElement | null;
    expect(button?.textContent).toContain('Promover para Staging');
    await act(async () => { button!.click(); });
    const modalText = document.body.textContent ?? '';
    expect(modalText).toContain('appmod-staging/hello-site-staging');
    expect(modalText).toContain('se chama hello-site-staging');
    expect(modalText).toContain('Identidade global reescrita');
    expect(modalText).toContain('spec.name: hello-site → hello-site-staging');
    const submit = document.body.querySelector('[data-testid="promotion-submit"]') as HTMLButtonElement;
    await act(async () => { submit.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(createProvisionRequest).toHaveBeenCalledTimes(1);
    const input = createProvisionRequest.mock.calls[0][0];
    expect(input).toMatchObject({ kind: 'infra', name: 'hello-site-staging', namespace: 'appmod-staging', promotedFrom: 'agent-platform/appmod/hello-site', capability: 'frontend/static-site' });
    expect((parse(input.manifest) as { metadata: { namespace: string } }).metadata.namespace).toBe('appmod-staging');
    expect(document.body.textContent).toContain('Pedido registrado');
    expect(document.body.querySelector('a[href*="ffffffff"]')).not.toBeNull();
  });

  it('hides the button for a terminal project and for an ACK object', async () => {
    setActiveScope({ project: 'agent-platform-staging', owners: { 'appmod-staging': 'agent-platform-staging' }, projects: [lab, staging] });
    getInstance.mockResolvedValue(detail({ metadata: { ...detail().metadata, namespace: 'appmod-staging' } }));
    await render();
    expect(host.querySelector('[data-testid="promote-button"]')).toBeNull();
    setActiveScope({ project: 'agent-platform', owners: { appmod: 'agent-platform' }, projects: [lab, staging] });
    getInstance.mockResolvedValue(detail({ engine: 'ack', spec: null }));
    await render();
    expect(host.querySelector('[data-testid="promote-button"]')).toBeNull();
  });
});
