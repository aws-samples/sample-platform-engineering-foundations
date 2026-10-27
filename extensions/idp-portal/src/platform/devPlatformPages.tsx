/*
 * Páginas da Developer Platform que o shell monta: Service Owner Studio (#11), Platform Assistant
 * (#12) e o contexto do projeto (#10). Os componentes de cada frente seguem isolados nas pastas
 * deles; aqui fica só a cola: a flag do deploy, o escopo que o shell já resolveu e o estado de cada
 * uma dessas coisas visível na tela.
 *
 * Nada aqui decide autorização. Papel e lifecycle viram dica de UI (esconder o que o servidor
 * recusaria); a decisão é da platform-api e do CI, com o alias que o the internal gateway assinou.
 */
import { useEffect, useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { getAgentBuilderMe } from './agentBuilderApi';
import { errorMessage } from './errors';
import { createAssistantClient } from './assistant/assistantApi';
import { PlatformAssistant } from './assistant/PlatformAssistant';
import { ServiceOwnerStudio } from './serviceStudio/ServiceOwnerStudio';
import { ProjectDetails, ProjectScopeSelector } from './scope/ProjectScopeParts';
import { canPropose, ScopeProject } from './scope/scopeModel';
import type { ProjectScope } from './scope/useProjectScope';
import type { Locale } from './i18n';

export type Feature = 'serviceStudio' | 'platformAssistant' | 'composableDashboard';
type FeatureState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'loaded'; enabled: boolean };

/** Diretório GitOps em que o Assistant escreve: projetos com outro diretório não são elegíveis. */
export const ASSISTANT_GITOPS_PATH = 'platform/instances';

export function assistantEligible(project: ScopeProject): boolean {
  return project.gitopsPath === ASSISTANT_GITOPS_PATH && project.namespaces.length === 1 && project.lifecycle.state !== 'retired';
}

/** Lê `features` de GET /platform/me. Desligado é um estado da tela, não um erro. */
export function useFeature(feature: Feature, load: typeof getAgentBuilderMe = getAgentBuilderMe): FeatureState {
  const [state, setState] = useState<FeatureState>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    load()
      .then(me => { if (active) setState({ status: 'loaded', enabled: me.features?.[feature] === true }); })
      .catch(cause => { if (active) setState({ status: 'error', message: errorMessage(cause, 'platform API unavailable') }); });
    return () => { active = false; };
  }, [feature, load]);
  return state;
}

export function FeatureNotice({ state, name, pt }: { state: FeatureState; name: string; pt: boolean }): JSX.Element | null {
  if (state.status === 'loading') return <StatusIndicator type="loading">{pt ? 'Verificando se o recurso está ligado neste deploy' : 'Checking whether this is enabled in this deployment'}</StatusIndicator>;
  if (state.status === 'error') return <Alert type="error" header={pt ? 'Não foi possível ler as flags do deploy' : 'Could not read the deployment flags'}>{state.message}</Alert>;
  if (!state.enabled) {
    return <Alert type="info" header={pt ? `${name} está desligado neste deploy` : `${name} is disabled in this deployment`}>
      {pt ? 'As rotas respondem 404 e nada é gravado até a flag ser ligada pela equipe da plataforma.' : 'The routes answer 404 and nothing is recorded until the platform team turns the flag on.'}
    </Alert>;
  }
  return null;
}

export function ServiceStudioPage({ locale, requestId, onRequested }: {
  locale: Locale; requestId: string | null; onRequested(requestId: string): void;
}): JSX.Element {
  const pt = locale === 'pt-BR';
  const feature = useFeature('serviceStudio');
  return (
    <ContentLayout header={<Header variant="h1" description={pt
      ? 'Para Service Owners: descreva, importe ou evolua uma capability do catálogo. O modelo só propõe; o contrato valida, você revisa o diff e o MR publica.'
      : 'For Service Owners: describe, import or evolve a catalog capability. The model only proposes; the contract validates, you review the diff and the MR publishes.'}>
      Service Owner Studio</Header>}>
      <SpaceBetween size="l">
        <FeatureNotice state={feature} name="Service Owner Studio" pt={pt} />
        {feature.status === 'loaded' && feature.enabled && <>
          <Box variant="small" color="text-body-secondary">{pt
            ? 'O escopo aqui é o owner team do package, não o projeto: a capability vai para platform/catalog/ e vale para todos os projetos depois do merge.'
            : 'The scope here is the package owner team, not the project: the capability goes to platform/catalog/ and serves every project after the merge.'}</Box>
          <ServiceOwnerStudio requestId={requestId} onRequested={onRequested} />
        </>}
      </SpaceBetween>
    </ContentLayout>
  );
}

/**
 * `planId` vem da rota `#assistant/<planId>`: reload e deep link reabrem o plano pelo servidor
 * (`client.get`), com timeline, retry e rollback. `onPlanOpened` escreve o id na URL após o envio.
 */
