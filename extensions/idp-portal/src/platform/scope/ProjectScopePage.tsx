/*
 * Página isolável de contexto do projeto (issue #10), com o próprio hook. O shell usa
 * `ProjectContextPage` (devPlatformPages.tsx) em `#project`, que recebe o escopo que o shell já
 * resolveu, para não ler GET /platform/scope duas vezes. Esta continua útil fora do shell.
 */
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useI18n } from '../i18n';
import { ProjectDetails, ProjectScopeSelector } from './ProjectScopeParts';
import { useProjectScope } from './useProjectScope';

export function ProjectScopePage(): JSX.Element {
  const { locale } = useI18n();
  const scope = useProjectScope();
  const pt = locale === 'pt-BR';
  const ready = scope.state.status === 'loaded' && scope.selection?.status === 'ready' ? scope.selection.project : null;
  return (
    <ContentLayout header={<Header variant="h1" description={pt ? 'Organização, projeto, ambiente e namespace que o servidor aplica às suas views.' : 'Organization, project, environment and namespace the server applies to your views.'}>{pt ? 'Contexto do projeto' : 'Project context'}</Header>}>
      <SpaceBetween size="l">
        <ProjectScopeSelector state={scope.state} selection={scope.selection} locale={locale} onRetry={scope.retry} onSelect={scope.select} />
        {ready && scope.state.status === 'loaded' && <ProjectDetails project={ready} context={scope.state.context} locale={locale} />}
      </SpaceBetween>
    </ContentLayout>
  );
}
