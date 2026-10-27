import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import draftRaw from '../../tests/fixtures/agent-builder/valid-pod-health.draft.json?raw';
import enabledManifest from '../../tests/fixtures/agent-builder/valid-pod-health.manifest.json?raw';
import disabledManifest from '../../tests/fixtures/agent-builder/valid-pod-health.disabled.manifest.json?raw';
import { A2AChat, DraftSummary, ErrorAlert, LifecycleTimeline, ManifestDiff, PhaseBanner, PolicyVerdict, ToolCatalogCards } from './AgentBuilderParts';

const draft = JSON.parse(draftRaw);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// O Cloudscape usa useLayoutEffect; no render de servidor o React avisa. Só esse aviso é filtrado.
const originalError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return;
    originalError(...args);
  });
});
afterAll(() => vi.restoreAllMocks());

describe('DOM das peças do Agent Builder', () => {
  it('rascunho legível: nome, instruções numeradas e tools', () => {
    const html = renderToStaticMarkup(<DraftSummary draft={draft} pt />);
    const t = text(html);
    expect(t).toContain('Saúde dos pods');
    expect(t).toContain('ab-pod-health');
    expect(html).toContain('<ol class="ab-list">');
    expect(t).toContain('Como ele trabalha (3)');
    expect(t).toContain('k8s_get_events');
  });

  it('veredito bloqueado lista campo, mensagem, dica e código, sem depender de cor', () => {
    const html = renderToStaticMarkup(
      <PolicyVerdict valid={false} pt warnings={[]} errors={[{ path: '/tools/0', code: 'tool_not_allowed', message: 'Tool is not in the read-only catalog.', messagePt: 'A tool não está no catálogo read-only.' }]} />,
    );
    const t = text(html);
    expect(t).toContain('Bloqueado pela policy: 1 erro(s)');
    expect(t).toContain('Erro Tool 1 : A tool não está no catálogo read-only.');
    expect(t).toContain('Como resolver: Escolha só tools do catálogo read-only');
    expect(t).toContain('tool_not_allowed em /tools/0');
    expect(html).toContain('aria-label="Erros"');
  });

  it('veredito aprovado com aviso', () => {
    const t = text(renderToStaticMarkup(<PolicyVerdict valid pt errors={[]} warnings={[{ path: '/tools', code: 'pod_logs_sensitive', message: 'Pod logs may contain sensitive data.' }]} />));
    expect(t).toContain('Aprovado pela policy, com 1 aviso(s)');
    expect(t).toContain('Aviso');
  });

  it('diff marca adição e remoção com símbolo e texto para leitor de tela', () => {
    const html = renderToStaticMarkup(<ManifestDiff before={enabledManifest} after={disabledManifest} pt />);
    const t = text(html);
    expect(t).toMatch(/Desde o último preview: \d+ linha\(s\) adicionada\(s\), \d+ removida\(s\)\./);
    expect(html).toContain('class="ab-diff-add"');
    expect(t).toContain('adicionada');
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(t).toContain('Legenda: + linha adicionada, - linha removida.');
  });

  it('diff de arquivo novo', () => {
    const t = text(renderToStaticMarkup(<ManifestDiff before={null} after={enabledManifest} pt />));
    expect(t).toMatch(/Arquivo novo: \d+ linha\(s\) adicionada\(s\)\./);
  });

  it('trilha escreve o estado de cada passo por extenso', () => {
    const html = renderToStaticMarkup(<LifecycleTimeline op="create" phase="STARTING" pt />);
    expect(html).toContain('data-step="sync" data-state="done"');
    expect(html).toContain('data-step="start" data-state="current"');
    const t = text(html);
    expect(t).toContain('Argo CD aplica (concluído)');
    expect(t).toContain('Controller aceita e inicia (em andamento)');
    expect(t).toContain('Teste A2A (aguardando)');
  });

  it('banner da fase fica numa live region', () => {
    const html = renderToStaticMarkup(<PhaseBanner phase="SYNC_STALLED" pt />);
    expect(html).toContain('data-phase="SYNC_STALLED"');
    expect(text(html)).toContain('Atenção: o Argo CD não aplicou em 15 min');
  });

  it('chat A2A: log acessível, quem fala por extenso, estado vazio explicado', () => {
    const empty = text(renderToStaticMarkup(<A2AChat agentLabel="Saúde dos pods" messages={[]} running={false} disabled={false} onSend={() => undefined} pt />));
    expect(empty).toContain('Nenhuma mensagem ainda.');
    const html = renderToStaticMarkup(
      <A2AChat agentLabel="Saúde dos pods" running disabled={false} onSend={() => undefined} pt
        messages={[{ id: 1, role: 'user', text: 'Quem é você?' }, { id: 2, role: 'agent', text: 'Sou o Saúde dos pods.', state: 'completed' }]} />,
    );
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
    const t = text(html);
    expect(t).toContain('Você Quem é você?');
    expect(t).toContain('Saúde dos pods · completed Sou o Saúde dos pods.');
    expect(t).toContain('Aguardando a resposta do agent');
    expect(html).toContain('aria-label="Enviar pergunta de teste"');
  });

  it('catálogo de tools mostra as 5 tools com o selo read-only', () => {
    const html = renderToStaticMarkup(<ToolCatalogCards selected={['k8s_get_events']} onChange={() => undefined} pt />);
    const t = text(html);
    for (const name of ['k8s_get_resources', 'k8s_get_resource_yaml', 'k8s_describe_resource', 'k8s_get_events', 'k8s_get_pod_logs']) expect(t).toContain(name);
    expect((t.match(/read-only/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(t).toContain('pode conter dado sensível');
  });

  it('erro acionável traz a ação e a resposta do servidor', () => {
    const t = text(renderToStaticMarkup(<ErrorAlert pt error={{ header: 'O AI Gateway falhou', message: 'HTTP 502', action: 'Tente de novo em instantes.', retryable: true }} onRetry={() => undefined} />));
    expect(t).toContain('O AI Gateway falhou');
    expect(t).toContain('Tente de novo em instantes.');
    expect(t).toContain('Resposta do servidor: HTTP 502');
    expect(t).toContain('Tentar de novo');
  });
});
