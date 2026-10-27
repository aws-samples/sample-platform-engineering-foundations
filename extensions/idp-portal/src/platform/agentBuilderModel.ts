// Regras puras do Agent Builder na UI: montagem do pedido ao modelo, diff do manifest, leitura de
// erros de validação e de API, e o alvo acompanhado. Nada aqui faz rede.
import {
  AGENT_NAME, AgentDraft, AgentLanguage, ApiError, BuilderAgent, DraftIssue, PROMPT_MAX, REQUEST_ID, toolCatalog,
} from './agentBuilderApi';
import type { AgentOp, PhaseAgent } from './agentBuilderPhase';
import { HOSTING, IDENTITY_PROVIDER } from './deployment';

// ---------------------------------------------------------------- pedido ao modelo

export interface DraftContext {
  language: AgentLanguage;
  /** Namespace onde o agent deve focar. Só vira dica no texto: o draft não tem campo de namespace. */
  namespaceFocus: string;
  /** Tools que o usuário quer. Também só dica: o validador decide o que entra. */
  preferredTools: string[];
}

export const K8S_NAMESPACE = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

const LANGUAGE_NAME: Record<AgentLanguage, [string, string]> = {
  'pt-BR': ['português do Brasil', 'Brazilian Portuguese'],
  'en-US': ['inglês', 'English'],
  es: ['espanhol', 'Spanish'],
};

export function languageLabel(language: AgentLanguage, pt: boolean): string {
  return LANGUAGE_NAME[language][pt ? 0 : 1];
}

/** `locale` do 5.1: define o idioma sugerido ao modelo. Espanhol vai pelo texto do pedido. */
export function generateLocale(language: AgentLanguage): 'pt-BR' | 'en-US' {
  return language === 'en-US' ? 'en-US' : 'pt-BR';
}

export function orderByCatalog(tools: readonly string[]): string[] {
  const order = toolCatalog.tools.map(t => t.name);
  return [...new Set(tools)].filter(t => order.includes(t)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/**
 * Texto enviado ao BFF. O contexto entra como linhas legíveis, em inglês, porque o prompt de sistema
 * do BFF é em inglês. A descrição do usuário vai intacta.
 */
export function composeGeneratePrompt(description: string, context: DraftContext, refinement = ''): string {
  const lines = [description.trim(), '', 'Context chosen in the portal:'];
  lines.push(`- The agent answers in ${LANGUAGE_NAME[context.language][1]} (language: ${context.language}).`);
  if (context.namespaceFocus.trim()) lines.push(`- Focus namespace: ${context.namespaceFocus.trim()}. Ask for another namespace only when the user names one.`);
  const tools = orderByCatalog(context.preferredTools);
  lines.push(tools.length
    ? `- Preferred read-only tools: ${tools.join(', ')}. Use only these.`
    : '- No tools: the agent answers only from the conversation.');
  if (refinement.trim()) lines.push('', `Change requested on the previous draft: ${refinement.trim()}`);
  return lines.join('\n');
}

export function promptTooLong(prompt: string): boolean {
  return prompt.length > PROMPT_MAX;
}

export const DESCRIPTION_EXAMPLES: { pt: string; en: string }[] = [
  { pt: 'Crie um agent que mostre os pods fora de Running em um namespace e explique a causa provável de cada um.', en: 'Create an agent that lists pods that are not Running in a namespace and explains the likely cause of each.' },
  { pt: 'Crie um agent que resuma os eventos de Warning da última hora e agrupe por recurso afetado.', en: 'Create an agent that summarizes the Warning events of the last hour, grouped by affected resource.' },
  { pt: 'Crie um agent que explique um Deployment: réplicas, imagem, probes e os eventos recentes.', en: 'Create an agent that explains a Deployment: replicas, image, probes and recent events.' },
];

// ---------------------------------------------------------------- draft

/** Serialização com chaves ordenadas: decide se um preview ainda corresponde ao draft em tela. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type DraftParse = { ok: true; draft: AgentDraft } | { ok: false; error: string };

/** Lê o JSON editado à mão. Só exige um objeto: o resto é trabalho do validador do servidor. */
export function parseDraftJson(text: string, pt: boolean): DraftParse {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: pt ? 'O rascunho precisa ser um objeto JSON ({ ... }).' : 'The draft must be a JSON object ({ ... }).' };
    }
    return { ok: true, draft: value as AgentDraft };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : '';
    return { ok: false, error: pt ? `JSON inválido: ${detail}. Confira vírgulas e aspas.` : `Invalid JSON: ${detail}. Check commas and quotes.` };
  }
}

