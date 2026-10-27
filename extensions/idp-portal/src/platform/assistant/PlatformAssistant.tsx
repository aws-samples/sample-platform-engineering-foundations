// Página do Platform Assistant (issue #12). Isolada: recebe projeto e client por props. O shell a
// monta em `#assistant` por PlatformAssistantPage (devPlatformPages.tsx), com o projeto do escopo.
//
// Fluxo: pedido -> preview (plano, defaults, dependências, manifests) -> edição opcional -> confirmação
// do hash mostrado -> timeline real (pedido, MR, Argo, conditions, Ready) -> retry ou rollback.
//
// Persistência: o plano enviado vira `#assistant/<planId>` (onPlanOpened). Reload e deep link
// relêem o run do servidor por `client.get`; nada vai para storage do browser.
import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AssistantApiError, AssistantClient } from './assistantApi';
import { CompensationPreview, editInput, newIdempotencyKey, PlanPreview, PlanRun, ProvisionPlan, routeAction } from './assistantModel';
import { focusElement, setProjectDraft } from '../shellNavigation';
import { CompensationPanel, ConfirmPanel, ExecutorFacts, PlanIssues, PlanSteps, RunSteps, RunTimeline } from './PlatformAssistantParts';
import './assistant.css';

const POLL_MS = 15_000;
const ACTIVE = new Set(['running', 'compensating']);

