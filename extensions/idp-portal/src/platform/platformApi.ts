// Client for the platform-api (live inventory, admin, onboarding). Authentication via the auth adapter.
// Provisioning requests carry the active project scope (issue #10); the server decides it again.
import { scopedPath } from './scope/activeScope';
import { apiFetch } from './auth/authAdapter';
import { GIT_WEB_BASE } from './deployment';

/** HTTP failure with its status, so a caller can tell a server refusal (4xx) from an outage (5xx). */
export class PlatformApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch('platform', path, init);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${response.status}`;
    throw new PlatformApiError(response.status, message);
  }
  return body as T;
}

export interface PlatformMe { alias: string; isAdmin: boolean; viewerGroup: string }
export interface PlatformResource {
  arn: string; service: string; name: string; environment: string; capability: string; retained: boolean;
  /** Only on collapsed ECS task definitions: how many revisions of the family the API returned. */
  revisions?: number;
}
export interface OnboardResult { alias: string; userId: string; userCreated: boolean; addedToViewers: boolean }
export interface PlatformResourceList { resources: PlatformResource[]; count: number; tagFilter: string; truncated?: boolean }

export function getPlatformMe(): Promise<PlatformMe> {
  return request<PlatformMe>('/platform/me');
}

// ------------------------------------------------------------ eventos (audit-log) e notificações

/** Vocabulário fechado do servidor (backend/platform_events). */
export type EventAction =
  | 'provision.requested' | 'provision.mr-opened' | 'provision.merged' | 'provision.failed' | 'provision.closed'
  | 'plan.submitted' | 'plan.retried' | 'plan.compensated' | 'plan.failed'
  | 'workload.restarted' | 'workload.scaled' | 'pod.deleted' | 'layout.reset';
export type EventResult = 'ok' | 'failed' | 'denied';

export interface PlatformEvent {
  id: string;
  /** Epoch em segundos. */
  time: number;
  actor: string;
  action: EventAction | string;
  kind: string;
  name: string;
  namespace: string;
  project: string;
  result: EventResult;
  detail: string;
  /** Caminho interno do portal (`/agent-platform/#...`), ou vazio. */
  link: string;
  source: string;
}

export interface PlatformEventList { items: PlatformEvent[]; count: number; scope: 'all' | 'mine'; readAt: number }
export interface Notification extends PlatformEvent { read: boolean }
export interface NotificationBox { items: Notification[]; unread: number; readAt: number }

export interface EventFilters { actor?: string; action?: string; result?: string; object?: string; limit?: number }

export function listEvents(filters: EventFilters = {}): Promise<PlatformEventList> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value));
  const query = params.toString();
  return request<PlatformEventList>(`/platform/events${query ? `?${query}` : ''}`);
}

/** Trilha de UM objeto: `kind/namespace/name`. */
export function objectTrail(kind: string, namespace: string, name: string, limit = 50): Promise<PlatformEventList> {
  return listEvents({ object: `${kind}/${namespace}/${name}`, limit });
}

export function getNotifications(): Promise<NotificationBox> {
  return request<NotificationBox>('/platform/notifications');
}

/** Marca d'água (`until`, epoch s) e/ou um evento (`eventId`). */
export function markNotificationsRead(input: { until?: number; eventId?: string }): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/platform/notifications/read', { method: 'POST', body: JSON.stringify(input) });
}

const TASK_DEFINITION = /:task-definition\/([^:]+):(\d+)$/;

/**
 * Each ECS TaskDefinition revision is its own tagged ARN, so a reconcile loop (the GP-B ECS
 * ackGap registered ~1.300 revisions) floods every inventory view. Keep the latest revision
 * per family and carry the count; everything else passes through untouched.
 */
export function collapseTaskDefinitionRevisions(resources: PlatformResource[]): PlatformResource[] {
  const latest = new Map<string, { resource: PlatformResource; revision: number; count: number }>();
  const out: PlatformResource[] = [];
  for (const resource of resources) {
    const match = TASK_DEFINITION.exec(resource.arn);
    if (!match) { out.push(resource); continue; }
    const [, family, rev] = match;
    const revision = Number(rev);
    const seen = latest.get(family);
    if (!seen) latest.set(family, { resource, revision, count: 1 });
    else {
      seen.count += 1;
      if (revision > seen.revision) { seen.resource = resource; seen.revision = revision; }
    }
  }
  for (const { resource, count } of latest.values()) out.push({ ...resource, revisions: count });
  return out.sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
}