export function draftList(draft: Partial<AgentDraft> | null, key: 'instructions' | 'tools'): string[] {
  const value = draft?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function draftSkills(draft: Partial<AgentDraft> | null): AgentDraft['skills'] {
  return Array.isArray(draft?.skills) ? draft.skills.filter(s => s && typeof s === 'object') : [];
}

export function withTools(draft: AgentDraft, tools: string[]): AgentDraft {
  return { ...draft, tools: orderByCatalog(tools) };
}

export function sameTools(a: readonly string[], b: readonly string[]): boolean {
  const x = orderByCatalog(a);
  const y = orderByCatalog(b);
  return x.length === y.length && x.every((tool, index) => tool === y[index]);
}

// ---------------------------------------------------------------- erros de validação

const FIELD_LABELS: Record<string, [string, string]> = {
  schemaVersion: ['Versão do schema', 'Schema version'],
  name: ['Nome técnico', 'Technical name'],
  displayName: ['Nome de exibição', 'Display name'],
  description: ['Descrição', 'Description'],
  language: ['Idioma', 'Language'],
  instructions: ['Instruções', 'Instructions'],
  tools: ['Tools', 'Tools'],
  skills: ['Skills', 'Skills'],
};
const SKILL_FIELDS: Record<string, [string, string]> = {
  id: ['id', 'id'], name: ['nome', 'name'], description: ['descrição', 'description'], examples: ['exemplos', 'examples'],
};

/** JSON Pointer em português claro: `/skills/0/examples/1` vira "Skill 1, exemplo 2". */
export function fieldLabel(path: string, pt: boolean): string {
  const parts = path.split('/').slice(1).map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!parts.length || parts[0] === '') return pt ? 'Rascunho inteiro' : 'Whole draft';
  const [head, index, sub, subIndex] = parts;
  const known = FIELD_LABELS[head];
  if (!known) return pt ? `Campo "${head}" (fora do contrato)` : `Field "${head}" (outside the contract)`;
  const label = known[pt ? 0 : 1];
  if (index === undefined) return label;
  const n = Number(index) + 1;
  if (head === 'instructions') return pt ? `Instrução ${n}` : `Instruction ${n}`;
  if (head === 'tools') return pt ? `Tool ${n}` : `Tool ${n}`;
  if (head === 'skills') {
    const skill = pt ? `Skill ${n}` : `Skill ${n}`;
    if (!sub) return skill;
    const skillField = SKILL_FIELDS[sub];
    if (!skillField) return pt ? `${skill}, campo "${sub}" (fora do contrato)` : `${skill}, field "${sub}" (outside the contract)`;
    const field = skillField[pt ? 0 : 1];
    if (sub === 'examples' && subIndex !== undefined) return pt ? `${skill}, exemplo ${Number(subIndex) + 1}` : `${skill}, example ${Number(subIndex) + 1}`;
    return `${skill}, ${field}`;
  }
  return `${label} ${n}`;
}