export function PlatformAssistantPage({ scope, locale, onSelectProject, planId, onPlanOpened }: {
  scope: ProjectScope; locale: Locale; onSelectProject(project: string): void;
  planId: string | null; onPlanOpened(planId: string | null): void;
}): JSX.Element {
  const pt = locale === 'pt-BR';
  const feature = useFeature('platformAssistant');
  const client = useMemo(() => createAssistantClient(), []);
  const context = scope.state.status === 'loaded' ? scope.state.context : null;
  const eligible = (context?.projects ?? []).filter(assistantEligible);
  const selected = scope.selection?.status === 'ready' ? scope.selection.project : null;
  const project = selected && assistantEligible(selected) ? selected : null;
  return (
    <ContentLayout header={<Header variant="h1" description={pt
      ? 'Descreva o que precisa. O assistant monta um plano com vários recursos, você revisa e confirma, e cada passo vira pedido, MR e GitOps até Ready.'
      : 'Describe what you need. The assistant builds a multi-resource plan, you review and confirm, and each step becomes a request, an MR and GitOps until Ready.'}>
      Platform Assistant</Header>}>
      <SpaceBetween size="l">
        <FeatureNotice state={feature} name="Platform Assistant" pt={pt} />
        {feature.status === 'loaded' && feature.enabled && <>
          {/* Loading, erro e projeto ausente já aparecem uma vez, nas notifications do shell. */}
          {context && !project && !planId && (
            <Alert type="info" header={pt ? 'Escolha o projeto do plano' : 'Choose the project of the plan'}>
              <SpaceBetween size="s">
                <span>{selected
                  ? (pt ? `O projeto ${selected.name} escreve em ${selected.gitopsPath}; o assistant cria instâncias em ${ASSISTANT_GITOPS_PATH}.` : `Project ${selected.name} writes ${selected.gitopsPath}; the assistant creates instances in ${ASSISTANT_GITOPS_PATH}.`)
                  : (pt ? 'O plano é sempre de um projeto: é nele que o servidor autoriza e grava.' : 'A plan always belongs to one project: that is where the server authorizes and records it.')}</span>
                {eligible.length > 0
                  ? <FormField label={pt ? 'Projeto' : 'Project'}>
                      <Select selectedOption={null} placeholder={pt ? 'Escolha um projeto' : 'Choose a project'}
                        options={eligible.map(p => ({ value: p.id, label: p.name, description: p.namespaces.join(', ') }))}
                        onChange={({ detail }) => detail.selectedOption.value && onSelectProject(detail.selectedOption.value)} />
                    </FormField>
                  : <Box color="text-body-secondary">{pt ? 'Nenhum projeto seu aceita planos do assistant.' : 'None of your projects accepts assistant plans.'}</Box>}
              </SpaceBetween>
            </Alert>
          )}
          {project && !canPropose(project) && (
            <Alert type="warning" header={pt ? 'Seu papel aqui é de leitura' : 'Your role here is read-only'}>
              {pt ? 'Você pode montar e revisar o plano; o envio será recusado pelo servidor.' : 'You can build and review the plan; submitting it will be refused by the server.'}
            </Alert>
          )}
          {/* key: trocar de projeto (depois da confirmação do shell) descarta o plano em edição. */}
          {(project || planId) && <PlatformAssistant key={project?.id ?? '_plan'} project={project?.id ?? null} client={client} pt={pt}
            planId={planId} onPlanOpened={onPlanOpened} />}
        </>}
      </SpaceBetween>
    </ContentLayout>
  );
}

export function ProjectContextPage({ scope, locale }: { scope: ProjectScope; locale: Locale }): JSX.Element {
  const pt = locale === 'pt-BR';
  const ready = scope.state.status === 'loaded' && scope.selection?.status === 'ready' ? scope.selection.project : null;
  return (
    <ContentLayout header={<Header variant="h1" description={pt
      ? 'Organização, projeto, ambiente e namespace que o servidor aplica às suas views.'
      : 'Organization, project, environment and namespace the server applies to your views.'}
      actions={scope.state.status === 'error' ? <Button onClick={scope.retry}>{pt ? 'Tentar de novo' : 'Retry'}</Button> : undefined}>
      {pt ? 'Contexto do projeto' : 'Project context'}</Header>}>
      <SpaceBetween size="l">
        <ProjectScopeSelector state={scope.state} selection={scope.selection} locale={locale} onRetry={scope.retry} onSelect={scope.select} />
        {ready && scope.state.status === 'loaded' && <ProjectDetails project={ready} context={scope.state.context} locale={locale} />}
        {scope.state.status === 'loaded' && scope.selection?.status === 'unselected' && (
          <Box color="text-body-secondary">{pt
            ? 'Nenhum projeto selecionado: as views mostram todos os projetos que você enxerga. O servidor só aceita isso para quem enxerga todos.'
            : 'No project selected: the views show every project you can see. The server only accepts that for callers who see all of them.'}</Box>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
