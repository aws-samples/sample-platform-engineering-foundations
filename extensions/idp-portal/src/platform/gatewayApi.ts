import { apiFetch, authAdapter } from './auth/authAdapter';
import { HOSTING } from './deployment';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!authAdapter().available()) {
    throw new Error(`Sign in through ${HOSTING} to call the private gateway.`);
  }
  const response = await apiFetch('bff', path, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `BFF returned HTTP ${response.status}`);
  return body;
}

export interface GatewayHealth {
  status: 'healthy';
  modelAlias: string;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export function checkGatewayHealth(): Promise<GatewayHealth> {
  return request<GatewayHealth>('/gateway/health');
}

export async function chatWithGateway(message: string): Promise<string> {
  const result = await request<ChatResponse>('/gateway/chat', {
    method: 'POST',
    body: JSON.stringify({ message, maxTokens: 256 }),
  });
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error('The gateway returned no assistant message.');
  return content;
}

export interface GatewayConfig {
  modelAliases: string[];
  autoCheapest: boolean;
  cacheTtlSeconds: number;
  guardrails: { enabled: boolean; policies: string[] };
  budget: { configured: boolean };
}

export interface GatewayUsage {
  requests: number;
  windowDays: number;
  requestsAreComplete: boolean;
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: number;
  cacheHits: number;
  errors: number;
  latestAt: string;
}

export interface GatewayAuditRecord {
  timestamp: string;
  category: string;
  action: string;
  target: string;
  actorRole: string;
  changeCount: number;
}

export interface GatewayOperations {
  config: GatewayConfig;
  usage: GatewayUsage;
  audit: { records: GatewayAuditRecord[]; count: number; hasMore: boolean };
}

export async function loadGatewayOperations(): Promise<GatewayOperations> {
  const [config, usage, audit] = await Promise.all([
    request<GatewayConfig>('/gateway/config'),
    request<GatewayUsage>('/gateway/usage'),
    request<{ records: GatewayAuditRecord[]; count: number; hasMore: boolean }>('/gateway/audit'),
  ]);
  return { config, usage, audit };
}

export interface GeneratedArtifact {
  artifact: string;
  sources: string[];
  modelAlias: string;
  knowledgeBaseId: string;
}

export function generateArtifact(kind: 'infra' | 'agent', prompt: string, currentDocument: string): Promise<GeneratedArtifact> {
  return request<GeneratedArtifact>(`/gateway/generate/${kind}`, {
    method: 'POST',
    body: JSON.stringify({ prompt, currentDocument }),
  });
}