const ISSUE_HINTS: Record<string, [string, string]> = {
  schema_version: ['Use "agent-draft/v1" ou gere a proposta de novo.', 'Use "agent-draft/v1" or generate the proposal again.'],
  required: ['Preencha o campo ou peça ao modelo para completar o rascunho.', 'Fill in the field or ask the model to complete the draft.'],
  unknown_field: ['Remova o campo: o rascunho não pode pedir imagem, namespace, env, volume nem label.', 'Remove the field: the draft cannot ask for image, namespace, env, volume or labels.'],
  type: ['O valor está no tipo errado. Edite o JSON ou gere de novo.', 'The value has the wrong type. Edit the JSON or generate again.'],
  too_short: ['Escreva um texto mais completo.', 'Write a longer text.'],
  too_long: ['Encurte o texto.', 'Shorten the text.'],
  too_few: ['Adicione pelo menos um item.', 'Add at least one item.'],
  too_many: ['Remova itens até caber no limite.', 'Remove items until it fits the limit.'],
  pattern: ['Use "ab-" seguido de letras minúsculas, números e hífen, sem hífen no fim.', 'Use "ab-" followed by lowercase letters, digits and hyphens, not ending with a hyphen.'],
  not_single_line: ['Deixe o texto em uma linha, sem espaço nas pontas.', 'Keep the text on one line, without leading or trailing spaces.'],
  secret_like: ['Remova o trecho que parece credencial. Agent nenhum recebe segredo pelo rascunho.', 'Remove the part that looks like a credential. No agent gets a secret through the draft.'],
  enum: ['Escolha um dos valores permitidos.', 'Pick one of the allowed values.'],
  duplicate: ['Remova a repetição.', 'Remove the duplicate.'],
  tool_not_allowed: ['Escolha só tools do catálogo read-only, na etapa Tools.', 'Pick only tools from the read-only catalog, in the Tools step.'],
  reserved_name: ['O prefixo "ab-fx-" é reservado para fixtures de admin. Escolha outro nome.', 'The "ab-fx-" prefix is reserved for admin fixtures. Pick another name.'],
  no_tools: ['O agent responde só pela conversa. Se ele precisa de dado ao vivo, escolha uma tool.', 'The agent answers only from the conversation. Pick a tool if it needs live data.'],
  pod_logs_sensitive: ['Log de pod pode conter dado sensível. Mantenha só se o agent precisa dele.', 'Pod logs can contain sensitive data. Keep it only if the agent needs it.'],
};

export interface ReadableIssue { field: string; message: string; hint: string; code: string; path: string }

export function readIssue(issue: DraftIssue | string, pt: boolean): ReadableIssue {
  if (typeof issue === 'string') return { field: pt ? 'Rascunho' : 'Draft', message: issue, hint: '', code: '', path: '' };
  const message = (pt ? issue.messagePt : undefined) || issue.message || issue.code;
  const hint = ISSUE_HINTS[issue.code]?.[pt ? 0 : 1] ?? '';
  return { field: fieldLabel(issue.path ?? '', pt), message, hint, code: issue.code, path: issue.path ?? '' };
}

// ---------------------------------------------------------------- erros de API

export type ApiContext = 'gate' | 'generate' | 'preview' | 'submit' | 'disable' | 'request' | 'cluster' | 'a2a';

export interface ActionableError { header: string; message: string; action: string; retryable: boolean }

