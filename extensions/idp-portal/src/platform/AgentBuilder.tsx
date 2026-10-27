// Agent Builder governado (ADR-0008). Fluxo: descrever -> contexto -> tools read-only -> proposta
// do modelo -> preview determinístico com veredito e diff -> pedido (MR pelo CI) -> acompanhamento
// até o teste A2A. Nenhuma etapa aplica nada no cluster: o caminho de escrita é só o Git.
import { useEffect, useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import RadioGroup from '@cloudscape-design/components/radio-group';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import Textarea from '@cloudscape-design/components/textarea';
import Wizard from '@cloudscape-design/components/wizard';
import {
  AgentDraft, AgentLanguage, BuilderAgent, DraftIssue, DraftValidation, generateAgentDraft, PreviewResult, PROMPT_MAX,
  previewAgentDraft, requestAgentCreate, toolCatalog,
} from './agentBuilderApi';
import {
  ActionableError, composeGeneratePrompt, DESCRIPTION_EXAMPLES, describeApiError, generateLocale, issuesFromError,
  K8S_NAMESPACE, languageLabel, loadTracked, orderByCatalog, parseDraftJson, promptTooLong, sameTools, saveTracked,
  stableStringify, toPhaseAgent, TrackedTarget, withTools,
} from './agentBuilderModel';
import { agentBuilderPhase } from './agentBuilderPhase';
import { DraftSummary, ErrorAlert, ManifestDiff, PolicyVerdict, PreviewFacts, ToolCatalogCards } from './AgentBuilderParts';
import { AgentLifecycle, PhaseCell } from './AgentBuilderLifecycle';
import { useAgentBuilderGate, useBuilderAgents } from './useAgentBuilder';
import { useI18n } from './i18n';
import './agentBuilder.css';
import { gitMergeRequestsUrl } from './deployment';

type TabId = 'create' | 'track' | 'mine';

export interface AgentBuilderProps {
  /** Quando a página já leu `/platform/me`, passa `features.agentBuilder` aqui. Sem isso, o builder lê sozinho. */
  enabled?: boolean;
}

export function AgentBuilder({ enabled }: AgentBuilderProps): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const { gate, retry } = useAgentBuilderGate(pt, enabled);
  const [tab, setTab] = useState<TabId>(() => (loadTracked() ? 'track' : 'create'));
  const [tracked, setTracked] = useState<TrackedTarget | null>(() => loadTracked());
  const [fixRequested, setFixRequested] = useState(0);

  const track = (target: TrackedTarget | null) => {
    setTracked(target);
    saveTracked(target);
    setTab(target ? 'track' : 'create');
  };

  // Tabs só monta o painel ativo (estratégia default do Cloudscape): o Wizard existe só na aba Criar.
  const wizardOnScreen = gate.status === 'enabled' && tab === 'create';
  const body = gate.status === 'loading'
    ? <Container><StatusIndicator type="loading">{pt ? 'Verificando se o Agent Builder está ligado neste ambiente…' : 'Checking whether the Agent Builder is on in this environment…'}</StatusIndicator></Container>
    : gate.status === 'error'
      ? <ErrorAlert error={gate.error} onRetry={retry} pt={pt} />
      : gate.status === 'disabled'
        ? (
          <Alert type="info" header={pt ? 'O Agent Builder ainda está desligado neste ambiente' : 'The Agent Builder is still off in this environment'}>
            {pt
              ? 'Ele liga quando um admin define AGENT_BUILDER_ENABLED=true, depois de conferir as pré-condições P1 a P6 (tool server read-only, AppProject restrito, RBAC mínimo). Até lá, nada desta tela chama a API.'
              : 'It turns on when an admin sets AGENT_BUILDER_ENABLED=true after checking preconditions P1 to P6 (read-only tool server, restricted AppProject, minimal RBAC). Until then nothing on this screen calls the API.'}
          </Alert>
        )
        : (
          <Tabs
            activeTabId={tab}
            onChange={({ detail }) => setTab(detail.activeTabId as TabId)}
            ariaLabel="Agent Builder"
            tabs={[
              {
                id: 'create',
                label: pt ? 'Criar agent' : 'Create agent',
                content: <CreateWizard pt={pt} uiLocale={locale} fixRequested={fixRequested} onSubmitted={track} />,
              },
              {
                id: 'track',
                label: tracked ? (pt ? `Acompanhar: ${tracked.name}` : `Track: ${tracked.name}`) : (pt ? 'Acompanhar' : 'Track'),
                disabled: !tracked,
                content: tracked
                  ? <AgentLifecycle target={tracked} alias={gate.alias} isAdmin={gate.isAdmin} onTrack={track} onFixDraft={() => { setFixRequested(n => n + 1); setTab('create'); }} onClose={() => track(null)} pt={pt} />
                  : null,
              },
              {
                id: 'mine',
                label: pt ? 'Agents do builder' : 'Builder agents',
                content: <BuilderAgentsTable pt={pt} active={tab === 'mine'} alias={gate.alias} onOpen={name => track({ name, op: 'create' })} onCreate={() => setTab('create')} />,
              },
            ]}
          />
        );

  return (
    <SpaceBetween size="l">
      <BuilderTitle pt={pt} wizardOnScreen={wizardOnScreen} />
      {body}
    </SpaceBetween>
  );
}

