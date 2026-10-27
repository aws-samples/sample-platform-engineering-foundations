/*
 * Issue #9 - detalhe do recurso com conditions reais e ações governadas.
 *
 * Tudo nesta tela vem de GET /cluster/instance. Nenhum campo é inventado aqui:
 * não há owner financeiro, região nem custo fixados no frontend, porque o objeto
 * não carrega esses dados e exibi-los seria afirmar algo que ninguém mediu.
 *
 * Três invariantes que esta tela precisa preservar:
 *
 * 1. Ready vem do servidor, com o motivo em `readyBasis`. O browser não olha
 *    conditions para concluir prontidão - é assim que um Ready stale deixa de
 *    parecer saudável.
 * 2. Falha de leitura vira erro explícito. Nunca Ready, nunca "sem conditions",
 *    nunca uma tela parcialmente preenchida que pareça saudável.
 * 3. Ação governada chama a API. O botão desabilitado é cortesia de UI; quem
 *    recusa usuário não autorizado é o handler POST, que responde 403 mesmo
 *    chamado sem esta tela.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import { restartWorkload } from './clusterApi';
import { CompositionGraph } from './CompositionGraph';
import { ChildrenTable, RolloutBadge, rolloutText } from './CompositionRevisionParts';
import { ObjectTrail } from './AuditLogPage';
import { OwnerLink } from './ownership';
import { getActiveScope, promotionTargetFor } from './scope/activeScope';
import { PromotionModal } from './PromotionModal';
import { InstanceDependenciesSection } from './InstanceDependenciesSection';
import { isPromotable } from './promotion';
import { Day2ConfirmModal } from './Day2ConfirmModal';
import { errorMessage } from './errors';
import { useI18n } from './i18n';
import { viewHash } from './shellNavigation';
import { InstanceDetail, InventoryError, getInstance } from './kdpInventoryApi';
import {
  GovernedAction, RequestGate, backToListPath, capabilityFromSlug, copyableFields,
  createRequestGate, detailRefreshDelay, freshnessIndicator, governedActions,
  relativeAge, stateIndicator,
} from './kdpInventoryModel';
import {
  ConditionsTable, CopyFieldList, GovernedActionsPanel, LiveStatus, LoadFailure,
  ReadyExplain, SourceWarning, TrailPanel,
} from './KdpInventoryParts';
import { ScorecardLevelCell, ScorecardRulesTable, argoUnreadableNote } from './scorecardParts';

export interface LiveResourceDetailViewProps {
  capability: string;
  namespace: string;
  name: string;
  kind?: string;
  onBack: () => void;
  /**
   * Abre o plano do Platform Assistant que criou o objeto. A mudança de uma instância existente
   * NÃO passa por aqui: ela é um link para editar o arquivo no GitLab (ver `governedActions`),
   * porque o Create do portal é create-only e abri-lo vazio prometia um update inexistente.
   */
  onOpenPlan?: (planId: string) => void;
  /** Abre o detalhe de outra instância (seção Dependências). Sem ele, os nós saem como texto. */
  onOpenDetail?: (path: string) => void;
}

