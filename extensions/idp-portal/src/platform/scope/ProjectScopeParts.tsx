/*
 * Peças de UI do escopo de projeto (issue #10). Todas recebem estado por props, então renderizam
 * em teste sem rede e sem router; quem liga ao estado real é `ProjectScopePage` pelo hook.
 *
 * Estados distintos, cada um com texto próprio, porque nenhum deles é "vazio":
 *   loading   lendo GET /platform/scope
 *   error     403 (sessão sem acesso), 503 (registry indisponível), 0 (rede): com "tentar de novo"
 *   empty     a sessão é válida e não participa de projeto nenhum
 *   not-found projeto da URL não existe OU o caller não tem acesso (o servidor responde igual)
 */
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { Locale } from '../i18n';
import type { ScopeLoadState } from './useProjectScope';
import { needsSelector, ScopeContext, ScopeProject, ScopeRole, ScopeSelection } from './scopeModel';

const ROLE_LABEL: Record<ScopeRole, { pt: string; en: string }> = {
  viewer: { pt: 'leitura', en: 'viewer' },
  contributor: { pt: 'contribuidor', en: 'contributor' },
  admin: { pt: 'admin', en: 'admin' },
};

function promotesToText(project: ScopeProject, context: ScopeContext, pt: boolean): string {
  if (!project.promotesTo) return pt ? 'Ambiente terminal (sem promoção)' : 'Terminal environment (no promotion)';
  const target = context.projects.find((p) => p.id === project.promotesTo);
  if (!target) return pt ? `${project.promotesTo} (projeto não visível para você)` : `${project.promotesTo} (project not visible to you)`;
  return `${target.environment.name || target.environment.id} · ${target.name} (${target.namespaces.join(', ')})`;
}

export function RoleBadge({ role, locale }: { role: ScopeRole; locale: Locale }): JSX.Element {
  // Texto do papel, nunca só cor (acessibilidade).
  return <Badge color={role === 'admin' ? 'red' : 'grey'}>{locale === 'pt-BR' ? ROLE_LABEL[role].pt : ROLE_LABEL[role].en}</Badge>;
}

function errorText(status: number, pt: boolean): { header: string; body: string } {
  if (status === 403) return { header: pt ? 'Sem acesso à plataforma' : 'No platform access', body: pt ? 'Sua sessão não está autorizada. Peça acesso ao time platform-team.' : 'Your session is not authorized. Ask the platform-team team for access.' };
  if (status === 503) return { header: pt ? 'Escopo indisponível' : 'Scope unavailable', body: pt ? 'O registry de projetos não está disponível neste deploy. Nenhuma view com escopo é servida até ele voltar.' : 'The project registry is not available in this deployment. No scoped view is served until it is back.' };
  if (status === 0) return { header: pt ? 'Sem conexão com a platform-api' : 'Cannot reach the platform API', body: pt ? 'A leitura do contexto falhou antes da resposta.' : 'Reading the context failed before any response.' };
  return { header: pt ? 'Falha ao ler o contexto' : 'Failed to read the context', body: `HTTP ${status}` };
}

export interface ScopeStateProps {
  state: ScopeLoadState;
  selection: ScopeSelection | null;
  locale: Locale;
  onRetry(): void;
  /** Com ele, o aviso de projeto obrigatório (strict) já traz o seletor: é acionável no lugar. */
  onChooseProject?(project: string): void;
}

/** Em `strict` o servidor recusa toda rota com escopo sem projeto: um aviso só, antes das falhas. */
export function strictProjectMissing(state: ScopeLoadState, selection: ScopeSelection | null): boolean {
  return state.status === 'loaded' && state.context.enforcement === 'strict' && selection?.status === 'unselected';
}