/**
 * Título da view, e a razão de a página ter UM h1 em qualquer aba ou estado.
 *
 * Com o Wizard na tela (aba Criar), o h1 é o título da etapa: o Wizard o renderiza e o foca a cada
 * troca de etapa, e o foco do shell pousa nele. Então ali o nome da tela vira texto com o mesmo
 * visual, sem tag de heading. Nas abas Acompanhar e Agents do builder, e nos estados do gate
 * (carregando, erro, desligado), não há Wizard, e o nome da tela É o h1 que o shell foca. O bloco
 * tem o mesmo visual nos dois casos, então trocar de aba não desloca a barra de abas.
 */
export function BuilderTitle({ pt, wizardOnScreen }: { pt: boolean; wizardOnScreen: boolean }): JSX.Element {
  const description = pt
    ? 'Descreva o agent em linguagem natural. A plataforma valida, compila e abre o MR; o Argo CD aplica e você testa por A2A.'
    : 'Describe the agent in plain language. The platform validates, compiles and opens the MR; Argo CD applies it and you test it over A2A.';
  if (!wizardOnScreen) return <Header variant="h1" description={description}>Agent Builder</Header>;
  return (
    <div>
      <Box variant="h1" tagOverride="div" padding="n">Agent Builder</Box>
      <Box variant="p" color="text-body-secondary" padding={{ top: 'xxs' }}>{description}</Box>
    </div>
  );
}

export default AgentBuilder;

// ---------------------------------------------------------------- wizard de criação

const STEP = { describe: 0, context: 1, tools: 2, proposal: 3, review: 4 } as const;

