// Client do Agent Builder: BFF (5.1), platform-api (5.2 a 5.5) e cluster-api (5.6 a 5.9) de
// docs/agent-platform/design-agent-builder.md. SigV4 via the internal gateway, como os outros clients.
//
// Este módulo nunca envia `tools`, `tool_choice`, `functions`, `manifest` nem `requester`: o modelo
// não recebe tool, o manifest é do compiler e o requester vem da sessão (invariantes I1, I2 e I8).
import toolCatalogRaw from '../../platform/agent-builder/tool-catalog.json?raw';
import type { AgentOp, ConditionStatus, ProvisionStatus } from './agentBuilderPhase';
import { scopedPath } from './scope/activeScope';
import { apiFetch, authAdapter, setAuthAdapter } from './auth/authAdapter';
import { ENDPOINTS, endpointForUrl } from './auth/endpoints';

// Endpoints do auth adapter (auth/endpoints.ts); as constantes seguem exportadas para quem as importa.
export const BFF_URL = ENDPOINTS.bff.url;
export const PLATFORM_API = ENDPOINTS.platform.url;
export const CLUSTER_API = ENDPOINTS.cluster.url;

/** Erro de API com o status HTTP preservado: a UI escolhe a mensagem e a ação pelo status. */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body: unknown = null) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Só para testes: esquece os registros feitos pelo adapter (volta ao adapter default). */
export function resetRegistrationForTests(): void {
  setAuthAdapter(null);
}