export function LiveResourceDetailView({ capability, namespace, name, kind, onBack, onOpenPlan, onOpenDetail }: LiveResourceDetailViewProps): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [failure, setFailure] = useState<InventoryError | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [outcome, setOutcome] = useState('');
  // Restart abre a confirmação; a chamada só sai do botão Confirmar.
  const [pending, setPending] = useState<GovernedAction | null>(null);
  const [promoting, setPromoting] = useState(false);
  /*
   * Porteiro das leituras concorrentes (ver `createRequestGate`). Duas leituras podem estar no ar
   * ao mesmo tempo (refresh automático, clique em Atualizar, troca de objeto), e sem porteiro a
   * MAIS LENTA ganha: uma resposta antiga sobrescrevia o objeto novo, e um erro antigo apagava um
   * detalhe que havia carregado.
   */
  const gate = useRef<RequestGate>(createRequestGate());

  const load = useCallback(async (quiet: boolean) => {
    const { token, signal } = gate.current.begin();
    if (!quiet) setLoading(true);
    try {
      const next = await getInstance({ namespace, name, capability: capability || undefined, kind: kind || undefined }, signal);
      if (!gate.current.isCurrent(token)) return;
      setDetail(next);
      setFailure(null);
    } catch (cause) {
      // Cancelamento próprio não é falha: a leitura que o substituiu é que decide a tela.
      if (cause instanceof InventoryError && cause.aborted) return;
      if (!gate.current.isCurrent(token)) return;
      // A leitura falhou, então o estado é DESCONHECIDO. Manter o detalhe
      // anterior na tela mostraria um Ready que ninguém confirmou agora.
      setFailure(cause instanceof InventoryError ? cause : new InventoryError(0, errorMessage(cause, 'cluster API unavailable')));
      setDetail(null);
    } finally {
      if (gate.current.isCurrent(token)) setLoading(false);
    }
  }, [capability, kind, name, namespace]);

  useEffect(() => { void load(false); }, [load]);

  // Desmontar aborta o que estava no ar: a resposta não tem mais tela para atualizar.
  useEffect(() => () => { gate.current.abort(); }, []);

  /*
   * Provisionando -> Ready sem reload manual (issue #9). Enquanto o objeto não
   * converge a releitura é rápida; depois desacelera.
   */
  useEffect(() => {
    const timer = window.setInterval(() => void load(true), detailRefreshDelay(detail));
    return () => window.clearInterval(timer);
  }, [detail, load]);

  /**
   * Executa a ação pela API e reconfere no objeto. O resultado é a releitura, e
   * não o retorno da chamada: um POST que responde 200 ainda não é um objeto
   * que convergiu.
   *
   * Só Restart passa por aqui. Scale saiu: ver `governedActions`.
   */
  const run = async (action: GovernedAction) => {
    // Caminho de escrita é link para o GitLab: nada a executar daqui.
    if (!detail || action.via !== 'day2-api') return;
    setBusy(action.id);
    setOutcome('');
    try {
      const target = detail.metadata;
      await restartWorkload(target.namespace, detail.kind.toLowerCase(), target.name);
      setOutcome(pt ? `${action.label}: a API aceitou. Reconferindo o objeto…` : `${action.label}: the API accepted it. Re-reading the object…`);
      await load(true);
    } catch (cause) {
      // 403 do handler é a autorização funcionando, e aparece como tal.
      setFailure(cause instanceof InventoryError ? cause : new InventoryError(0, errorMessage(cause, 'operation failed')));
    } finally {
      setBusy('');
    }
  };

  const back = <Button iconName="angle-left" onClick={onBack}>{pt ? 'Voltar' : 'Back'}</Button>;

  if (failure) {
    return (
      <ContentLayout header={<Header variant="h1" actions={back}>{name}</Header>}>
        <LoadFailure message={failure.message} status={failure.status} sources={failure.sources} pt={pt} onRetry={() => void load(false)} />
      </ContentLayout>
    );
  }

  if (loading && !detail) {
    return (
      <ContentLayout header={<Header variant="h1" actions={back}>{name}</Header>}>
        <Box textAlign="center" padding="l">
          <SpaceBetween size="s">
            <Spinner size="large" />
            <Box variant="small">{pt ? 'Lendo o objeto no cluster…' : 'Reading the object from the cluster…'}</Box>
          </SpaceBetween>
        </Box>
      </ContentLayout>
    );
  }

  if (!detail) return <ContentLayout header={<Header variant="h1" actions={back}>{name}</Header>}><Box /></ContentLayout>;

  const actions = governedActions(detail, pt);
  const fields = copyableFields(detail, pt);
  // environments-promotion: o alvo vem do registry (projeto dono -> promotesTo); sem alvo, sem botão.
  const promotionTarget = isPromotable(detail) ? promotionTargetFor(detail.metadata.namespace) : null;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={<SpaceBetween direction="horizontal" size="xs">
            {back}
            <Button iconName="refresh" loading={loading} onClick={() => void load(false)}>{pt ? 'Atualizar' : 'Refresh'}</Button>
            {promotionTarget && (
              <Button iconName="upload" onClick={() => setPromoting(true)} data-testid="promote-button">
                {pt ? `Promover para ${promotionTarget.project.environment.name || promotionTarget.project.environment.id}`
                  : `Promote to ${promotionTarget.project.environment.name || promotionTarget.project.environment.id}`}
              </Button>
            )}
          </SpaceBetween>}
          description={
            <SpaceBetween direction="horizontal" size="xs">
              <Badge color="blue">{detail.kind}</Badge>
              <Badge color="grey">{`ns ${detail.metadata.namespace}`}</Badge>
              <Badge color="grey">{detail.engine}</Badge>
              <Badge color="grey">{detail.capability}</Badge>
            </SpaceBetween>
          }
        >{detail.metadata.name}</Header>
      }
    >
      <SpaceBetween size="l">
        <SourceWarning partial={detail.partial} sources={detail.sources} pt={pt} />
        {detail.metadata.deleting && (
          <Alert type="warning" statusIconAriaLabel={pt ? 'Aviso' : 'Warning'}>
            {pt ? 'O objeto está em exclusão: o Kubernetes registrou deletionTimestamp.' : 'The object is being deleted: Kubernetes recorded a deletionTimestamp.'}
          </Alert>
        )}
        {!!outcome && <Alert type="success" dismissible onDismiss={() => setOutcome('')}>{outcome}</Alert>}

        <ExpandableSection defaultExpanded variant="container"
          headerText="Status"
          headerDescription={pt ? 'O que o objeto reporta agora, e com qual base.' : 'What the object reports now, and on what basis.'}>
          <KeyValuePairs columns={3} items={[
            { label: pt ? 'Prontidão' : 'Readiness', value: <ReadyExplain detail={detail} pt={pt} /> },
            { label: 'Owner', value: <OwnerLink owner={detail.owner} teams={getActiveScope().teams ?? []} pt={pt} /> },
            {
              label: pt ? 'Projeto dono' : 'Owning project',
              value: (() => {
                const projectId = getActiveScope().owners[detail.metadata.namespace] ?? null;
                const owner = projectId ? getActiveScope().projectOwners?.[projectId] : undefined;
                if (!projectId || !owner) return <Box color="text-status-inactive">{pt ? 'namespace fora dos projetos da sessão' : 'namespace outside the session projects'}</Box>;
                return <SpaceBetween size="xxs"><span>{projectId}</span><OwnerLink owner={owner.team} teams={getActiveScope().teams ?? []} pt={pt} /><OwnerLink owner={owner.contact} teams={[]} pt={pt} /></SpaceBetween>;
              })(),
            },
            { label: 'State', value: <LiveStatus indicator={stateIndicator(detail, pt)} /> },
            {
              label: pt ? 'Atualização' : 'Freshness',
              value: <SpaceBetween size="xxs">
                <LiveStatus indicator={freshnessIndicator(detail.freshness, pt)} />
                <Box variant="small">{pt ? 'última transição ' : 'last transition '}{relativeAge(detail.freshness.lastTransitionAgeSeconds, pt)}</Box>
              </SpaceBetween>,
            },
          ]} />
        </ExpandableSection>

        <Container
          header={<Header variant="h2"
            description={pt ? 'Padrões da plataforma avaliados no servidor a partir deste objeto. Regras em Git: platform/scorecards/standards.json.' : 'Platform standards evaluated server-side from this object. Rules in Git: platform/scorecards/standards.json.'}
            actions={<ScorecardLevelCell card={detail.scorecard} pt={pt} />}>Scorecard</Header>}>
          {detail.scorecard
            ? <SpaceBetween size="s">
                {!detail.scorecard.argoReadable && <Alert type="warning">{argoUnreadableNote(pt)}</Alert>}
                <ScorecardRulesTable card={detail.scorecard} pt={pt} />
              </SpaceBetween>
            : <Box color="text-status-inactive">{pt ? 'As regras não puderam ser carregadas no servidor; nenhum nível é afirmado.' : 'The rules could not be loaded on the server; no level is claimed.'}</Box>}
        </Container>

        <ExpandableSection variant="container"
          headerText={pt ? 'Ações pelo portal' : 'Portal actions'}
          headerDescription={pt
            ? 'Trilha de auditoria deste objeto: pedidos, merge requests, planos e ações Day 2 feitos pelo portal ou pelo CI, com ator e resultado. Mudanças feitas direto na AWS ou no cluster não aparecem aqui.'
            : 'Audit trail of this object: requests, merge requests, plans and Day 2 actions made through the portal or the CI, with actor and result. Changes made directly in AWS or in the cluster do not appear here.'}>
          <ObjectTrail kind={detail.kind} namespace={detail.metadata.namespace} name={detail.metadata.name} />
        </ExpandableSection>

        <InstanceDependenciesSection kind={detail.kind} namespace={detail.metadata.namespace} name={detail.metadata.name} pt={pt}
          onOpenDetail={path => onOpenDetail?.(path)} />

        <Container header={<Header variant="h2">Conditions</Header>}>
          <ConditionsTable conditions={detail.conditions} pt={pt} />
        </Container>

        {detail.engine === 'kro' && (
          <ExpandableSection defaultExpanded variant="container"
            headerText={pt ? 'Composição' : 'Composition'}
            headerDescription={pt
              ? `O que a definição ${detail.capability} cria para esta instância, na ordem em que o kro reconcilia. Lido da ResourceGraphDefinition no cluster.`
              : `What the ${detail.capability} definition creates for this instance, in the order kro reconciles it. Read from the ResourceGraphDefinition in the cluster.`}>
            {detail.composition
              ? <CompositionGraph graph={detail.composition} pt={pt} />
              : <Alert type="warning" statusIconAriaLabel={pt ? 'Aviso' : 'Warning'}>
                  {pt
                    ? 'A definição desta composição não pôde ser lida agora; veja as fontes com falha acima. O grafo não é exibido para não parecer vazio.'
                    : 'The definition of this composition could not be read right now; see the failed sources above. The graph is hidden so it does not look empty.'}
                </Alert>}
          </ExpandableSection>
        )}

        {detail.engine === 'kro' && detail.composition && detail.children !== undefined && detail.children !== null && detail.revision && (
          <ExpandableSection defaultExpanded variant="container"
            headerText={pt ? `Recursos filhos e revisão (${detail.children.length})` : `Child resources and revision (${detail.children.length})`}
            headerDescription={pt
              ? 'Os objetos que o kro criou para esta instância (label kro.run/instance-id), com a política de deleção de cada um e se já carregam o hash da revisão ativa da definição.'
              : 'The objects kro created for this instance (label kro.run/instance-id), with each one\'s deletion policy and whether it already carries the hash of the definition\'s active revision.'}>
            <SpaceBetween size="m">
              <KeyValuePairs columns={3} items={[
                { label: pt ? 'Rollout' : 'Rollout', value: <RolloutBadge summary={detail.revision} pt={pt} /> },
                { label: pt ? 'Revisão ativa da definição' : 'Definition active revision', value: detail.revision.latest ? `r${detail.revision.latest.revision} (${pt ? 'geração' : 'generation'} ${detail.revision.latest.generation ?? '-'})` : (detail.revision.error ? (pt ? 'não lida' : 'not read') : '-') },
                { label: pt ? 'Filhos' : 'Children', value: rolloutText(detail.revision, pt) },
              ]} />
              <ChildrenTable children={detail.children} pt={pt} />
            </SpaceBetween>
          </ExpandableSection>
        )}

        <ExpandableSection defaultExpanded variant="container"
          headerText={pt ? 'Visão geral' : 'Overview'}
          headerDescription={pt
            ? 'Identidade do objeto e os outputs publicáveis dele. Nada de Secret, e nada inventado pelo portal.'
            : 'Object identity and its publishable outputs. No Secret, and nothing invented by the portal.'}>
          <SpaceBetween size="m">
            <CopyFieldList fields={fields} pt={pt} />
            <KeyValuePairs columns={2} items={[
              { label: pt ? 'Criado' : 'Created', value: detail.metadata.created ?? '-' },
              { label: 'resourceVersion', value: detail.metadata.resourceVersion || '-' },
              {
                label: 'Labels',
                value: Object.keys(detail.metadata.labels).length === 0
                  ? (pt ? 'nenhuma' : 'none')
                  : Object.entries(detail.metadata.labels).map(([key, value]) => `${key}=${value}`).join(' · '),
              },
              {
                label: 'Annotations',
                value: Object.keys(detail.metadata.annotations).length === 0
                  ? (pt ? 'nenhuma de plataforma' : 'none from the platform')
                  : Object.entries(detail.metadata.annotations).map(([key, value]) => `${key}=${value}`).join(' · '),
              },
              { label: 'Finalizers', value: detail.metadata.finalizers.join(' · ') || (pt ? 'nenhum' : 'none') },
            ]} />
          </SpaceBetween>
        </ExpandableSection>

        <TrailPanel trail={detail.trail} pt={pt} onOpenPlan={onOpenPlan} />
        <GovernedActionsPanel actions={actions} pt={pt} busy={busy}
          onRun={action => { if (action.via === 'day2-api') setPending(action); }} />
        {promoting && <PromotionModal detail={detail} target={promotionTarget} pt={pt} onDismiss={() => setPromoting(false)} />}
        <Day2ConfirmModal pt={pt} busy={busy !== ''} onCancel={() => setPending(null)}
          action={pending ? { op: 'restart', name: detail.metadata.name, namespace: detail.metadata.namespace, kind: detail.kind.toLowerCase() } : null}
          onConfirm={() => { const action = pending; setPending(null); if (action) void run(action); }} />
      </SpaceBetween>
    </ContentLayout>
  );
}

/** Wrapper de rota: único lugar deste arquivo que conhece o router. */
export function LiveResourceDetailRoute(): JSX.Element {
  const { capabilitySlug: slug = '', namespace = '', name = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const capability = capabilityFromSlug(slug);
  const from = params.get('from');
  return (
    <LiveResourceDetailView
      capability={capability}
      namespace={namespace}
      name={name}
      kind={params.get('kind') ?? undefined}
      // `from` carrega a consulta da listagem, então o Back devolve os MESMOS
      // filtros mesmo quando o usuário chegou ao detalhe por link.
      onBack={() => navigate(backToListPath(capability, from), { replace: true })}
      // Navegação interna pelo router: `window.location.assign` recarregaria a aplicação inteira.
      onOpenPlan={planId => navigate({ pathname: '/agent-platform/', search: '', hash: viewHash('assistant', planId) })}
      onOpenDetail={path => navigate(path)}
    />
  );
}

export default LiveResourceDetailRoute;
