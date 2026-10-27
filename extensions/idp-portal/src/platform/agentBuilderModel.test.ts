import { describe, expect, it } from 'vitest';
import invalidRaw from '../../tests/fixtures/agent-builder/invalid-drafts.json?raw';
import enabledManifest from '../../tests/fixtures/agent-builder/valid-pod-health.manifest.json?raw';
import disabledManifest from '../../tests/fixtures/agent-builder/valid-pod-health.disabled.manifest.json?raw';
import { ApiError, BuilderAgent } from './agentBuilderApi';
import { agentBuilderPhase } from './agentBuilderPhase';
import {
  agentForTarget, composeGeneratePrompt, describeApiError, diffStats, fieldLabel, generateLocale, lineDiff, loadTracked, orderByCatalog,
  parseDraftJson, readIssue, sameTools, sanitizeTracked, saveTracked, stableStringify, toPhaseAgent,
} from './agentBuilderModel';

const invalid = JSON.parse(invalidRaw) as { codes: string[]; cases: { id: string; expected: { path: string; code: string }[] }[] };

describe('pedido ao modelo', () => {
  const context = { language: 'es' as const, namespaceFocus: 'appmod', preferredTools: ['k8s_get_events', 'k8s_get_resources'] };

  it('leva a descrição intacta e o contexto em linhas legíveis', () => {
    const prompt = composeGeneratePrompt('Mostre os pods fora de Running.', context);
    expect(prompt.startsWith('Mostre os pods fora de Running.\n')).toBe(true);
    expect(prompt).toContain('Spanish (language: es)');
    expect(prompt).toContain('Focus namespace: appmod');
    // Ordem do catálogo, não a ordem do clique.
    expect(prompt).toContain('Preferred read-only tools: k8s_get_resources, k8s_get_events.');
  });

  it('sem tools, diz isso; com ajuste, inclui o pedido de mudança', () => {
    const prompt = composeGeneratePrompt('Responda dúvidas de Kubernetes.', { ...context, preferredTools: [], namespaceFocus: '' }, 'responda em tópicos');
    expect(prompt).toContain('No tools: the agent answers only from the conversation.');
    expect(prompt).not.toContain('Focus namespace');
    expect(prompt).toContain('Change requested on the previous draft: responda em tópicos');
  });

  it('espanhol usa locale pt-BR no BFF e o idioma pelo texto', () => {
    expect(generateLocale('es')).toBe('pt-BR');
    expect(generateLocale('en-US')).toBe('en-US');
  });

  it('tool fora do catálogo nunca passa pela ordenação', () => {
    expect(orderByCatalog(['k8s_apply_manifest', 'k8s_get_pod_logs', 'k8s_get_resources', 'k8s_get_resources'])).toEqual(['k8s_get_resources', 'k8s_get_pod_logs']);
    expect(sameTools(['k8s_get_events', 'k8s_get_resources'], ['k8s_get_resources', 'k8s_get_events'])).toBe(true);
    expect(sameTools(['k8s_get_events'], [])).toBe(false);
  });
});