// Todo agent vive no namespace kagent (ADR-0008): o escopo pedido é o projeto DONO dele (issue #10),
// tanto na leitura da cluster-api quanto no pedido kagent-agent. O servidor confere de novo.
export const AGENT_NAMESPACE = 'kagent';
function builderScoped(base: string, path: string, init?: RequestInit): string {
  const writesRequest = base === PLATFORM_API && init?.method === 'POST' && path === '/platform/provision-requests';
  return base === CLUSTER_API || writesRequest ? scopedPath(path, { namespace: AGENT_NAMESPACE, fixed: true }) : path;
}

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const endpoint = endpointForUrl(base);
  if (!endpoint) throw new ApiError(0, `unknown endpoint ${base}`);
  if (!authAdapter().available()) throw new ApiError(0, 'harmony unavailable');
  let response: Response;
  try {
    response = await apiFetch(endpoint, builderScoped(base, path, init), init);
  } catch (cause) {
    throw new ApiError(0, cause instanceof Error && cause.message ? cause.message : 'network error');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${response.status}`;
    throw new ApiError(response.status, message, body);
  }
  return body as T;
}

const json = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });

// ---------------------------------------------------------------- tipos do contrato

export type AgentLanguage = 'pt-BR' | 'en-US' | 'es';
export interface AgentSkill { id: string; name: string; description: string; examples: string[] }
export interface AgentDraft {
  schemaVersion: 'agent-draft/v1';
  name: string;
  displayName: string;
  description: string;
  language: AgentLanguage;
  instructions: string[];
  tools: string[];
  skills: AgentSkill[];
}
export interface DraftIssue { path: string; code: string; message: string; messagePt?: string }
export interface DraftValidation { valid: boolean; errors: DraftIssue[]; warnings: DraftIssue[] }

export interface GenerateResult {
  /** O que o modelo devolveu. Pode ser inválido: os erros vêm em `validation`. */
  draft: AgentDraft;
  validation: DraftValidation;
  modelAlias: string;
  knowledgeBaseId: string;
  sources: string[];
}

export interface PreviewResult {
  valid: boolean;
  errors: DraftIssue[];
  warnings: DraftIssue[];
  manifest: string | null;
  path?: string;
  draftSha256?: string;
  compiler?: string;
  summary?: { name: string; namespace: string; modelConfig: string; language: string; tools: string[] };
}

export interface AgentProvisionRequest {
  requestId: string;
  status: ProvisionStatus;
  kind: string;
  op?: AgentOp;
  path?: string;
  name?: string;
  mrUrl?: string;
  error?: string;
  createdAt?: number;
  draftSha256?: string;
  mergedAt?: number | null;
}

export interface PlatformMeWithFeatures {
  alias: string; isAdmin: boolean;
  features?: { agentBuilder?: boolean; serviceStudio?: boolean; platformAssistant?: boolean; composableDashboard?: boolean };
}

export interface AgentCondition { status: ConditionStatus; reason?: string; message?: string }
export interface ArgoState { application: string; sync: string; health: string; revision: string }
export interface BuilderAgent {
  name: string;
  displayName: string;
  requester: string;
  requestId: string;
  createdAt: number;
  generation: number;
  observedGeneration: number;
  replicas: number | null;
  /** Pods não terminados do Deployment do agent; null quando a cluster-api não conseguiu ler. */
  podReplicas?: number | null;
  disabled: boolean;
  argoTracked: boolean;
  accepted: AgentCondition;
  ready: AgentCondition;
}
export interface AgentEvent { reason?: string; message?: string; type?: string; count?: number; last?: string }
export interface BuilderAgentDetail extends BuilderAgent { events?: AgentEvent[] }
export interface BuilderAgentList { namespace: string; argo: ArgoState; agents: BuilderAgent[] }

export interface A2ATask { taskId: string; contextId?: string; state: string }
export interface A2AResult { state: string; text?: string; hasText: boolean }

// ---------------------------------------------------------------- validação local de ids

export const AGENT_NAME = /^ab-[a-z0-9](?:[a-z0-9-]{0,35}[a-z0-9])?$/;
export const REQUEST_ID = /^[0-9a-f]{32}$/;
const TASK_ID = /^[A-Za-z0-9-]{1,64}$/;

function agentPath(name: string): string {
  if (!AGENT_NAME.test(name)) throw new ApiError(400, 'invalid agent name');
  return `/cluster/agents/${name}`;
}

// ---------------------------------------------------------------- BFF

export const PROMPT_MAX = 2000;

export async function generateAgentDraft(prompt: string, locale: 'pt-BR' | 'en-US', previousDraft: AgentDraft | null): Promise<GenerateResult> {
  if (!prompt.trim() || prompt.length > PROMPT_MAX) throw new ApiError(400, 'prompt must have 1 to 2000 characters');
  return call<GenerateResult>(BFF_URL, '/gateway/agent-drafts/generate', json({ prompt, locale, previousDraft }));
}

// ---------------------------------------------------------------- platform-api

export function getAgentBuilderMe(): Promise<PlatformMeWithFeatures> {
  return call<PlatformMeWithFeatures>(PLATFORM_API, '/platform/me');
}

export function previewAgentDraft(draft: AgentDraft): Promise<PreviewResult> {
  return call<PreviewResult>(PLATFORM_API, '/platform/agent-drafts/preview', json({ draft }));
}

export function requestAgentCreate(draft: AgentDraft): Promise<AgentProvisionRequest> {
  return call<AgentProvisionRequest>(PLATFORM_API, '/platform/provision-requests', json({ kind: 'kagent-agent', op: 'create', draft }));
}

export async function requestAgentDisable(name: string): Promise<AgentProvisionRequest> {
  if (!AGENT_NAME.test(name)) throw new ApiError(400, 'invalid agent name');
  return call<AgentProvisionRequest>(PLATFORM_API, '/platform/provision-requests', json({ kind: 'kagent-agent', op: 'disable', name }));
}

export async function getAgentRequest(requestId: string): Promise<AgentProvisionRequest> {
  if (!REQUEST_ID.test(requestId)) throw new ApiError(400, 'invalid provision request id');
  return call<AgentProvisionRequest>(PLATFORM_API, `/platform/provision-requests/${requestId}`);
}

// ---------------------------------------------------------------- cluster-api

export function listBuilderAgents(): Promise<BuilderAgentList> {
  return call<BuilderAgentList>(CLUSTER_API, '/cluster/agents');
}

/** `null` quando o agent ainda não existe no cluster (404): é estado normal antes do Argo aplicar. */
export async function getBuilderAgent(name: string): Promise<BuilderAgentDetail | null> {
  try {
    return await call<BuilderAgentDetail>(CLUSTER_API, agentPath(name));
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return null;
    throw cause;
  }
}

export async function startA2ATest(name: string, text?: string): Promise<A2ATask> {
  const trimmed = text?.trim();
  if (trimmed && trimmed.length > 500) throw new ApiError(400, 'text must have 1 to 500 characters');
  return call<A2ATask>(CLUSTER_API, `${agentPath(name)}/a2a-test`, json(trimmed ? { text: trimmed } : {}));
}

export async function getA2ATest(name: string, taskId: string): Promise<A2AResult> {
  if (!TASK_ID.test(taskId)) throw new ApiError(400, 'invalid task id');
  return call<A2AResult>(CLUSTER_API, `${agentPath(name)}/a2a-test/${taskId}`);
}

// ---------------------------------------------------------------- catálogo de tools

export interface CatalogTool { name: string; summary: string; summaryPt: string }
export interface ToolCatalog {
  catalogVersion: string;
  toolServer: { apiGroup: string; kind: string; name: string; namespace: string };
  fixed: { namespace: string; modelConfig: string; compiler: string; gitPath: string; mirrorPath: string };
  tools: CatalogTool[];
}

/** O mesmo arquivo que o compiler e o CI leem. Nenhuma cópia do enum mora no frontend. */
export const toolCatalog: ToolCatalog = JSON.parse(toolCatalogRaw) as ToolCatalog;