function CreateWizard({ pt, uiLocale, fixRequested, onSubmitted }: {
  pt: boolean;
  uiLocale: 'pt-BR' | 'en-US';
  fixRequested: number;
  onSubmitted: (target: TrackedTarget) => void;
}): JSX.Element {
  const [step, setStep] = useState(0);
  const [stepError, setStepError] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState<AgentLanguage>(uiLocale);
  const [namespaceFocus, setNamespaceFocus] = useState('');
  const [preferredTools, setPreferredTools] = useState<string[]>(['k8s_get_resources', 'k8s_get_events']);

  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [draftText, setDraftText] = useState('');
  const [draftTextError, setDraftTextError] = useState('');
  const [modelValidation, setModelValidation] = useState<DraftValidation | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [refinement, setRefinement] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<ActionableError | null>(null);

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewKey, setPreviewKey] = useState('');
  const [previousManifest, setPreviousManifest] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<ActionableError | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ActionableError | null>(null);
  const [submitIssues, setSubmitIssues] = useState<DraftIssue[]>([]);

  const draftKey = useMemo(() => (draft ? stableStringify(draft) : ''), [draft]);
  const context = { language, namespaceFocus, preferredTools };
  const composed = composeGeneratePrompt(description, context, refinement);
  const namespaceInvalid = namespaceFocus !== '' && !K8S_NAMESPACE.test(namespaceFocus);
  const previewFresh = Boolean(preview && previewKey === draftKey);

  // "Corrigir o rascunho" vindo do acompanhamento volta para a proposta, com o rascunho intacto.
  useEffect(() => { if (fixRequested > 0) setStep(draft ? STEP.proposal : STEP.describe); }, [fixRequested]); // dispara só no clique

  const applyDraft = (next: AgentDraft) => {
    setDraft(next);
    setDraftText(JSON.stringify(next, null, 2));
    setDraftTextError('');
    setSubmitIssues([]);
  };

  const generate = async (refine: boolean) => {
    const prompt = composeGeneratePrompt(description, context, refine ? refinement : '');
    if (promptTooLong(prompt)) {
      setGenerateError({ header: pt ? 'Pedido longo demais' : 'Request too long', message: '', action: pt ? `Encurte a descrição: o pedido tem ${prompt.length} de ${PROMPT_MAX} caracteres.` : `Shorten the description: the request has ${prompt.length} of ${PROMPT_MAX} characters.`, retryable: false });
      return;
    }
    setGenerating(true); setGenerateError(null);
    try {
      const result = await generateAgentDraft(prompt, generateLocale(language), refine ? draft : null);
      applyDraft(result.draft);
      setModelValidation(result.validation);
      setSources(result.sources ?? []);
      if (refine) setRefinement('');
    } catch (cause) {
      setGenerateError(describeApiError(cause, 'generate', pt));
    } finally {
      setGenerating(false);
    }
  };

  const runPreview = async () => {
    if (!draft) return;
    setPreviewing(true); setPreviewError(null);
    const key = draftKey;
    try {
      const result = await previewAgentDraft(draft);
      setPreviousManifest(preview?.manifest && preview.manifest !== result.manifest ? preview.manifest : previousManifest);
      setPreview(result);
      setPreviewKey(key);
    } catch (cause) {
      setPreviewError(describeApiError(cause, 'preview', pt));
    } finally {
      setPreviewing(false);
    }
  };

  // Ao chegar na revisão, valida o rascunho atual se o preview ficou para trás.
  useEffect(() => {
    if (step === STEP.review && draft && !previewFresh && !previewing) void runPreview();
  }, [step, draftKey]); // runPreview lê o estado atual; o gatilho é a etapa e o rascunho

  const submit = async () => {
    if (!draft || !preview?.valid || !previewFresh) {
      setSubmitError({ header: pt ? 'Valide antes de enviar' : 'Validate before submitting', message: '', action: pt ? 'O rascunho mudou ou não passou na policy. Rode a validação de novo.' : 'The draft changed or did not pass policy. Run the validation again.', retryable: false });
      return;
    }
    setSubmitting(true); setSubmitError(null); setSubmitIssues([]);
    try {
      const created = await requestAgentCreate(draft);
      onSubmitted({ name: draft.name, op: 'create', requestId: created.requestId });
    } catch (cause) {
      setSubmitIssues(issuesFromError(cause));
      setSubmitError(describeApiError(cause, 'submit', pt));
    } finally {
      setSubmitting(false);
    }
  };

  const navigate = (requested: number) => {
    setStepError('');
    if (requested > step) {
      if (step === STEP.describe && description.trim().length < 10) {
        setStepError(pt ? 'Descreva o agent em pelo menos uma frase (10 caracteres ou mais).' : 'Describe the agent in at least one sentence (10 characters or more).');
        return;
      }
      if (step === STEP.context && namespaceInvalid) {
        setStepError(pt ? 'O namespace de foco precisa seguir o padrão do Kubernetes (minúsculas, números e hífen).' : 'The focus namespace must follow the Kubernetes pattern (lowercase, digits and hyphens).');
        return;
      }
      if (step === STEP.proposal && !draft) {
        setStepError(pt ? 'Gere uma proposta antes de revisar.' : 'Generate a proposal before reviewing.');
        return;
      }
    }
    setStep(requested);
  };

  const toolsDiffer = draft && !sameTools(draft.tools ?? [], preferredTools);
  const stepAlert = stepError ? <Alert type="error">{stepError}</Alert> : null;

  return (
    <Wizard
      activeStepIndex={step}
      onNavigate={({ detail }) => navigate(detail.requestedStepIndex)}
      onSubmit={submit}
      onCancel={() => { setStep(0); setStepError(''); }}
      isLoadingNextStep={submitting}
      submitButtonText={pt ? 'Enviar para review (abre MR)' : 'Submit for review (opens MR)'}
      i18nStrings={{
        stepNumberLabel: n => (pt ? `Etapa ${n}` : `Step ${n}`),
        collapsedStepsLabel: (n, total) => (pt ? `Etapa ${n} de ${total}` : `Step ${n} of ${total}`),
        skipToButtonLabel: item => (pt ? `Ir para ${item.title}` : `Skip to ${item.title}`),
        navigationAriaLabel: pt ? 'Etapas do Agent Builder' : 'Agent Builder steps',
        cancelButton: pt ? 'Recomeçar' : 'Start over',
        previousButton: pt ? 'Anterior' : 'Previous',
        nextButton: pt ? 'Próximo' : 'Next',
        submitButton: pt ? 'Enviar para review (abre MR)' : 'Submit for review (opens MR)',
        optional: pt ? 'opcional' : 'optional',
      }}
      steps={[
        {
          title: pt ? 'Descrever' : 'Describe',
          description: pt ? 'Diga em linguagem natural o que o agent deve fazer. Ele é sempre read-only.' : 'Say in plain language what the agent should do. It is always read-only.',
          content: (
            <Container header={<Header variant="h2">{pt ? 'O que o agent deve fazer?' : 'What should the agent do?'}</Header>}>
              <SpaceBetween size="m">
                {stepAlert}
                <FormField
                  label={pt ? 'Descrição do agent' : 'Agent description'}
                  description={pt ? 'Conte o que ele lê, o que responde e para quem. Ele só lê o cluster: não cria, muda nem apaga nada.' : 'Tell what it reads, what it answers and for whom. It only reads the cluster: it never creates, changes or deletes.'}
                  constraintText={`${description.length}/${PROMPT_MAX}`}
                  errorText={description.length > PROMPT_MAX ? (pt ? 'Texto longo demais.' : 'Text too long.') : undefined}
                >
                  <Textarea value={description} onChange={({ detail }) => setDescription(detail.value)} rows={5} placeholder={pt ? DESCRIPTION_EXAMPLES[0].pt : DESCRIPTION_EXAMPLES[0].en} ariaLabel={pt ? 'Descrição do agent' : 'Agent description'} />
                </FormField>
                <div>
                  <Box variant="awsui-key-label">{pt ? 'Ou comece por um exemplo' : 'Or start from an example'}</Box>
                  <SpaceBetween size="xxs">
                    {DESCRIPTION_EXAMPLES.map(example => (
                      <Button key={example.en} variant="inline-link" onClick={() => setDescription(pt ? example.pt : example.en)}>{pt ? example.pt : example.en}</Button>
                    ))}
                  </SpaceBetween>
                </div>
              </SpaceBetween>
            </Container>
          ),
        },
        {
          title: pt ? 'Contexto' : 'Context',
          description: pt ? 'Idioma das respostas e onde o agent deve focar. O resto é fixo pela plataforma.' : 'Answer language and where the agent should focus. The rest is fixed by the platform.',
          content: (
            <Container header={<Header variant="h2">{pt ? 'Contexto do agent' : 'Agent context'}</Header>}>
              <SpaceBetween size="l">
                {stepAlert}
                <FormField label={pt ? 'Idioma das respostas do agent' : 'Agent answer language'}>
                  <RadioGroup
                    value={language}
                    onChange={({ detail }) => setLanguage(detail.value as AgentLanguage)}
                    items={(['pt-BR', 'en-US', 'es'] as AgentLanguage[]).map(value => ({ value, label: `${languageLabel(value, pt)} (${value})` }))}
                  />
                </FormField>
                <FormField
                  label={pt ? 'Namespace de foco' : 'Focus namespace'}
                  description={pt ? 'Opcional. Vira uma dica para o modelo; o agent pergunta o namespace quando não souber.' : 'Optional. It becomes a hint to the model; the agent asks for the namespace when it does not know.'}
                  errorText={namespaceInvalid ? (pt ? 'Use minúsculas, números e hífen, até 63 caracteres.' : 'Use lowercase letters, digits and hyphens, up to 63 characters.') : undefined}
                >
                  <Input value={namespaceFocus} onChange={({ detail }) => setNamespaceFocus(detail.value.trim())} placeholder="appmod" ariaLabel={pt ? 'Namespace de foco' : 'Focus namespace'} />
                </FormField>
                <div>
                  <Box variant="h3">{pt ? 'Fixo pela plataforma' : 'Fixed by the platform'}</Box>
                  <KeyValuePairs
                    columns={3}
                    items={[
                      { label: pt ? 'Onde o Agent vive' : 'Where the Agent lives', value: <code>{toolCatalog.fixed.namespace}</code> },
                      { label: 'ModelConfig', value: <code>{toolCatalog.fixed.modelConfig}</code> },
                      { label: 'Tool server', value: <code>{toolCatalog.toolServer.name}</code> },
                      { label: 'Compiler', value: <code>{toolCatalog.fixed.compiler}</code> },
                      { label: pt ? 'Arquivo no Git' : 'Git file', value: <code>{toolCatalog.fixed.gitPath}</code> },
                      { label: pt ? 'Nome' : 'Name', value: pt ? 'sempre com o prefixo ab-' : 'always prefixed with ab-' },
                    ]}
                  />
                </div>
                <Alert type="info">{pt ? 'O modelo não recebe tools nem acesso ao cluster: ele só escreve um rascunho, que o servidor valida e compila.' : 'The model gets no tools and no cluster access: it only writes a draft, which the server validates and compiles.'}</Alert>
              </SpaceBetween>
            </Container>
          ),
        },
        {
          title: pt ? 'Tools read-only' : 'Read-only tools',
          description: pt ? 'Escolha do catálogo fechado. Zero tools também vale.' : 'Pick from the closed catalog. Zero tools is also fine.',
          content: (
            <Container header={<Header variant="h2" counter={`(${preferredTools.length}/${toolCatalog.tools.length})`} description={pt ? `Catálogo ${toolCatalog.catalogVersion}, servido por ${toolCatalog.toolServer.kind} ${toolCatalog.toolServer.name}. Só leitura; Secrets são negados pelo RBAC do tool server.` : `Catalog ${toolCatalog.catalogVersion}, served by ${toolCatalog.toolServer.kind} ${toolCatalog.toolServer.name}. Read only; Secrets are denied by the tool server RBAC.`}>{pt ? 'Tools que o agent pode usar' : 'Tools the agent may use'}</Header>}>
              <SpaceBetween size="m">
                {stepAlert}
                <ToolCatalogCards selected={preferredTools} onChange={tools => setPreferredTools(orderByCatalog(tools))} pt={pt} />
                {preferredTools.length === 0 && <Alert type="info">{pt ? 'Sem tools, o agent responde só pela conversa e diz quando a pergunta precisa de dado ao vivo.' : 'Without tools the agent answers only from the conversation and says when a question needs live data.'}</Alert>}
                <Box variant="small" color="text-body-secondary">{pt ? 'Esta lista é a allowlist do contrato. Antes de ligar o builder, um admin confere no cluster que o tool server descobre exatamente estas tools e nenhuma de escrita (pré-condição P2).' : 'This list is the contract allowlist. Before the builder is turned on, an admin checks in the cluster that the tool server discovers exactly these tools and no write tool (precondition P2).'}</Box>
              </SpaceBetween>
            </Container>
          ),
        },
        {
          title: pt ? 'Proposta' : 'Proposal',
          description: pt ? 'O Bedrock escreve o rascunho pelo AI Gateway. Revise, ajuste e peça mudanças.' : 'Bedrock writes the draft through the AI Gateway. Review, adjust and ask for changes.',
          content: (
            <Container
              header={
                <Header variant="h2" actions={<Button variant={draft ? 'normal' : 'primary'} onClick={() => generate(false)} loading={generating} disabled={promptTooLong(composed)}>{draft ? (pt ? 'Gerar de novo' : 'Generate again') : (pt ? 'Gerar proposta' : 'Generate proposal')}</Button>}>
                  {pt ? 'Proposta do agent' : 'Agent proposal'}
                </Header>
              }
            >
              <SpaceBetween size="m">
                {stepAlert}
                {generateError && <ErrorAlert error={generateError} onRetry={() => generate(false)} pt={pt} />}
                {generating && <StatusIndicator type="loading">{pt ? 'O Bedrock está escrevendo o rascunho. Costuma levar de 5 a 20 s.' : 'Bedrock is writing the draft. It usually takes 5 to 20 s.'}</StatusIndicator>}
                {!draft && !generating && (
                  <Box textAlign="center" color="text-status-inactive" padding="l">
                    {pt ? 'Nenhuma proposta ainda. Clique em Gerar proposta: o modelo recebe a descrição, o contexto e as tools escolhidas.' : 'No proposal yet. Click Generate proposal: the model receives the description, context and chosen tools.'}
                  </Box>
                )}
                {draft && (
                  <>
                    {modelValidation && !modelValidation.valid && (
                      <Alert type="warning" header={pt ? `A proposta tem ${modelValidation.errors.length} problema(s)` : `The proposal has ${modelValidation.errors.length} problem(s)`}>
                        {pt ? 'Peça um ajuste abaixo ou edite o JSON. A revisão mostra cada campo com a correção sugerida.' : 'Ask for a change below or edit the JSON. The review lists each field with the suggested fix.'}
                      </Alert>
                    )}
                    {toolsDiffer && (
                      <Alert
                        type="info"
                        header={pt ? 'O modelo escolheu tools diferentes das suas' : 'The model picked different tools than you'}
                        action={<SpaceBetween direction="horizontal" size="xs"><Button onClick={() => applyDraft(withTools(draft, preferredTools))}>{pt ? 'Usar minha seleção' : 'Use my selection'}</Button><Button variant="link" onClick={() => setPreferredTools(orderByCatalog(draft.tools ?? []))}>{pt ? 'Manter a do modelo' : "Keep the model's"}</Button></SpaceBetween>}
                      >
                        {pt ? 'Proposta' : 'Proposal'}: {(draft.tools ?? []).join(', ') || (pt ? 'nenhuma' : 'none')} · {pt ? 'Sua seleção' : 'Your selection'}: {preferredTools.join(', ') || (pt ? 'nenhuma' : 'none')}
                      </Alert>
                    )}
                    <DraftSummary draft={draft} pt={pt} />
                    <FormField label={pt ? 'Pedir um ajuste' : 'Ask for a change'} description={pt ? 'O modelo recebe o rascunho atual e o seu pedido.' : 'The model receives the current draft and your request.'}>
                      <SpaceBetween direction="horizontal" size="xs">
                        <Input value={refinement} onChange={({ detail }) => setRefinement(detail.value)} placeholder={pt ? 'Ex.: responda em tópicos curtos' : 'E.g. answer in short bullet points'} ariaLabel={pt ? 'Pedido de ajuste' : 'Change request'} onKeyDown={({ detail }) => { if (detail.key === 'Enter' && refinement.trim()) void generate(true); }} />
                        <Button onClick={() => generate(true)} disabled={!refinement.trim() || generating}>{pt ? 'Ajustar' : 'Refine'}</Button>
                      </SpaceBetween>
                    </FormField>
                    <ExpandableSection headerText={pt ? 'Editar o JSON do rascunho' : 'Edit the draft JSON'}>
                      <SpaceBetween size="xs">
                        <FormField errorText={draftTextError || undefined} description={pt ? 'Edição livre. O servidor valida tudo na revisão; nada aqui chega ao cluster.' : 'Free editing. The server validates everything in the review; nothing here reaches the cluster.'}>
                          <Textarea value={draftText} onChange={({ detail }) => { setDraftText(detail.value); setDraftTextError(''); }} rows={16} ariaLabel={pt ? 'JSON do rascunho' : 'Draft JSON'} />
                        </FormField>
                        <Button onClick={() => { const parsed = parseDraftJson(draftText, pt); if (parsed.ok) applyDraft(parsed.draft); else setDraftTextError(parsed.error); }}>{pt ? 'Aplicar edição' : 'Apply edit'}</Button>
                      </SpaceBetween>
                    </ExpandableSection>
                    {sources.length > 0 && <Box variant="small" color="text-body-secondary">{pt ? `Grounding: ${sources.length} documento(s) da Knowledge Base de agents.` : `Grounding: ${sources.length} document(s) from the agents Knowledge Base.`}</Box>}
                  </>
                )}
              </SpaceBetween>
            </Container>
          ),
        },
        {
          title: pt ? 'Revisar e enviar' : 'Review and submit',
          description: pt ? 'Veredito da policy, manifest compilado e diff. Enviar abre um MR; não aplica nada.' : 'Policy verdict, compiled manifest and diff. Submitting opens an MR; it applies nothing.',
          content: (
            <SpaceBetween size="l">
              {stepAlert}
              <Container header={<Header variant="h2" actions={<Button iconName="refresh" onClick={runPreview} loading={previewing} disabled={!draft}>{pt ? 'Validar de novo' : 'Validate again'}</Button>}>{pt ? 'Veredito da policy' : 'Policy verdict'}</Header>}>
                <SpaceBetween size="m">
                  {previewing && <StatusIndicator type="loading">{pt ? 'Validando e compilando no servidor…' : 'Validating and compiling on the server…'}</StatusIndicator>}
                  {previewError && <ErrorAlert error={previewError} onRetry={runPreview} pt={pt} />}
                  {preview && !previewing && <PolicyVerdict valid={preview.valid && submitIssues.length === 0} errors={submitIssues.length ? submitIssues : preview.errors} warnings={preview.warnings} pt={pt} />}
                  {preview && !previewFresh && !previewing && <Alert type="warning">{pt ? 'O rascunho mudou depois desta validação. Valide de novo antes de enviar.' : 'The draft changed after this validation. Validate again before submitting.'}</Alert>}
                  {preview?.valid && <PreviewFacts preview={preview} pt={pt} />}
                </SpaceBetween>
              </Container>
              {preview?.valid && preview.manifest && (
                <Container header={<Header variant="h2" description={pt ? 'Bytes exatos que o CI recompila e compara antes de abrir o MR.' : 'The exact bytes CI recompiles and compares before opening the MR.'}>{pt ? 'Manifest compilado' : 'Compiled manifest'}</Header>}>
                  <ManifestDiff key={preview.draftSha256} before={previousManifest} after={preview.manifest} pt={pt} />
                </Container>
              )}
              {draft && <ExpandableSection variant="container" headerText={pt ? 'Rascunho que será enviado' : 'Draft to be submitted'}><DraftSummary draft={draft} pt={pt} /></ExpandableSection>}
              {submitError && <ErrorAlert error={submitError} onRetry={submit} pt={pt} />}
              <Alert type="info" header={pt ? 'O que acontece ao enviar' : 'What happens on submit'}>
                {pt ? 'O portal registra o pedido. O CI recompila o rascunho, confere os bytes e a policy e abre um MR em ' : 'The portal records the request. CI recompiles the draft, checks the bytes and the policy, and opens an MR on '}
                <Link href={gitMergeRequestsUrl('label_name[]=agent-builder')} external>GitLab</Link>
                {pt ? '. Depois do review e do merge, o Argo CD aplica o Agent e você acompanha aqui até o teste A2A.' : '. After review and merge, Argo CD applies the Agent and you follow it here up to the A2A test.'}
              </Alert>
            </SpaceBetween>
          ),
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------- lista de agents do builder

function BuilderAgentsTable({ pt, active, alias, onOpen, onCreate }: {
  pt: boolean;
  active: boolean;
  alias: string;
  onOpen: (name: string) => void;
  onCreate: () => void;
}): JSX.Element {
  const { data, loading, error, reload } = useBuilderAgents(pt, active);
  const now = Date.now() / 1000;
  const argo = data?.argo;
  return (
    <SpaceBetween size="m">
      {error && <ErrorAlert error={error} onRetry={reload} pt={pt} />}
      <Table<BuilderAgent>
        loading={loading}
        loadingText={pt ? 'Lendo os agents do namespace kagent…' : 'Reading agents in the kagent namespace…'}
        items={data?.agents ?? []}
        trackBy="name"
        header={
          <Header
            variant="h2"
            counter={data ? `(${data.agents.length})` : undefined}
            description={argo ? `Argo CD ${argo.application}: sync ${argo.sync}, health ${argo.health}` : (pt ? 'Só agents criados pelo builder (label managed-by: agent-builder).' : 'Only agents created by the builder (label managed-by: agent-builder).')}
            actions={<Button iconName="refresh" onClick={reload} loading={loading} ariaLabel={pt ? 'Recarregar a lista' : 'Reload the list'}>{pt ? 'Atualizar' : 'Refresh'}</Button>}
          >
            {pt ? 'Agents do builder' : 'Builder agents'}
          </Header>
        }
        columnDefinitions={[
          { id: 'name', header: pt ? 'Agent' : 'Agent', cell: a => <Link onFollow={event => { event.preventDefault(); onOpen(a.name); }} href={`#agent-builder/${a.name}`}>{a.displayName || a.name}</Link> },
          { id: 'tech', header: pt ? 'Nome técnico' : 'Technical name', cell: a => <code>{a.name}</code> },
          { id: 'requester', header: pt ? 'Pedido por' : 'Requested by', cell: a => (a.requester === alias ? `${a.requester} (${pt ? 'você' : 'you'})` : a.requester) },
          { id: 'phase', header: pt ? 'Estado' : 'State', cell: a => <PhaseCell phase={agentBuilderPhase('create', null, toPhaseAgent(a), null, now)} pt={pt} /> },
          { id: 'argo', header: 'Argo CD', cell: a => <StatusIndicator type={a.argoTracked ? 'success' : 'warning'}>{a.argoTracked ? (pt ? 'sob controle do Git' : 'tracked from Git') : (pt ? 'fora do Git' : 'outside Git')}</StatusIndicator> },
        ]}
        empty={
          <Box textAlign="center" padding="l">
            <SpaceBetween size="s">
              <b>{pt ? 'Nenhum agent do builder ainda' : 'No builder agents yet'}</b>
              <span>{pt ? 'Quando um pedido for mergeado e o Argo CD aplicar, o agent aparece aqui.' : 'Once a request is merged and Argo CD applies it, the agent shows up here.'}</span>
              <Button onClick={onCreate}>{pt ? 'Criar o primeiro' : 'Create the first one'}</Button>
            </SpaceBetween>
          </Box>
        }
      />
    </SpaceBetween>
  );
}