export async function listPlatformResources(): Promise<PlatformResourceList> {
  const result = await request<PlatformResourceList>('/platform/resources');
  const resources = collapseTaskDefinitionRevisions(result.resources ?? []);
  return { ...result, resources, count: resources.length };
}

export function onboardUser(alias: string, givenName: string, familyName: string): Promise<OnboardResult> {
  return request<OnboardResult>('/platform/onboard', { method: 'POST', body: JSON.stringify({ alias, givenName, familyName }) });
}

/*
 * Provisioning requests. The portal cannot open a GitLab MR itself: github.com sits
 * behind the corporate SSO and nothing in AWS has a the corporate SSO session. So the portal records the request
 * and the GitLab CI (which does reach the API) opens the MR, either right away when the user
 * clicks the prefilled Run pipeline link, or on the next scheduled sweep.
 */
// merged e closed vêm da reconciliação do sweep (scripts/open_provision_mrs.py, reconcile).
export type ProvisionStatus = 'pending' | 'processing' | 'mr_open' | 'merged' | 'closed' | 'failed';
export interface ProvisionRequest {
  requestId: string; status: ProvisionStatus; path: string;
  kind?: string; name?: string; mrUrl?: string; error?: string; createdAt?: number;
}
export interface ProvisionRequestInput {
  kind: 'infra' | 'agent'; name: string; capability: string; manifest: string; namespace?: string;
  /** `project/namespace/name` da instância de origem (environments-promotion); o servidor valida a cadeia. */
  promotedFrom?: string;
}

/**
 * With a project in the request, the server checks that `namespace` belongs to it and records both;
 * the CI then refuses a manifest whose metadata.namespace differs. Without one (compat), the old
 * contract holds and `namespace` is not sent, so nothing changes for a request that had no scope.
 */
export function provisionRequestPath(input: Pick<ProvisionRequestInput, 'namespace' | 'promotedFrom'>): string {
  // Promoção (environments-promotion): o pedido vai para o projeto DONO do namespace alvo, não para o
  // projeto ativo na URL. `fixed` faz o namespace vencer; sem ele o escopo ativo (origem) venceria e o
  // servidor recusaria com "namespace is outside the project scope" (medido live em 26/10/2026).
  return scopedPath('/platform/provision-requests', { namespace: input.namespace, fixed: Boolean(input.promotedFrom) });
}

export function createProvisionRequest(input: ProvisionRequestInput): Promise<ProvisionRequest> {
  const { namespace, ...rest } = input;
  const path = provisionRequestPath(input);
  const body = path.includes('project=') && namespace ? { ...rest, namespace } : rest;
  return request<ProvisionRequest>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function getProvisionRequest(requestId: string): Promise<ProvisionRequest> {
  return request<ProvisionRequest>(`/platform/provision-requests/${encodeURIComponent(requestId)}`);
}

/** Tour dos primeiros passos: o servidor gera o manifest; um tour vivo por alias (existing). */
export function createTourRequest(): Promise<ProvisionRequest & { existing?: boolean }> {
  // O servidor gera o manifest do tour no namespace appmod: o escopo pedido é o dono dele.
  return request(scopedPath('/platform/provision-requests', { namespace: 'appmod', fixed: true }), { method: 'POST', body: JSON.stringify({ tour: true }) });
}

export interface PublishResult { published: boolean; written: string[]; alreadyPublished: string[] }
export function publishTour(requestId: string): Promise<PublishResult> {
  if (!/^[0-9a-f]{32}$/.test(requestId)) throw new Error('invalid provision request id');
  return request<PublishResult>(`/platform/provision-requests/${requestId}/publish`, { method: 'POST' });
}

const GITLAB_PROJECT_URL = GIT_WEB_BASE;

/** GitLab's "Run pipeline" page with the request id prefilled; the user only clicks Run. */
export function openMrNowUrl(requestId: string): string {
  if (!/^[0-9a-f]{32}$/.test(requestId)) throw new Error('invalid provision request id');
  return `${GITLAB_PROJECT_URL}/-/pipelines/new?ref=main&var[PROVISION_REQUEST_ID]=${requestId}`;
}

/** Terminal statuses stop the portal from polling. */
export function isSettled(status: ProvisionStatus): boolean {
  return status !== 'pending' && status !== 'processing';
}