/** Loading, erro e vazio: o que aparece antes de haver um projeto para mostrar. */
export function ScopeStateNotice({ state, selection, locale, onRetry, onChooseProject }: ScopeStateProps): JSX.Element | null {
  const pt = locale === 'pt-BR';
  if (state.status === 'loaded' && strictProjectMissing(state, selection)) {
    const projects = state.context.projects.filter(project => project.lifecycle.state !== 'retired');
    return (
      <Alert type="warning" header={pt ? 'Escolha um projeto para continuar' : 'Choose a project to continue'}>
        <SpaceBetween size="s">
          <span>{pt
            ? 'Este deploy exige um projeto em toda leitura e escrita com escopo. Sem ele, cada bloco desta tela responde "project scope is required".'
            : 'This deployment requires a project on every scoped read and write. Without one, every block on this screen answers "project scope is required".'}</span>
          {onChooseProject && (
            <FormField label={pt ? 'Projeto' : 'Project'}>
              <Select selectedOption={null} placeholder={pt ? 'Escolha um projeto' : 'Choose a project'}
                options={projects.map(project => ({ value: project.id, label: project.name, description: project.namespaces.join(', ') }))}
                onChange={({ detail }) => detail.selectedOption.value && onChooseProject(detail.selectedOption.value)} />
            </FormField>
          )}
        </SpaceBetween>
      </Alert>
    );
  }
  if (state.status === 'loading') return <StatusIndicator type="loading">{pt ? 'Carregando projetos' : 'Loading projects'}</StatusIndicator>;
  if (state.status === 'error') {
    const text = errorText(state.error.status, pt);
    return <Alert type="error" header={text.header} action={<Button onClick={onRetry}>{pt ? 'Tentar de novo' : 'Retry'}</Button>}>{text.body}</Alert>;
  }
  if (selection?.status === 'empty') {
    return <Box textAlign="center" color="text-body-secondary">{pt ? 'Você ainda não participa de nenhum projeto da plataforma.' : 'You are not a member of any platform project yet.'}</Box>;
  }
  if (selection?.status === 'not-found') {
    return <Alert type="warning" header={pt ? 'Projeto não encontrado' : 'Project not found'}>{pt ? `O projeto "${selection.requested}" não existe ou você não tem acesso a ele.` : `Project "${selection.requested}" does not exist or you have no access to it.`}</Alert>;
  }
  if (selection?.status === 'namespace-out-of-scope') {
    return <Alert type="warning" header={pt ? 'Namespace fora do projeto' : 'Namespace outside the project'}>{pt ? `"${selection.requested}" não pertence ao projeto ${selection.project.name}.` : `"${selection.requested}" does not belong to project ${selection.project.name}.`}</Alert>;
  }
  return null;
}

export interface ScopeSelectorProps extends ScopeStateProps {
  onSelect(project: string, namespace?: string): void;
}

/** Seletor de projeto e namespace. Com um projeto só, mostra o contexto sem seletor. */
export function ProjectScopeSelector(props: ScopeSelectorProps): JSX.Element {
  const { state, selection, locale, onSelect } = props;
  const pt = locale === 'pt-BR';
  // O seletor logo abaixo já é a ação do aviso de projeto obrigatório: aqui ele não se repete.
  const notice = strictProjectMissing(state, selection) ? null : <ScopeStateNotice {...props} />;
  if (state.status !== 'loaded' || !selection || selection.status === 'empty') return notice ?? <></>;
  const context = state.context;
  const current = selection.status === 'ready' || selection.status === 'namespace-out-of-scope' ? selection.project : null;
  if (!needsSelector(context) && selection.status === 'ready') {
    return <ScopeContextSummary context={context} selection={selection} locale={locale} />;
  }
  const projects = context.projects.filter(project => project.lifecycle.state !== 'retired');
  const namespace = selection.status === 'ready' ? selection.namespace : null;
  return (
    <SpaceBetween size="s">
      {notice}
      <SpaceBetween direction="horizontal" size="s">
        <FormField label={pt ? 'Projeto' : 'Project'}>
          <Select
            selectedOption={current ? { value: current.id, label: current.name } : null}
            placeholder={pt ? 'Escolha um projeto' : 'Choose a project'}
            options={projects.map(project => ({ value: project.id, label: project.name, description: project.namespaces.join(', ') }))}
            onChange={({ detail }) => detail.selectedOption.value && onSelect(detail.selectedOption.value)}
          />
        </FormField>
        {current && current.namespaces.length > 1 && (
          <FormField label="Namespace">
            <Select
              selectedOption={namespace ? { value: namespace, label: namespace } : null}
              placeholder={pt ? 'Escolha um namespace' : 'Choose a namespace'}
              options={current.namespaces.map(ns => ({ value: ns, label: ns }))}
              onChange={({ detail }) => detail.selectedOption.value && onSelect(current.id, detail.selectedOption.value)}
            />
          </FormField>
        )}
      </SpaceBetween>
    </SpaceBetween>
  );
}