/** Cada falha diz o que aconteceu, por que e o que fazer. O texto original do servidor vai junto. */
export function describeApiError(cause: unknown, context: ApiContext, pt: boolean): ActionableError {
  const status = cause instanceof ApiError ? cause.status : -1;
  const server = cause instanceof Error ? cause.message : typeof cause === 'object' && cause && 'message' in cause ? String((cause as { message: unknown }).message) : '';
  const E = (headerPt: string, headerEn: string, actionPt: string, actionEn: string, retryable = true): ActionableError =>
    ({ header: pt ? headerPt : headerEn, message: server, action: pt ? actionPt : actionEn, retryable });

  if (status === 0 && server === 'harmony unavailable') {
    return E(`Sem sessão (${IDENTITY_PROVIDER})`, `No session (${IDENTITY_PROVIDER})`, `Abra a Agent Platform pelo ${HOSTING}: as chamadas são assinadas com a sua sessão.`, `Open the Agent Platform through ${HOSTING}: calls are signed with your session.`, false);
  }
  if (status === 0) return E('Sem conexão com a API', 'Cannot reach the API', 'Confira a rede e a VPN, e tente de novo.', 'Check your network and VPN, then try again.');
  if (status === 401 || status === 403) {
    if (context === 'a2a') return E('Sem permissão para testar este agent', 'Not allowed to test this agent', 'Só quem pediu o agent ou um admin pode testar. Peça ao dono ou a um admin.', 'Only the requester or an admin can test it. Ask the owner or an admin.', false);
    return E('Acesso negado', 'Access denied', 'Seu alias precisa estar na allowlist da plataforma. Peça acesso a um admin em Administração da plataforma.', 'Your alias must be on the platform allowlist. Ask an admin under Platform admin.', false);
  }
  if (status === 404 && (server.includes('agent builder disabled') || context === 'gate')) {
    return E('Agent Builder desligado neste ambiente', 'Agent Builder is off in this environment', 'Um admin liga a feature com AGENT_BUILDER_ENABLED=true depois das pré-condições P1 a P6.', 'An admin turns it on with AGENT_BUILDER_ENABLED=true after preconditions P1 to P6.', false);
  }
  if (status === 409 && context === 'a2a') return E('O agent não está pronto', 'The agent is not ready', 'Espere a fase "Pronto" ou reative o agent antes de testar.', 'Wait for the "Ready" phase, or re-enable the agent before testing.');
  if (status === 504) return E('Sem resposta em 20 s', 'No answer within 20 s', 'O agent pode estar iniciando. Tente de novo em instantes.', 'The agent may still be starting. Try again shortly.');
  if (status === 502) {
    if (context === 'generate') return E('O AI Gateway falhou', 'The AI Gateway failed', 'Tente de novo em instantes. Se repetir, confira a saúde em AI Gateway.', 'Try again shortly. If it repeats, check health under AI Gateway.');
    return E('O serviço de destino respondeu erro', 'The upstream service returned an error', 'Tente de novo. Se repetir, leia os eventos do agent.', 'Try again. If it repeats, read the agent events.');
  }
  if (status === 422 && context === 'generate') return E('O modelo não devolveu um rascunho em JSON', 'The model did not return a JSON draft', 'Gere de novo ou descreva o agent com mais detalhe (o que ele lê, como responde).', 'Generate again, or describe the agent in more detail (what it reads, how it answers).');
  if (status === 422) return E('O rascunho foi recusado pela policy', 'The draft was rejected by policy', 'Corrija os campos listados e valide de novo.', 'Fix the listed fields and validate again.', false);
  if (status === 400) return E('Pedido inválido', 'Invalid request', 'Confira o texto e os campos e tente de novo.', 'Check the text and fields and try again.', false);
  if (status >= 500) return E('Erro no servidor', 'Server error', 'Tente de novo em instantes.', 'Try again shortly.');
  return E('Algo falhou', 'Something failed', 'Tente de novo.', 'Try again.');
}

/** Erros de validação que vêm no corpo de um 422 do 5.3. */
export function issuesFromError(cause: unknown): DraftIssue[] {
  if (!(cause instanceof ApiError) || cause.status !== 422) return [];
  const body = cause.body as { errors?: unknown } | null;
  return Array.isArray(body?.errors) ? body.errors as DraftIssue[] : [];
}

// ---------------------------------------------------------------- diff do manifest

export interface DiffLine { kind: 'add' | 'del' | 'same'; text: string; oldNo?: number; newNo?: number }

const DIFF_LIMIT = 1500;