export function PlatformAssistant({ project, client, pt, planId = null, onPlanOpened }: {
  /** null: só leitura de um plano aberto pela rota, sem projeto elegível selecionado. */
  project: string | null; client: AssistantClient; pt: boolean;
  planId?: string | null; onPlanOpened?(planId: string | null): void;
}): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [plan, setPlan] = useState<ProvisionPlan | null>(null);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [run, setRun] = useState<PlanRun | null>(null);
  const [undo, setUndo] = useState<CompensationPreview | null>(null);
  const [undoAck, setUndoAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Uma chave por intenção de envio: reenviar o MESMO plano confirmado nunca cria em dobro.
  const key = useRef(newIdempotencyKey());
  // Depois de enviar ou confirmar o rollback, o foco vai ao cabeçalho do run que acabou de aparecer.
  const runHeading = useRef<HTMLSpanElement>(null);
  const [focusRun, setFocusRun] = useState(0);
  useEffect(() => { if (focusRun && runHeading.current) focusElement(runHeading.current); }, [focusRun]);

  const guard = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof AssistantApiError ? `${cause.message} (${cause.code})` : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const show = (next: PlanPreview) => {
    setPreview(next);
    setPlan(next.plan);
    setAcknowledged(false);
  };

  const draft = () => guard(async () => {
    if (!project) return;
    const result = await client.draft(project, prompt);
    if (!result.modelOutputAccepted || !result.preview) {
      setError(result.errors.map((e) => e.message).join('; ') || (pt ? 'o modelo não devolveu um plano' : 'the model returned no plan'));
      return;
    }
    show(result.preview);
    key.current = newIdempotencyKey();
  });

  const edit = (ref: string, field: string, value: string) => {
    if (!plan || !preview) return;
    const step = preview.steps.find((s) => s.ref === ref);
    const type = typeof step?.inputs[field] === 'number' ? 'integer' : typeof step?.inputs[field] === 'boolean' ? 'boolean' : 'string';
    setPlan(editInput(plan, ref, field, value, type));
    setAcknowledged(false);
  };

  const repreview = () => guard(async () => { if (plan && project) show(await client.preview(project, plan)); });

  const submit = () => guard(async () => {
    if (!project || !plan || !preview?.planSha256) return;
    const result = await client.submit(project, plan, key.current, preview.planSha256);
    setRun(result.run);
    setFocusRun(n => n + 1);
    onPlanOpened?.(result.run.planId);
  });

  // A rota manda: `#assistant/<planId>` carrega aquele run do servidor; `#assistant` volta ao pedido.
  useEffect(() => {
    const action = routeAction(planId, run?.planId ?? null);
    if (action === 'reset') {
      setRun(null); setUndo(null); setPreview(null); setPlan(null); setPrompt(''); setAcknowledged(false);
      key.current = newIdempotencyKey();
    } else if (action === 'load' && planId) {
      void guard(async () => { setRun((await client.get(planId)).run); setUndo(null); });
    }
  }, [planId]);

  // Pedido ou plano em edição neste projeto: trocar de projeto pede confirmação no shell.
  const dirty = !run && (prompt.trim() !== '' || plan !== null);
  useEffect(() => {
    setProjectDraft('assistant', dirty ? (pt ? 'pedido do Platform Assistant' : 'Platform Assistant request') : null);
    return () => setProjectDraft('assistant', null);
  }, [dirty, pt]);

  const refresh = useCallback(() => guard(async () => { if (run) setRun((await client.refresh(run.planId)).run); }), [client, guard, run]);

  useEffect(() => {
    if (!run || !ACTIVE.has(run.state)) return undefined;
    const timer = window.setTimeout(() => { void refresh(); }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [run, refresh]);

  const retry = (ref: string, attempt: number) => guard(async () => { if (run) setRun((await client.retry(run.planId, ref, attempt)).run); });
  const loadUndo = () => guard(async () => { if (run) { setUndo(await client.compensationPreview(run.planId)); setUndoAck(false); } });
  const confirmUndo = () => guard(async () => {
    if (run && undo) { setRun((await client.compensationConfirm(run.planId, undo.compensationSha256)).run); setUndo(null); setFocusRun(n => n + 1); }
  });
  const edited = !!plan && !!preview && JSON.stringify(plan) !== JSON.stringify(preview.plan);

  return (
    <SpaceBetween size="l">
      {error && <Alert type="error" dismissible onDismiss={() => setError(null)}>{error}</Alert>}
      {!run && project && !planId && (
        <Container header={<Header variant="h2" description={pt ? 'O assistant só propõe dados. Catálogo, schema e policy decidem o manifest.' : 'The assistant only proposes data. Catalog, schema and policy decide the manifest.'}>
          {pt ? `Pedido para ${project}` : `Request for ${project}`}</Header>}>
          <SpaceBetween size="s">
            <Textarea value={prompt} ariaLabel={pt ? 'Pedido' : 'Request'} onChange={({ detail }) => setPrompt(detail.value)}
              placeholder={pt ? 'Ex.: preciso de uma função e uma API HTTP para o todo-app' : 'e.g. I need a function and an HTTP API for the todo-app'} />
            <Button onClick={draft} loading={busy} disabled={!prompt.trim()}>{pt ? 'Montar plano' : 'Build plan'}</Button>
          </SpaceBetween>
        </Container>
      )}
      {preview && !run && (
        <Container header={<Header variant="h2" actions={edited ? <Button onClick={repreview} loading={busy}>{pt ? 'Validar edição' : 'Validate edit'}</Button> : undefined}>
          {pt ? 'Plano' : 'Plan'}</Header>}>
          <SpaceBetween size="m">
            <ExecutorFacts preview={preview} pt={pt} />
            <PlanIssues preview={preview} pt={pt} />
            <PlanSteps preview={edited && plan ? { ...preview, steps: preview.steps.map((s) => ({ ...s, inputs: plan.items.find((i) => i.ref === s.ref)?.inputs ?? s.inputs })) } : preview}
              editable onEdit={edit} pt={pt} />
            {edited ? <Alert type="info">{pt ? 'Você editou o plano: valide de novo para confirmar.' : 'You edited the plan: validate again to confirm.'}</Alert>
              : <ConfirmPanel preview={preview} acknowledged={acknowledged} onAcknowledge={setAcknowledged} onSubmit={submit} busy={busy} pt={pt} />}
          </SpaceBetween>
        </Container>
      )}
      {run && (
        <Container header={<Header variant="h2" actions={<SpaceBetween direction="horizontal" size="xs">
          <Button onClick={() => { void refresh(); }} loading={busy} iconName="refresh">{pt ? 'Atualizar' : 'Refresh'}</Button>
          {!run.compensation && <Button onClick={loadUndo} disabled={busy}>{pt ? 'Planejar rollback' : 'Plan rollback'}</Button>}
        </SpaceBetween>}><span ref={runHeading} tabIndex={-1} data-run-heading>{pt ? `Plano ${run.planId.slice(0, 8)}` : `Plan ${run.planId.slice(0, 8)}`}</span></Header>}>
          <SpaceBetween size="m">
            <RunSteps run={run} onRetry={retry} busy={busy} pt={pt} />
            {undo && <CompensationPanel preview={undo} acknowledged={undoAck} onAcknowledge={setUndoAck} onConfirm={confirmUndo} busy={busy} pt={pt} />}
            <RunTimeline run={run} pt={pt} />
          </SpaceBetween>
        </Container>
      )}
    </SpaceBetween>
  );
}
