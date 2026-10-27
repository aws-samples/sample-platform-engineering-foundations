/*
 * Peças de UI do inventário live (issues #8 e #9). Separadas das páginas por um
 * motivo testável: cada peça é uma função de props para markup, então os estados
 * que importam - carregando, erro, vazio, provisionando, pronto, desatualizado -
 * são verificáveis por render estático, sem browser e sem fixture de dado falso
 * embutida no produto.
 *
 * Duas regras atravessam o arquivo:
 *  - todo status sai como texto MAIS ícone (StatusIndicator), nunca só cor; o
 *    operador é daltônico e um badge colorido sozinho não comunica.
 *  - erro de leitura nunca se parece com lista vazia: são componentes distintos,
 *    com texto distinto, e o vazio sempre aponta para Create.
 */
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import type { ConditionRow, InstanceDetail, InstanceTrail, LiveSource } from './kdpInventoryApi';
import type { CopyField, GovernedAction, Indicator } from './kdpInventoryModel';
import {
  conditionIndicator, failedSources, freshnessIndicator, planHref, readyBasisLabel, readyIndicator, relativeAge,
} from './kdpInventoryModel';

/** Status com texto e ícone. É o único jeito de mostrar estado nesta UI. */
export function LiveStatus({ indicator }: { indicator: Indicator }): JSX.Element {
  return <StatusIndicator type={indicator.type}>{indicator.text}</StatusIndicator>;
}

/**
 * Leitura parcial: alguma fonte caiu e o resto veio. Fica como aviso com os
 * nomes das fontes, porque sem isso a lista curta pareceria completa.
 */
export function SourceWarning({ partial, sources, truncatedSources = [], pt }: { partial: boolean; sources: LiveSource[] | undefined; truncatedSources?: string[]; pt: boolean }): JSX.Element | null {
  const failed = failedSources(sources);
  if (!partial && failed.length === 0 && truncatedSources.length === 0) return null;
  const truncated = truncatedSources.length > 0;
  return (
    <Alert type="warning" statusIconAriaLabel={pt ? 'Aviso' : 'Warning'}
      header={pt ? 'Leitura parcial do cluster' : 'Partial cluster read'}>
      {truncated
        ? (pt
          ? 'Uma ou mais fontes responderam, mas atingiram o limite de leitura. O que aparece é real; refine namespace ou busca para ler o restante.'
          : 'One or more sources answered but reached the read limit. What you see is real; narrow namespace or search to read the rest.')
        : (pt
          ? 'Uma ou mais fontes não responderam, então esta lista pode estar incompleta. O que aparece é real; o que falta não foi lido.'
          : 'One or more sources did not answer, so this list may be incomplete. What you see is real; what is missing was not read.')}
      {failed.length > 0 && <Box variant="small" padding={{ top: 'xs' }}>{pt ? 'Fontes com falha: ' : 'Failed sources: '}{failed.join(' · ')}</Box>}
      {truncated && <Box variant="small" padding={{ top: 'xs' }}>{pt ? 'Fontes truncadas: ' : 'Truncated sources: '}{truncatedSources.join(' · ')}</Box>}
    </Alert>
  );
}

/**
 * Falha de leitura. Erro explícito, com o status e a ação de tentar de novo -
 * jamais um empty state, que diria "não existe nada" sobre algo que não foi lido.
 */