/** Diff de linhas por LCS. O manifest tem dezenas de linhas, então O(n*m) cabe com folga. */
export function lineDiff(before: string | null, after: string): DiffLine[] {
  const b = before === null ? [] : before.replace(/\n$/, '').split('\n');
  const a = after.replace(/\n$/, '').split('\n');
  if (b.length > DIFF_LIMIT || a.length > DIFF_LIMIT) {
    return [...b.map((text, i) => ({ kind: 'del' as const, text, oldNo: i + 1 })), ...a.map((text, i) => ({ kind: 'add' as const, text, newNo: i + 1 }))];
  }
  const lcs: number[][] = Array.from({ length: b.length + 1 }, () => new Array<number>(a.length + 1).fill(0));
  for (let i = b.length - 1; i >= 0; i -= 1) {
    for (let j = a.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = b[i] === a[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < b.length || j < a.length) {
    if (i < b.length && j < a.length && b[i] === a[j]) { out.push({ kind: 'same', text: a[j], oldNo: i + 1, newNo: j + 1 }); i += 1; j += 1; }
    else if (j < a.length && (i >= b.length || lcs[i][j + 1] >= lcs[i + 1][j])) { out.push({ kind: 'add', text: a[j], newNo: j + 1 }); j += 1; }
    else { out.push({ kind: 'del', text: b[i], oldNo: i + 1 }); i += 1; }
  }
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter(l => l.kind === 'add').length, removed: lines.filter(l => l.kind === 'del').length };
}

// ---------------------------------------------------------------- agent do cluster para a fase

export function toPhaseAgent(agent: BuilderAgent | null): PhaseAgent | null {
  if (!agent) return null;
  return {
    createdAt: agent.createdAt,
    accepted: agent.accepted?.status ?? 'Unknown',
    ready: agent.ready?.status ?? 'Unknown',
    generation: agent.generation,
    observedGeneration: agent.observedGeneration,
    replicas: agent.replicas,
    podReplicas: agent.podReplicas ?? null,
  };
}

/**
 * O Agent lido do cluster só vale para o pedido acompanhado se for o objeto DESTE pedido.
 *
 * Um Agent órfão com o mesmo nome pode seguir no cluster (o mirror nunca apaga e o L3 tem duas
 * etapas). Um create novo para esse nome passa pelo create-only da main e, sem esta amarração, a
 * tela mostraria READY, e até VERIFIED, de outro objeto antes de o Argo aplicar o novo (review de
 * 13/10/2026, achado 4). A anotação platform.appmod/request-id é a prova: divergiu, o objeto do
 * pedido ainda não existe. Só vale para create: o disable mantém a anotação do create original.
 */
export function agentForTarget(agent: BuilderAgent | null, target: Pick<TrackedTarget, 'op' | 'requestId'>): BuilderAgent | null {
  if (!agent || target.op !== 'create' || !target.requestId) return agent;
  return agent.requestId === target.requestId ? agent : null;
}

// ---------------------------------------------------------------- alvo acompanhado

export interface TrackedTarget { name: string; op: AgentOp; requestId?: string }

const TRACKED_KEY = 'appmod.agentBuilder.tracked.v1';

/** Valida tudo que volta do storage: o valor pode ter sido editado à mão. */
export function sanitizeTracked(value: unknown): TrackedTarget | null {
  if (!value || typeof value !== 'object') return null;
  const { name, op, requestId } = value as Record<string, unknown>;
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) return null;
  if (op !== 'create' && op !== 'disable') return null;
  if (requestId !== undefined && (typeof requestId !== 'string' || !REQUEST_ID.test(requestId))) return null;
  return requestId ? { name, op, requestId } : { name, op };
}

export function loadTracked(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): TrackedTarget | null {
  try { return sanitizeTracked(JSON.parse(storage?.getItem(TRACKED_KEY) ?? 'null')); } catch { return null; }
}

export function saveTracked(target: TrackedTarget | null, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage): void {
  try {
    if (target) storage?.setItem(TRACKED_KEY, JSON.stringify(target));
    else storage?.removeItem(TRACKED_KEY);
  } catch { /* storage indisponível: o acompanhamento só não sobrevive ao reload */ }
}
