/*
 * Página Times (backlog ownership-model): quem é dono do quê e como falar com ele.
 *
 * Um card por time do registry: contatos (PhoneTool), canal do Slack, on-call, os projetos que o
 * time é dono e quantos recursos vivos existem neles (lidos da cluster-api agora, prontos/total). O
 * registry é a fonte do ownership; o cluster é a fonte das contagens. Falha de leitura aparece como
 * falha, não como zero.
 */
import { useEffect, useRef, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useI18n } from './i18n';
import { InventoryError, listInstances } from './kdpInventoryApi';
import { PHONETOOL } from './ownership';
import type { ProjectScope } from './scope/useProjectScope';
import type { ScopeProject, ScopeTeam } from './scope/scopeModel';

export interface TeamsPageProps {
  scope: ProjectScope;
  onNavigateView(view: 'catalog'): void;
}

/** Contagem por projeto: `null` enquanto carrega; `error` quando a fonte falhou. */
export type ProjectCount = { status: 'loading' } | { status: 'ready'; total: number; ready: number } | { status: 'error'; message: string };

/** Projetos de um time, pelo `owner.team` do registry. */
export function projectsOf(team: ScopeTeam, projects: readonly ScopeProject[]): ScopeProject[] {
  return projects.filter(project => project.owner.team === team.id && project.lifecycle.state !== 'retired');
}

export function countText(count: ProjectCount | undefined, pt: boolean): string {
  if (!count || count.status === 'loading') return pt ? 'lendo…' : 'reading…';
  if (count.status === 'error') return pt ? `falha: ${count.message}` : `failed: ${count.message}`;
  return `${count.ready}/${count.total} ${pt ? 'prontos' : 'ready'}`;
}

async function countProject(project: ScopeProject, signal: AbortSignal): Promise<ProjectCount> {
  try {
    let total = 0;
    let ready = 0;
    for (const namespace of project.namespaces) {
      const [all, up] = await Promise.all([
        listInstances({ namespace, limit: 1 }, signal),
        listInstances({ namespace, limit: 1, ready: 'true' }, signal),
      ]);
      if (all.partial || up.partial) return { status: 'error', message: pt_error(all.sources.concat(up.sources)) };
      total += all.total;
      ready += up.total;
    }
    return { status: 'ready', total, ready };
  } catch (cause) {
    if (cause instanceof InventoryError && cause.aborted) return { status: 'loading' };
    return { status: 'error', message: cause instanceof Error ? cause.message : 'cluster API unavailable' };
  }
}

function pt_error(sources: { ok: boolean; source: string; error: string }[]): string {
  const failed = sources.filter(source => !source.ok);
  return failed.length ? `${failed[0].source} (${failed[0].error})` : 'partial read';
}