export function LoadFailure({ message, status, sources, pt, onRetry }: {
  message: string; status?: number; sources?: LiveSource[]; pt: boolean; onRetry?: () => void;
}): JSX.Element {
  const failed = failedSources(sources);
  const notFound = status === 404;
  return (
    <Alert type="error" statusIconAriaLabel={pt ? 'Erro' : 'Error'}
      header={notFound
        ? (pt ? 'Não encontrado no cluster vivo' : 'Not found in the live cluster')
        : (pt ? 'Não foi possível ler o cluster' : 'Could not read the cluster')}
      action={onRetry && <Button onClick={onRetry} iconName="refresh">{pt ? 'Tentar de novo' : 'Retry'}</Button>}>
      <SpaceBetween size="xs">
        <Box>{notFound
          ? (pt ? 'A capability, o kind ou o objeto não existem no cluster. Isto não é uma lista vazia: nada foi encontrado para esta consulta.' : 'The capability, kind or object does not exist in the cluster. This is not an empty list: nothing matched this query.')
          : (pt ? 'A leitura falhou, então o estado destes objetos é desconhecido. Nada aqui deve ser lido como pronto nem como inexistente.' : 'The read failed, so the state of these objects is unknown. Nothing here should be read as ready or as absent.')}</Box>
        <Box variant="small">{pt ? 'Resposta do servidor: ' : 'Server response: '}{status ? `HTTP ${status} · ` : ''}{message}</Box>
        {failed.length > 0 && <Box variant="small">{pt ? 'Fontes com falha: ' : 'Failed sources: '}{failed.join(' · ')}</Box>}
      </SpaceBetween>
    </Alert>
  );
}

/**
 * Vazio de verdade: a leitura deu certo e não há objeto. Aponta para Create, que
 * é o que a issue #8 pede, e diz qual escopo foi consultado para o usuário saber
 * se o filtro é que está estreito.
 */
export function EmptyInventory({ capability, namespace, filtered, pt, onCreate, onClearFilters }: {
  capability: string; namespace: string; filtered: boolean; pt: boolean;
  onCreate?: () => void; onClearFilters?: () => void;
}): JSX.Element {
  return (
    <Box textAlign="center" padding={{ top: 'l', bottom: 'l' }}>
      <SpaceBetween size="s">
        <Box variant="strong">{filtered
          ? (pt ? 'Nenhum objeto casa com o filtro' : 'No object matches the filter')
          : (pt ? 'Nenhum objeto deste serviço ainda' : 'No objects for this service yet')}</Box>
        <Box variant="small">
          {pt ? 'Leitura concluída em ' : 'Read completed in '}
          {namespace === '_all' ? (pt ? 'todos os namespaces' : 'all namespaces') : namespace}
          {pt ? `, capability ${capability}.` : `, capability ${capability}.`}
        </Box>
        <SpaceBetween direction="horizontal" size="xs">
          {filtered && onClearFilters && <Button onClick={onClearFilters}>{pt ? 'Limpar filtros' : 'Clear filters'}</Button>}
          {onCreate && <Button variant="primary" iconName="add-plus" onClick={onCreate}>{pt ? 'Criar' : 'Create'}</Button>}
        </SpaceBetween>
      </SpaceBetween>
    </Box>
  );
}

/** Frescor da leitura como célula de tabela. */
export function FreshnessCell({ freshness, pt }: { freshness: Parameters<typeof freshnessIndicator>[0]; pt: boolean }): JSX.Element {
  return <LiveStatus indicator={freshnessIndicator(freshness, pt)} />;
}

/**
 * Ready com o motivo. O texto do motivo vem do readyBasis do servidor, então um
 * Ready negado por status velho aparece dizendo isso em vez de aparecer saudável.
 */
export function ReadyExplain({ detail, pt }: { detail: Pick<InstanceDetail, 'ready' | 'readyBasis' | 'readyCondition' | 'generation' | 'observedGeneration'>; pt: boolean }): JSX.Element {
  return (
    <SpaceBetween size="xxs">
      <LiveStatus indicator={readyIndicator(detail, pt)} />
      <Box variant="small">{readyBasisLabel(detail.readyBasis, pt)}</Box>
      <Box variant="small">
        {`generation ${detail.generation ?? '-'} · observedGeneration ${detail.observedGeneration ?? '-'}`}
        {detail.readyCondition ? ` · condition ${detail.readyCondition}` : ''}
      </Box>
    </SpaceBetween>
  );
}

/**
 * Conditions como o objeto as publica, na ordem de relevância que o backend já
 * aplicou (problema primeiro). A tabela não reordena: a ordem é informação.
 */
