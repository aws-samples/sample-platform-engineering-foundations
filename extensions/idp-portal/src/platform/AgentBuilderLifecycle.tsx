// Acompanhamento de um agent do builder: do pedido ao teste A2A, mais a desativação (rollback L2).
import { useEffect, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { REQUEST_ID, requestAgentDisable } from './agentBuilderApi';
import { ActionableError, describeApiError, TrackedTarget } from './agentBuilderModel';
import { presentPhase } from './agentBuilderPhase';
import { A2AChat, ConditionPill, ErrorAlert, EventsTable, LifecycleTimeline, PhaseBanner } from './AgentBuilderParts';
import { useA2ATest, useAgentLifecycle } from './useAgentBuilder';
import { GIT_WEB_BASE } from './deployment';

const GITLAB_PROJECT_URL = GIT_WEB_BASE;
const ARGO_APPLICATION = 'agent-platform-agents';

/** Mesmo link de platformApi.openMrNowUrl, com o id validado aqui. */
function runPipelineUrl(requestId: string): string | null {
  return REQUEST_ID.test(requestId) ? `${GITLAB_PROJECT_URL}/-/pipelines/new?ref=main&var[PROVISION_REQUEST_ID]=${requestId}` : null;
}

export function AgentLifecycle({ target, alias, isAdmin, onTrack, onFixDraft, onClose, pt }: {
  target: TrackedTarget;
  alias: string;
  isAdmin: boolean;
  onTrack: (target: TrackedTarget) => void;
  onFixDraft?: () => void;
  onClose: () => void;
  pt: boolean;
}): JSX.Element {
  const chat = useA2ATest(target.name, pt);
  const a2a = chat.last ? { state: chat.last.state, hasText: chat.last.hasText } : null;
  const life = useAgentLifecycle(target, a2a, pt);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<ActionableError | null>(null);
  const headingRef = useRef<HTMLDivElement>(null);

  // Foco no título quando o alvo muda: quem usa teclado ou leitor de tela sabe onde está.
  useEffect(() => { headingRef.current?.focus(); }, [target.name, target.requestId]);

  const phase = life.phase;
  const agent = life.agent;
  const request = life.request;
  const canDisable = Boolean(agent && agent.replicas !== 0 && (isAdmin || agent.requester === alias) && target.op === 'create');
  const testable = phase === 'READY' || phase === 'VERIFIED' || phase === 'TEST_FAILED';
  const displayName = agent?.displayName || target.name;
  const pipeline = target.requestId ? runPipelineUrl(target.requestId) : null;

  const disable = async () => {
    setDisabling(true); setDisableError(null);
    try {
      const created = await requestAgentDisable(target.name);
      setConfirmDisable(false);
      onTrack({ name: target.name, op: 'disable', requestId: created.requestId });
    } catch (cause) {
      setDisableError(describeApiError(cause, 'disable', pt));
    } finally {
      setDisabling(false);
    }
  };

  const updated = life.updatedAt ? new Date(life.updatedAt).toLocaleTimeString(pt ? 'pt-BR' : 'en-US') : null;

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description={target.op === 'disable' ? (pt ? 'Desativação (replicas: 0) por merge request' : 'Disable (replicas: 0) through a merge request') : (pt ? 'Do pedido ao teste A2A, lido do GitLab, do Argo CD e do cluster' : 'From request to A2A test, read from GitLab, Argo CD and the cluster')}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button iconName="refresh" onClick={life.refresh} ariaLabel={pt ? 'Atualizar o estado agora' : 'Refresh the state now'}>{pt ? 'Atualizar' : 'Refresh'}</Button>
                {canDisable && <Button onClick={() => setConfirmDisable(true)}>{pt ? 'Desativar' : 'Disable'}</Button>}
                <Button variant="link" onClick={onClose}>{pt ? 'Parar de acompanhar' : 'Stop tracking'}</Button>
              </SpaceBetween>
            }
          >
            <div ref={headingRef} tabIndex={-1} className="ab-focus-target">{displayName} <code className="ab-muted">{target.name}</code></div>
          </Header>
        }
      >
        <SpaceBetween size="m">
          {!phase && !life.requestError && <StatusIndicator type="loading">{pt ? 'Lendo o estado do pedido e do cluster…' : 'Reading the request and cluster state…'}</StatusIndicator>}
          {life.requestError && <ErrorAlert error={life.requestError} onRetry={life.refresh} pt={pt} />}
          {phase && <PhaseBanner phase={phase} pt={pt} />}
          {phase && <LifecycleTimeline op={target.op} phase={phase} pt={pt} />}
          {life.clusterError && (
            <Alert type="warning" header={pt ? 'Estado do cluster indisponível no momento' : 'Cluster state unavailable right now'}>
              {life.clusterError.action} {pt ? 'O portal tenta de novo a cada 10 s; a fase mostrada usa a última leitura boa.' : 'The portal retries every 10 s; the phase shown uses the last good reading.'}
              {life.clusterError.message && <div className="ab-muted"><code>{life.clusterError.message}</code></div>}
            </Alert>
          )}
          {life.requestMissing && (
            <Alert type="info">{pt ? 'O pedido não foi encontrado (ele expira, ou é de outra pessoa). A fase abaixo vem só do cluster.' : 'The request was not found (it expires, or belongs to someone else). The phase below comes from the cluster only.'}</Alert>
          )}
          {agent && !agent.argoTracked && (
            <Alert type="warning" header={pt ? 'Agent fora do controle do Argo CD' : 'Agent not tracked by Argo CD'}>
              {pt ? 'O objeto tem o label do builder, mas não a marca de tracking do Argo CD: ele pode ter sido criado fora do Git. Avise um admin da plataforma.' : 'The object carries the builder label but not the Argo CD tracking mark: it may have been created outside Git. Tell a platform admin.'}
            </Alert>
          )}

          {/* Detalhes de cada fase: só o que ajuda a agir nela. */}
          {phase === 'REQUESTED' && pipeline && (
            <Box>
              {pt ? 'Quer o MR agora? ' : 'Want the MR now? '}<Link href={pipeline} external>{pt ? 'Abrir o Run pipeline no GitLab' : 'Open Run pipeline on GitLab'}</Link>
              {pt ? ' e clique em Run pipeline. Sem isso, o próximo sweep agendado abre o MR.' : ' and click Run pipeline. Otherwise the next scheduled sweep opens it.'}
              {!life.polling && <div className="ab-muted">{pt ? 'O portal parou de consultar depois de 2 min. Use Atualizar quando quiser.' : 'The portal stopped checking after 2 min. Use Refresh whenever you want.'}</div>}
            </Box>
          )}
          {(phase === 'IN_REVIEW' || phase === 'CLOSED' || request?.mrUrl) && request?.mrUrl && (
            <Box>{pt ? 'Merge request: ' : 'Merge request: '}<Link href={request.mrUrl} external>{request.mrUrl}</Link></Box>
          )}
          {phase === 'FAILED' && (
            <Alert type="error" header={pt ? 'Motivo informado pelo CI' : 'Reason reported by CI'} action={onFixDraft && target.op === 'create' ? <Button onClick={onFixDraft}>{pt ? 'Corrigir o rascunho' : 'Fix the draft'}</Button> : undefined}>
              <code>{request?.error || (pt ? 'sem detalhe' : 'no detail')}</code>
            </Alert>
          )}
          {(phase === 'SYNCING' || phase === 'SYNC_STALLED') && (
            <KeyValuePairs
              columns={4}
              items={[
                { label: 'Argo Application', value: <code>{life.argo?.application ?? ARGO_APPLICATION}</code> },
                { label: 'Sync', value: life.argo?.sync ?? (pt ? 'ainda não lido' : 'not read yet') },
                { label: 'Health', value: life.argo?.health ?? (pt ? 'ainda não lido' : 'not read yet') },
                { label: pt ? 'Revisão' : 'Revision', value: life.argo?.revision ? <code>{life.argo.revision.slice(0, 10)}</code> : '-' },
              ]}
            />
          )}
          {agent && (
            <ColumnLayout columns={3} variant="text-grid">
              <ConditionPill label="Accepted" condition={agent.accepted} pt={pt} />
              <ConditionPill label="Ready" condition={agent.ready} pt={pt} />
              <div>
                <StatusIndicator type={agent.observedGeneration === agent.generation ? 'success' : 'in-progress'}>
                  {pt ? `Geração ${agent.observedGeneration}/${agent.generation}` : `Generation ${agent.observedGeneration}/${agent.generation}`}
                  {agent.observedGeneration === agent.generation ? (pt ? ' (em dia)' : ' (current)') : (pt ? ' (aplicando)' : ' (applying)')}
                </StatusIndicator>
                <div className="ab-muted">{pt ? 'Pedido por' : 'Requested by'} {agent.requester}{agent.replicas === 0 ? (pt ? ' · replicas: 0' : ' · replicas: 0') : ''}</div>
              </div>
            </ColumnLayout>
          )}
          {agent && (phase === 'STARTING' || phase === 'STALLED' || phase === 'REJECTED' || phase === 'TEST_FAILED') && (
            <EventsTable events={agent.events ?? []} pt={pt} />
          )}
          {updated && <Box variant="small" color="text-body-secondary">{pt ? `Atualizado às ${updated}` : `Updated at ${updated}`}{life.polling ? (pt ? ' · acompanhando automaticamente' : ' · tracking automatically') : (pt ? ' · sem consulta automática nesta fase' : ' · no automatic checks in this phase')}</Box>}
        </SpaceBetween>
      </Container>

      {(testable || chat.messages.length > 0) && (
        <Container header={<Header variant="h2" description={pt ? 'Pergunta real ao agent pelo protocolo A2A. É o que fecha a fase Verificado.' : 'A real question to the agent over A2A. This is what closes the Verified phase.'}>{pt ? 'Testar agora' : 'Test now'}</Header>}>
          <A2AChat
            agentLabel={displayName}
            messages={chat.messages}
            running={chat.running}
            disabled={!testable}
            disabledReason={testable ? undefined : (pt ? 'O teste fica disponível quando o agent estiver Ready.' : 'The test becomes available when the agent is Ready.')}
            onSend={text => { void chat.send(text); }}
            pt={pt}
          />
        </Container>
      )}

      <Modal
        visible={confirmDisable}
        onDismiss={() => setConfirmDisable(false)}
        header={pt ? `Desativar ${target.name}?` : `Disable ${target.name}?`}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setConfirmDisable(false)}>{pt ? 'Cancelar' : 'Cancel'}</Button>
              <Button variant="primary" loading={disabling} onClick={disable}>{pt ? 'Pedir desativação' : 'Request disable'}</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <span>{pt ? 'O portal registra um pedido; o CI abre o MR "disable:" com replicas: 0. Depois do merge, o agent para de atender e o teste A2A responde 409.' : 'The portal records a request; CI opens a "disable:" MR with replicas: 0. After the merge the agent stops serving and the A2A test answers 409.'}</span>
          <span>{pt ? 'O objeto, o histórico e o nome continuam. Para reativar, faça Revert desse MR no GitLab.' : 'The object, history and name remain. To re-enable it, revert that MR on GitLab.'}</span>
          {disableError && <ErrorAlert error={disableError} onRetry={disable} pt={pt} />}
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}

/** Rótulo curto da fase para tabelas: ícone + texto, nunca só cor. */
export function PhaseCell({ phase, pt }: { phase: Parameters<typeof presentPhase>[0]; pt: boolean }): JSX.Element {
  const p = presentPhase(phase, pt);
  return <StatusIndicator type={p.indicator}>{p.label}</StatusIndicator>;
}