export function TeamsPage({ scope, onNavigateView }: TeamsPageProps): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [counts, setCounts] = useState<Record<string, ProjectCount>>({});
  const gate = useRef(new AbortController());
  const loaded = scope.state.status === 'loaded' ? scope.state.context : null;
  const teams = loaded?.teams ?? [];
  const projects = loaded?.projects ?? [];
  const projectKey = projects.map(project => project.id).join(',');

  useEffect(() => {
    gate.current.abort();
    const controller = new AbortController();
    gate.current = controller;
    if (!loaded) return;
    setCounts(Object.fromEntries(projects.map(project => [project.id, { status: 'loading' } as ProjectCount])));
    for (const project of projects) {
      void countProject(project, controller.signal).then(count => {
        if (!controller.signal.aborted) setCounts(current => ({ ...current, [project.id]: count }));
      });
    }
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded !== null, projectKey]);

  const external = pt ? 'Abre em nova aba' : 'Opens in a new tab';

  return (
    <ContentLayout
      header={(
        <Header
          variant="h1"
          counter={loaded ? `(${teams.length})` : undefined}
          description={pt
            ? 'Quem é dono de cada projeto e como falar com o time: contatos, canal e on-call vêm do registry GitOps (platform/scope/registry.json); as contagens vêm do cluster agora.'
            : 'Who owns each project and how to reach the team: contacts, channel and on-call come from the GitOps registry (platform/scope/registry.json); counts are read from the cluster now.'}
          actions={<Button iconName="refresh" onClick={scope.retry}>{pt ? 'Atualizar' : 'Refresh'}</Button>}
        >
          {pt ? 'Times' : 'Teams'}
        </Header>
      )}
    >
      {scope.state.status === 'error' && (
        <Box color="text-status-error">{pt ? 'Não foi possível ler o registry de escopo: ' : 'The scope registry could not be read: '}{scope.state.error.message}</Box>
      )}
      <Cards<ScopeTeam>
        items={teams}
        trackBy="id"
        loading={scope.state.status === 'loading'}
        loadingText={pt ? 'Lendo o registry' : 'Reading the registry'}
        ariaLabels={{ itemSelectionLabel: (_, item) => item.name, selectionGroupLabel: pt ? 'Times' : 'Teams' }}
        cardsPerRow={[{ cards: 1 }, { minWidth: 900, cards: 2 }]}
        cardDefinition={{
          header: item => <Header variant="h2" description={item.description || undefined}>{item.name}</Header>,
          sections: [
            {
              id: 'contact',
              header: pt ? 'Contato' : 'Contact',
              content: item => (
                <KeyValuePairs columns={3} items={[
                  {
                    label: pt ? 'Pessoas' : 'People',
                    value: item.contacts.length
                      ? <SpaceBetween direction="horizontal" size="xs">{item.contacts.map(alias => <Link key={alias} href={`${PHONETOOL}${alias}`} external externalIconAriaLabel={external}>{alias}</Link>)}</SpaceBetween>
                      : '-',
                  },
                  { label: 'Slack', value: item.slack.url ? <Link href={item.slack.url} external externalIconAriaLabel={external}>{item.slack.channel || item.slack.url}</Link> : (pt ? 'não declarado' : 'not declared') },
                  { label: 'On-call', value: item.oncall ? <Link href={item.oncall} external externalIconAriaLabel={external}>{pt ? 'abrir' : 'open'}</Link> : (pt ? 'não declarado' : 'not declared') },
                ]} />
              ),
            },
            {
              id: 'projects',
              header: pt ? 'Projetos e recursos' : 'Projects and resources',
              content: item => {
                const owned = projectsOf(item, projects);
                if (owned.length === 0) return <Box color="text-body-secondary">{pt ? 'Nenhum projeto aponta para este time.' : 'No project points to this team.'}</Box>;
                return (
                  <SpaceBetween size="s">
                    {owned.map(project => {
                      const count = counts[project.id];
                      return (
                        <KeyValuePairs key={project.id} columns={3} items={[
                          { label: pt ? 'Projeto' : 'Project', value: <span>{project.name} <Box variant="small" display="inline">({project.namespaces.join(', ')})</Box></span> },
                          { label: pt ? 'Contato do projeto' : 'Project contact', value: <Link href={`${PHONETOOL}${project.owner.contact}`} external externalIconAriaLabel={external}>{project.owner.contact}</Link> },
                          {
                            label: pt ? 'Recursos vivos' : 'Live resources',
                            value: count?.status === 'error'
                              ? <StatusIndicator type="error">{countText(count, pt)}</StatusIndicator>
                              : <Link href="#catalog" onFollow={event => { event.preventDefault(); onNavigateView('catalog'); }}>{countText(count, pt)}</Link>,
                          },
                        ]} />
                      );
                    })}
                  </SpaceBetween>
                );
              },
            },
          ],
        }}
        empty={<Box textAlign="center" color="text-body-secondary">{pt ? 'O registry não declara times. Adicione `teams` em platform/scope/registry.json e aponte `owner.team` dos projetos para eles.' : 'The registry declares no teams. Add `teams` to platform/scope/registry.json and point the projects `owner.team` at them.'}</Box>}
      />
    </ContentLayout>
  );
}