export function ConditionsTable({ conditions, pt }: { conditions: ConditionRow[]; pt: boolean }): JSX.Element {
  return (
    <Table
      variant="embedded"
      items={conditions}
      header={<Header variant="h3" counter={`(${conditions.length})`}
        description={pt ? 'Como o objeto reporta a si mesmo, com o problema no topo.' : 'How the object reports itself, problems first.'}>Conditions</Header>}
      columnDefinitions={[
        { id: 'type', header: 'Type', cell: row => row.type || '-' },
        { id: 'status', header: 'Status', cell: row => <LiveStatus indicator={conditionIndicator(row)} /> },
        { id: 'reason', header: 'Reason', cell: row => row.reason || '-' },
        { id: 'message', header: 'Message', cell: row => row.message || <Box variant="small">{pt ? '(sem mensagem)' : '(no message)'}</Box> },
        {
          id: 'transition', header: 'Last Transition',
          cell: row => row.lastTransition
            ? `${row.lastTransition} (${relativeAge(row.ageSeconds, pt)})`
            : (pt ? 'sem transição registrada' : 'no transition recorded'),
        },
      ]}
      empty={<Box textAlign="center" variant="small">{pt
        ? 'O objeto não publicou nenhuma condition. Sem condition não há como afirmar que está pronto.'
        : 'The object published no conditions. Without one there is no basis to call it ready.'}</Box>}
    />
  );
}

/** Campos copiáveis. Nada entra aqui sem passar pelo filtro de sensibilidade. */
export function CopyFieldList({ fields, pt }: { fields: CopyField[]; pt: boolean }): JSX.Element {
  return (
    <KeyValuePairs
      columns={2}
      items={fields.map(field => ({
        label: field.label,
        value: (
          <CopyToClipboard
            variant="inline"
            textToCopy={field.value}
            copyButtonAriaLabel={pt ? `Copiar ${field.label}` : `Copy ${field.label}`}
            copySuccessText={pt ? `${field.label} copiado` : `${field.label} copied`}
            copyErrorText={pt ? `Não foi possível copiar ${field.label}` : `Could not copy ${field.label}`}
          />
        ),
      }))}
    />
  );
}

/**
 * Trail: pedido -> MR -> Argo CD -> recurso observado. Só o que o objeto carrega.
 *
 * Dois elos têm mais de uma origem, e a tela diz qual valeu:
 *  - Pedido: a annotation `request-id` (Create do portal, Agent Builder) ou, para objeto do
 *    Platform Assistant, o par `plan-id`/`plan-step`. O plano abre pela rota do Assistant, que
 *    confere o projeto no servidor; aqui só aparece o identificador, que já é label do objeto.
 *  - MR: a annotation `mr-url`, ou "no plano" quando quem guarda o MR é o passo do plano.
 * Rastreio sem a Application lida é "não verificável", nunca "não": ausência de leitura não
 * é prova de que o objeto está fora do Git.
 */