/** Contexto atual para o menu do usuário: organização, projeto, namespace, ambiente e papel. */
export function ScopeContextSummary({ context, selection, locale }: { context: ScopeContext; selection: ScopeSelection; locale: Locale }): JSX.Element {
  const pt = locale === 'pt-BR';
  if (selection.status !== 'ready') {
    return <Box variant="small" color="text-body-secondary">{context.organization.name} · {pt ? 'nenhum projeto selecionado' : 'no project selected'}</Box>;
  }
  const { project, namespace } = selection;
  return (
    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
      <Box variant="small">{context.organization.name} / {project.name} / {namespace ?? (pt ? 'todos os namespaces' : 'all namespaces')} · {project.environment.name || project.environment.id}</Box>
      <RoleBadge role={project.role} locale={locale} />
    </SpaceBetween>
  );
}

/** Ownership, quota e lifecycle do projeto, com o que o portal NÃO oferece (kubeconfig). */
export function ProjectDetails({ project, context, locale }: { project: ScopeProject; context: ScopeContext; locale: Locale }): JSX.Element {
  const pt = locale === 'pt-BR';
  const lifecycle = { active: pt ? 'ativo' : 'active', 'read-only': pt ? 'somente leitura' : 'read-only', retired: pt ? 'aposentado' : 'retired' }[project.lifecycle.state];
  const quota = project.quota.maxInstances === null
    ? (pt ? 'Não definida' : 'Not defined')
    : `${project.quota.maxInstances} ${pt ? 'instâncias' : 'instances'}${project.quota.enforced ? '' : pt ? ' (declarada, não aplicada)' : ' (declared, not enforced)'}`;
  return (
    <Container header={<Header variant="h2" description={project.description} actions={<RoleBadge role={project.role} locale={locale} />}>{project.name}</Header>}>
      <SpaceBetween size="m">
        <KeyValuePairs columns={3} items={[
          { label: pt ? 'Organização' : 'Organization', value: context.organization.name },
          { label: pt ? 'Ambiente' : 'Environment', value: `${project.environment.name || project.environment.id} (${project.environment.cluster}, ${project.environment.region})` },
          { label: 'Namespaces', value: project.namespaces.join(', ') },
          { label: 'Owner', value: `${project.owner.team} (${project.owner.contact})` },
          { label: 'Argo CD AppProject', value: project.appProject },
          { label: pt ? 'Diretório GitOps' : 'GitOps directory', value: project.gitopsPath },
          { label: 'Lifecycle', value: lifecycle },
          { label: 'Quota', value: quota },
          { label: 'Argo CD Applications', value: project.argoApplications.join(', ') || '-' },
          // environments-promotion: para onde uma instância deste projeto é promovida (registry `promotesTo`).
          { label: pt ? 'Promove para' : 'Promotes to', value: promotesToText(project, context, pt) },
        ]} />
        {!context.kubeconfig.offered && (
          <Box variant="small" color="text-body-secondary">
            {pt ? 'O portal não oferece kubeconfig (ADR-0009). Acesso ao cluster é pelas views do portal, com o escopo deste projeto aplicado no servidor.' : 'The portal does not offer a kubeconfig (ADR-0009). Cluster access goes through the portal views, with this project scope enforced server-side.'}
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
}