describe('erros de validação legíveis', () => {
  it('todo código do contrato tem uma dica de correção', () => {
    for (const code of invalid.codes) {
      expect(readIssue({ path: '/name', code, message: 'x' }, true).hint, code).not.toBe('');
    }
  });

  it('todo path das fixtures inválidas vira um rótulo em português', () => {
    for (const c of invalid.cases) {
      for (const e of c.expected) {
        const label = fieldLabel(e.path, true);
        expect(label, `${c.id} ${e.path}`).not.toMatch(/^\//);
        expect(label.length).toBeGreaterThan(3);
      }
    }
    expect(fieldLabel('/skills/0/examples/1', true)).toBe('Skill 1, exemplo 2');
    expect(fieldLabel('/instructions/0', true)).toBe('Instrução 1');
    expect(fieldLabel('/image', true)).toBe('Campo "image" (fora do contrato)');
    expect(fieldLabel('/skills/0/inputModes', true)).toBe('Skill 1, campo "inputModes" (fora do contrato)');
    expect(fieldLabel('', true)).toBe('Rascunho inteiro');
  });

  it('prefere messagePt em português e message em inglês', () => {
    const issue = { path: '/tools/0', code: 'tool_not_allowed', message: 'Tool is not in the read-only catalog.', messagePt: 'A tool não está no catálogo read-only.' };
    expect(readIssue(issue, true).message).toBe(issue.messagePt);
    expect(readIssue(issue, false).message).toBe(issue.message);
    expect(readIssue(issue, true).field).toBe('Tool 1');
  });
});

describe('erros de API acionáveis', () => {
  const cases: [number, string, string][] = [
    [403, 'a2a', 'Sem permissão para testar este agent'],
    [403, 'submit', 'Acesso negado'],
    [404, 'gate', 'Agent Builder desligado neste ambiente'],
    [409, 'a2a', 'O agent não está pronto'],
    [502, 'generate', 'O AI Gateway falhou'],
    [504, 'a2a', 'Sem resposta em 20 s'],
    [422, 'submit', 'O rascunho foi recusado pela policy'],
  ];
  for (const [status, context, header] of cases) {
    it(`${status} em ${context}`, () => {
      const described = describeApiError(new ApiError(status, 'server said so'), context as never, true);
      expect(described.header).toBe(header);
      expect(described.action.length).toBeGreaterThan(10);
      expect(described.message).toBe('server said so');
    });
  }
  it('erro de rota desligada é reconhecido mesmo fora do gate', () => {
    expect(describeApiError(new ApiError(404, 'agent builder disabled'), 'preview', true).retryable).toBe(false);
  });
  it('objeto de erro do the internal gateway (sem ser Error) mantém a mensagem', () => {
    expect(describeApiError({ name: 'X', message: 'role not registered' }, 'preview', true).message).toBe('role not registered');
  });
});

describe('diff do manifest', () => {
  it('arquivo novo: tudo é adição', () => {
    const lines = lineDiff(null, enabledManifest);
    expect(diffStats(lines)).toEqual({ added: enabledManifest.trimEnd().split('\n').length, removed: 0 });
  });

  it('do golden ativo para o desativado: só label de estado e replicas mudam', () => {
    const lines = lineDiff(enabledManifest, disabledManifest);
    const changed = lines.filter(l => l.kind !== 'same').map(l => `${l.kind}:${l.text.trim()}`);
    expect(changed.some(l => l.startsWith('add:') && l.includes('"platform.appmod/state": "disabled"'))).toBe(true);
    expect(changed.some(l => l.startsWith('add:') && l.includes('"replicas": 0'))).toBe(true);
    // Reconstrói o depois a partir do diff: prova de que o diff é fiel.
    const after = lines.filter(l => l.kind !== 'del').map(l => l.text).join('\n');
    expect(`${after}\n`).toBe(disabledManifest);
    const before = lines.filter(l => l.kind !== 'add').map(l => l.text).join('\n');
    expect(`${before}\n`).toBe(enabledManifest);
  });

  it('sem mudança, nada marcado', () => {
    expect(diffStats(lineDiff(enabledManifest, enabledManifest))).toEqual({ added: 0, removed: 0 });
  });
});

describe('rascunho', () => {
  it('stableStringify ignora a ordem das chaves', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
  it('parseDraftJson aceita só objeto e explica o erro', () => {
    expect(parseDraftJson('{"name":"ab-x"}', true)).toMatchObject({ ok: true });
    expect(parseDraftJson('[1]', true)).toMatchObject({ ok: false });
    const broken = parseDraftJson('{"name":', true);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toMatch(/JSON inválido/);
  });
});

describe('alvo acompanhado', () => {
  it('rejeita o que não segue o contrato', () => {
    expect(sanitizeTracked({ name: 'ab-pod-health', op: 'create', requestId: 'a'.repeat(32) })).toEqual({ name: 'ab-pod-health', op: 'create', requestId: 'a'.repeat(32) });
    expect(sanitizeTracked({ name: 'pod-health', op: 'create' })).toBeNull();
    expect(sanitizeTracked({ name: 'ab-pod-health', op: 'delete' })).toBeNull();
    expect(sanitizeTracked({ name: 'ab-pod-health', op: 'create', requestId: '../x' })).toBeNull();
  });
  it('salva, lê e limpa pelo storage', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    saveTracked({ name: 'ab-pod-health', op: 'disable' }, storage);
    expect(loadTracked(storage)).toEqual({ name: 'ab-pod-health', op: 'disable' });
    saveTracked(null, storage);
    expect(loadTracked(storage)).toBeNull();
    store.set('appmod.agentBuilder.tracked.v1', '{not json');
    expect(loadTracked(storage)).toBeNull();
  });
});

// Achado 4 do review de 13/10/2026: o status da tela fica preso ao objeto DESTE pedido.
describe('agent lido do cluster amarrado ao pedido', () => {
  const mine = 'a'.repeat(32);
  const orphan = {
    name: 'ab-pod-health', requestId: 'f'.repeat(32), createdAt: 900, generation: 1, observedGeneration: 1, replicas: null,
    accepted: { status: 'True' }, ready: { status: 'True' },
  } as unknown as BuilderAgent;
  const merged = { status: 'merged' as const, mergedAt: 1000 };

  it('órfão com o mesmo nome não vira READY de um create novo', () => {
    const bound = agentForTarget(orphan, { op: 'create', requestId: mine });
    expect(bound).toBeNull();
    expect(agentBuilderPhase('create', merged, toPhaseAgent(bound), null, 1100)).toBe('SYNCING');
    // Sem a amarração, a mesma leitura mostraria READY de outro objeto.
    expect(agentBuilderPhase('create', merged, toPhaseAgent(orphan), null, 1100)).toBe('READY');
  });

  it('o objeto do próprio pedido segue valendo', () => {
    const own = { ...orphan, requestId: mine } as BuilderAgent;
    expect(agentForTarget(own, { op: 'create', requestId: mine })).toBe(own);
  });

  it('disable e agent aberto pela lista não comparam request-id', () => {
    expect(agentForTarget(orphan, { op: 'disable', requestId: mine })).toBe(orphan);
    expect(agentForTarget(orphan, { op: 'create' })).toBe(orphan);
    expect(agentForTarget(null, { op: 'create', requestId: mine })).toBeNull();
  });
});

// R3-1 do review de 13/10/2026 (rodada 3): DISABLED pelo que aconteceu, lido pelo caminho real
// (resposta da cluster-api -> toPhaseAgent -> fase), não só pela função de fase isolada.
describe('desativado só com zero pods de verdade', () => {
  const disabling = {
    name: 'ab-pod-health', requestId: 'a'.repeat(32), createdAt: 100, generation: 2, observedGeneration: 2, replicas: 0,
    accepted: { status: 'True' }, ready: { status: 'True' },
  } as unknown as BuilderAgent;
  const merged = { status: 'merged' as const, mergedAt: 1000 };

  it('pod antigo ainda de pé: aguardando, não desativado', () => {
    const agent = { ...disabling, podReplicas: 1 } as BuilderAgent;
    expect(toPhaseAgent(agent)?.podReplicas).toBe(1);
    expect(agentBuilderPhase('disable', merged, toPhaseAgent(agent), null, 1100)).toBe('SYNCING');
  });

  it('cluster-api sem o campo (versão antiga) ou sem leitura: nunca conclui desativado', () => {
    expect(toPhaseAgent(disabling)?.podReplicas).toBeNull();
    expect(agentBuilderPhase('disable', merged, toPhaseAgent(disabling), null, 1100)).toBe('SYNCING');
  });

  it('zero pods e spec observado: desativado', () => {
    const agent = { ...disabling, podReplicas: 0, ready: { status: 'False' } } as unknown as BuilderAgent;
    expect(agentBuilderPhase('disable', merged, toPhaseAgent(agent), null, 1100)).toBe('DISABLED');
  });
});