export function TrailPanel({ trail, pt, onOpenPlan }: { trail: InstanceTrail; pt: boolean; onOpenPlan?: (planId: string) => void }): JSX.Element {
  const unknown = pt ? 'não registrado no objeto' : 'not recorded on the object';
  const plan = trail.plan ?? null;
  const planLink = plan ? planHref(plan.planId) : null;
  const toPlan = (text: string) => planLink && plan
    ? <Link href={planLink} onFollow={event => { if (onOpenPlan) { event.preventDefault(); onOpenPlan(plan.planId); } }}>{text}</Link>
    : text;
  const tracked = trail.argo.tracked
    ? { type: 'success' as const, text: pt ? 'sim' : 'yes' }
    : trail.argo.readable
      ? { type: 'info' as const, text: pt ? 'não' : 'no' }
      : { type: 'warning' as const, text: pt ? 'não verificável: a Application não foi lida' : 'cannot verify: the application was not read' };
  return (
    <ExpandableSection defaultExpanded variant="container"
      headerText={pt ? 'Trilha do pedido ao recurso' : 'Trail from request to resource'}
      headerDescription={pt ? 'Cada elo existe só quando o objeto realmente o carrega.' : 'Each link appears only when the object actually carries it.'}>
      <KeyValuePairs columns={2} items={[
        {
          label: pt ? 'Pedido' : 'Request',
          value: trail.request.requestId
            ?? (plan ? toPlan(pt ? `Platform Assistant · plano ${plan.planId.slice(0, 8)} · passo ${plan.step}` : `Platform Assistant · plan ${plan.planId.slice(0, 8)} · step ${plan.step}`) : unknown),
        },
        { label: pt ? 'Solicitante' : 'Requester', value: trail.request.requester ?? unknown },
        {
          label: 'Merge request',
          value: trail.mergeRequest
            ? <Link external href={trail.mergeRequest.url}>{trail.mergeRequest.url}</Link>
            : plan ? toPlan(pt ? `registrado no plano, passo ${plan.step}` : `recorded in the plan, step ${plan.step}`) : unknown,
        },
        {
          label: 'Argo CD',
          value: trail.argo.readable
            ? <SpaceBetween size="xxs">
                <LiveStatus indicator={{ type: trail.argo.sync === 'Synced' ? 'success' : 'pending', text: `sync ${trail.argo.sync}` }} />
                <LiveStatus indicator={{ type: trail.argo.health === 'Healthy' ? 'success' : 'warning', text: `health ${trail.argo.health}` }} />
                <Box variant="small">{`${trail.argo.application}${trail.argo.revision ? ` · ${trail.argo.revision.slice(0, 8)}` : ''}`}</Box>
              </SpaceBetween>
            : <LiveStatus indicator={{ type: 'warning', text: pt ? 'Application não lida' : 'application not read' }} />,
        },
        { label: pt ? 'Rastreado pelo Argo' : 'Tracked by Argo', value: <LiveStatus indicator={tracked} /> },
        { label: pt ? 'Arquivo GitOps' : 'GitOps file', value: trail.gitopsPath ?? (pt ? 'não comprovado pelo Argo' : 'not proven by Argo') },
        { label: pt ? 'Recurso observado' : 'Observed resource', value: `${trail.resource.apiVersion} ${trail.resource.kind} ${trail.resource.namespace}/${trail.resource.name}` },
        { label: 'resourceVersion', value: trail.resource.resourceVersion || unknown },
      ]} />
    </ExpandableSection>
  );
}

/**
 * Ações governadas. O texto de imposição vem da API e é mostrado: o usuário lê
 * onde a regra vive em vez de deduzir pelo botão estar aceso. Botão desabilitado
 * é cortesia; quem recusa é o handler POST.
 */
export function GovernedActionsPanel({ actions, pt, busy, onRun }: {
  actions: GovernedAction[]; pt: boolean; busy?: string; onRun?: (action: GovernedAction) => void;
}): JSX.Element {
  return (
    <ExpandableSection defaultExpanded variant="container"
      headerText={pt ? 'Ações' : 'Actions'}
      headerDescription={pt
        ? 'Toda ação passa pela API e pelos gates existentes. A autorização não vive no botão.'
        : 'Every action goes through the API and the existing gates. Authorization does not live in the button.'}>
      {actions.length === 0
        ? <Box variant="small">{pt ? 'Nenhuma ação disponível para este kind.' : 'No action available for this kind.'}</Box>
        : <SpaceBetween size="s">
            {actions.map(action => (
              <SpaceBetween key={action.id} size="xxs">
                <SpaceBetween direction="horizontal" size="xs">
                  {action.href && action.enabled
                    ? <Button variant="primary" href={action.href} target="_blank" iconName="external" iconAlign="right"
                        ariaLabel={`${action.label} (${pt ? 'abre em nova aba' : 'opens in a new tab'})`}>{action.label}</Button>
                    : <Button disabled={!action.enabled} loading={busy === action.id}
                        variant={action.via === 'write-path' ? 'primary' : 'normal'}
                        onClick={() => onRun?.(action)}>{action.label}</Button>}
                  <Badge color={action.via === 'write-path' ? 'blue' : 'grey'}>{action.via === 'write-path' ? 'GitOps' : 'Day-2'}</Badge>
                </SpaceBetween>
                <Box variant="small">{pt ? 'Imposto em: ' : 'Enforced at: '}{action.enforcement}</Box>
                {!action.enabled && action.disabledReason && (
                  <LiveStatus indicator={{ type: 'info', text: action.disabledReason }} />
                )}
              </SpaceBetween>
            ))}
          </SpaceBetween>}
    </ExpandableSection>
  );
}
