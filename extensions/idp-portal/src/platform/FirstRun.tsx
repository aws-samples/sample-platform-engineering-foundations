/*
 * Primeiros passos (docs/agent-platform/design-first-run.md). O SA cria o próprio site efêmero,
 * acompanha cada etapa do caminho GitOps até a URL, e o site some sozinho no dia seguinte.
 * O modo demo mostra, ao lado, o demo-webapp permanente, para a conversa não depender dos
 * minutos de CloudFront. A lógica de etapa vive em tourTrail.ts e a de progresso em firstRunModel.ts;
 * aqui o FirstRun cuida do polling e o FirstRunView só desenha, para ser testado sem DOM.
 */
import { useEffect, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import LiveRegion from '@cloudscape-design/components/live-region';
import ProgressBar, { ProgressBarProps } from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator, { StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import Steps, { StepsProps } from '@cloudscape-design/components/steps';
import Toggle from '@cloudscape-design/components/toggle';
import { createTourRequest, getPlatformMe, getProvisionRequest, publishTour, ProvisionRequest } from './platformApi';
import { getPlatformView, PlatformView } from './clusterApi';
import { ARGO_CD_URL } from './catalog';
import { errorMessage } from './errors';
import { useI18n } from './i18n';
import { tourTrail, StepId, StepState, Trail } from './tourTrail';
import { firstRunProgress, formatDuration, FirstRunProgress, IdentityState, SPIKE_TOTAL_SECONDS } from './firstRunModel';

export const POLL_MS = 10_000;
const storageKey = (alias: string) => `appmod.firstRun.requestId.${alias}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

const STATUS: Record<StepState, StepsProps.Status> = {
  pending: 'pending', active: 'in-progress', slow: 'warning', 'waiting-human': 'stopped', done: 'success', error: 'error',
};

const LABELS: Record<StepId, { pt: [string, string]; en: [string, string] }> = {
  request: { pt: ['Pedido registrado', 'A platform-api gravou o pedido com o manifest gerado para você. O bot pega em até um minuto.'],
    en: ['Request recorded', 'The platform-api stored the request with a manifest generated for you. The bot picks it up within a minute.'] },
  mr: { pt: ['Merge request aberto', 'Validado no CI contra as regras da plataforma: nome reservado, expiração, deletion policy.'],
    en: ['Merge request opened', 'Validated in CI against the platform rules: reserved name, expiry, deletion policy.'] },
  merge: { pt: ['Merge na main', 'Aguardando o operador aprovar. O Git continua sendo a fonte da verdade.'],
    en: ['Merged to main', 'Waiting for the operator to approve. Git stays the source of truth.'] },
  gitops: { pt: ['Mirror GitOps e Argo CD', 'O arquivo chega ao CodeCommit e o Argo CD aplica no cluster. Uns 4 minutos.'],
    en: ['GitOps mirror and Argo CD', 'The file reaches CodeCommit and Argo CD applies it to the cluster. About 4 minutes.'] },
  cloudfront: { pt: ['kro e ACK: bucket e CloudFront', 'Bucket privado, OAC, HSTS e CSP. A distribuição leva uns 4 minutos.'],
    en: ['kro and ACK: bucket and CloudFront', 'Private bucket, OAC, HSTS and CSP. The distribution takes about 4 minutes.'] },
  page: { pt: ['Sua página no ar', 'A platform-api publica a página com o seu nome, só no seu bucket.'],
    en: ['Your page is live', 'The platform-api publishes a page with your name, only to your bucket.'] },
};

const stepLabel = (id: StepId | null, pt: boolean): string => (id ? LABELS[id][pt ? 'pt' : 'en'][0] : '');

export function FirstRun(): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [identity, setIdentity] = useState<IdentityState>('loading');
  const [alias, setAlias] = useState('');
  const [requestId, setRequestId] = useState('');
  const [request, setRequest] = useState<ProvisionRequest | null>(null);
  const [platform, setPlatform] = useState<PlatformView | null>(null);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);
  const [now, setNow] = useState(nowSeconds);
  const [lastReadAt, setLastReadAt] = useState<number | null>(null);
  const active = useRef<{ step: StepId | null; since: number | null }>({ step: null, since: null });

  useEffect(() => {
    getPlatformMe().then(me => {
      setAlias(me.alias);
      setRequestId(window.localStorage.getItem(storageKey(me.alias)) ?? '');
      setIdentity('ready');
    }).catch(cause => { setIdentity('failed'); setError(errorMessage(cause, 'platform-api unavailable')); });
  }, []);

  const instance = platform?.instances.find(i => i.name === `tour-${alias}`) ?? null;
  const trail = tourTrail({ request, instance, published, now, activeSince: active.current.since });
  if (trail.current !== active.current.step) active.current = { step: trail.current, since: now };
  const finished = trail.steps.every(s => s.state === 'done');
  // Pedido falho ou MR fechado é terminal: o polling para, como a tela diz.
  const settled = finished || trail.steps.some(s => s.state === 'error');
  const demoApp = platform?.instances.find(i => i.name === 'demo-webapp');

  useEffect(() => {
    if (!requestId || settled) return undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const [r, p] = await Promise.all([getProvisionRequest(requestId), getPlatformView()]);
        if (stopped) return;
        const readAt = nowSeconds();
        setRequest(r); setPlatform(p); setNow(readAt); setLastReadAt(readAt); setError(''); setStatusError(false);
      } catch (cause) {
        if (stopped) return;
        const message = errorMessage(cause, 'status unavailable');
        if (/not found/i.test(message)) {
          // O pedido expirou (TTL de 30 dias) ou nunca existiu aqui: volta ao botão.
          window.localStorage.removeItem(storageKey(alias)); setRequestId(''); setRequest(null); setStatusError(false);
          return;
        }
        setError(message); setStatusError(true);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [requestId, settled, alias]);

  const publish = async () => {
    try {
      const result = await publishTour(requestId);
      setPublished(result.written.length + result.alreadyPublished.length > 0);
    } catch (cause) {
      setError(errorMessage(cause, 'publish failed'));
    }
  };
  // Publica sozinho quando o CloudFront fica Deployed. Idempotente: nunca sobrescreve.
  const cloudfrontDone = trail.steps.find(s => s.id === 'cloudfront')?.state === 'done';
  useEffect(() => { if (cloudfrontDone && !published) void publish(); }, [cloudfrontDone]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (demo && !platform) getPlatformView().then(setPlatform).catch(() => undefined); }, [demo, platform]);

  const start = async () => {
    setBusy(true); setError('');
    try {
      const created = await createTourRequest();
      window.localStorage.setItem(storageKey(alias), created.requestId);
      setRequestId(created.requestId); setRequest(created); setStatusError(false); active.current = { step: null, since: null };
    } catch (cause) {
      setError(errorMessage(cause, pt ? 'Não foi possível criar o pedido.' : 'Could not create the request.'));
    } finally { setBusy(false); }
  };

  return (
    <FirstRunView
      locale={locale}
      alias={alias}
      requestId={requestId}
      request={request}
      trail={trail}
      progress={firstRunProgress({ identity, requestId, request, trail, now, statusError })}
      statusError={statusError}
      lastReadAt={lastReadAt}
      published={published}
      error={error}
      busy={busy}
      demo={demo}
      demoUrl={demoApp?.outputs?.url ?? ''}
      onStart={() => void start()}
      onPublish={() => void publish()}
      onDismissError={() => setError('')}
      onDemoChange={setDemo}
    />
  );
}

export interface FirstRunViewProps {
  locale: string;
  alias: string;
  requestId: string;
  request: ProvisionRequest | null;
  trail: Trail;
  progress: FirstRunProgress;
  /** A última leitura falhou; com request conhecido, a tela mantém o progresso e sinaliza que ele está stale. */
  statusError: boolean;
  /** Epoch em segundos da última leitura bem-sucedida do status. */
  lastReadAt: number | null;
  published: boolean;
  error: string;
  busy: boolean;
  demo: boolean;
  demoUrl: string;
  onStart(): void;
  onPublish(): void;
  onDismissError(): void;
  onDemoChange(checked: boolean): void;
}

export function FirstRunView(props: FirstRunViewProps): JSX.Element {
  const { locale, alias, requestId, request, trail, progress, statusError, published, error, busy, demo, demoUrl } = props;
  const pt = locale === 'pt-BR';
  const expires = trail.expiresAt ? new Date(trail.expiresAt * 1000).toLocaleString(locale, { weekday: 'long', hour: '2-digit', minute: '2-digit' }) : '';
  const highlighted = progress.phase === 'running' || progress.phase === 'slow' || progress.phase === 'waiting-human' ? progress.current : null;
  const steps: StepsProps.Step[] = trail.steps.map(step => {
    const [header, details] = LABELS[step.id][pt ? 'pt' : 'en'];
    const extra = step.id === 'mr' && request?.mrUrl ? <Link href={request.mrUrl} external>{request.mrUrl}</Link>
      : step.state === 'slow' ? <span>{pt ? 'Demorando mais que o normal. ' : 'Taking longer than usual. '}<Link href={ARGO_CD_URL} external>{pt ? 'Ver no Argo CD' : 'Open Argo CD'}</Link></span>
        : step.state === 'error' ? <span>{request?.status === 'closed' ? (pt ? 'O merge request foi fechado sem merge.' : 'The merge request was closed without merging.') : request?.error}</span>
          : null;
    const title = step.id === highlighted
      ? <SpaceBetween direction="horizontal" size="xs" alignItems="center"><Box variant="strong">{header}</Box><Badge color="blue">{pt ? 'Agora' : 'Now'}</Badge></SpaceBetween>
      : header;
    return { status: STATUS[step.state], header: title, details: <SpaceBetween size="xxs"><Box variant="small">{details}</Box>{extra}</SpaceBetween> };
  });

  const expectation = pt
    ? `Esperado: cerca de ${formatDuration(SPIKE_TOTAL_SECONDS)} do pedido ao site, medido uma vez no spike de 28/09, mais o tempo da aprovação do operador.`
    : `Expected: about ${formatDuration(SPIKE_TOTAL_SECONDS)} from request to site, measured once in the 2026-09-28 spike, plus the operator approval time.`;

  return (
    <ContentLayout header={<Header variant="h1"
      description={pt ? 'Crie um site de verdade pelo caminho GitOps da plataforma, veja cada etapa acontecer, e amanhã ele some sozinho.' : 'Create a real site through the platform GitOps path, watch every step happen, and it goes away on its own tomorrow.'}
      actions={<Toggle checked={demo} onChange={({ detail }) => props.onDemoChange(detail.checked)}>{pt ? 'Modo demo' : 'Demo mode'}</Toggle>}>
      {alias ? (pt ? `Olá, ${alias}. Seus primeiros 10 minutos` : `Hi ${alias}. Your first 10 minutes`) : (pt ? 'Primeiros passos' : 'Getting started')}
    </Header>}>
      <SpaceBetween size="l">
        {!!error && <Alert type="error" dismissible onDismiss={props.onDismissError}>{error}</Alert>}
        <ColumnLayout columns={demo ? 2 : 1}>
          <Container header={<Header variant="h2" description={requestId ? undefined : expectation}
            actions={!requestId && progress.phase !== 'loading-identity' && <Button variant="primary" loading={busy} disabled={!alias} onClick={props.onStart}>{pt ? 'Criar meu site' : 'Create my site'}</Button>}>
            {pt ? 'Seu site' : 'Your site'}</Header>}>
            <SpaceBetween size="m">
              {progress.phase === 'loading-identity' && <StatusIndicator type="loading">{pt ? 'Carregando sua identidade e o pedido salvo...' : 'Loading your identity and saved request...'}</StatusIndicator>}
              {progress.phase === 'idle' && !!alias && <Box>{pt ? 'Um clique. Nada de console da AWS, nada de ticket.' : 'One click. No AWS console, no ticket.'}</Box>}
              {progress.phase === 'loading-status' && <StatusIndicator type="loading">{pt ? 'Lendo o status do seu pedido...' : 'Reading the status of your request...'}</StatusIndicator>}
              {progress.phase === 'status-error' && <LiveRegion><StatusIndicator type="error">{pt ? `Não consegui ler o status do seu pedido. Tentando de novo a cada ${POLL_MS / 1000} s.` : `Could not read the status of your request. Trying again every ${POLL_MS / 1000} s.`}</StatusIndicator></LiveRegion>}
              {statusError && !!request && <LiveRegion><StatusIndicator type="warning">{pt ? `Status temporariamente indisponível. Mostrando o último progresso conhecido e tentando de novo a cada ${POLL_MS / 1000} s.` : `Status temporarily unavailable. Showing the last known progress and trying again every ${POLL_MS / 1000} s.`}</StatusIndicator></LiveRegion>}
              {!!request && <RunProgress progress={progress} lastReadAt={props.lastReadAt} locale={locale} />}
              {!!request && <Steps steps={steps} />}
              {!!trail.url && <Alert type="success" header={pt ? 'Está no ar' : 'It is live'}
                action={!published && <Button onClick={props.onPublish}>{pt ? 'Publicar de novo' : 'Publish again'}</Button>}>
                <SpaceBetween size="xxs">
                  <Link href={trail.url} external fontSize="heading-m">{trail.url}</Link>
                  {!!expires && <Box variant="small">{pt ? `Seu site some ${expires}, depois que o operador aprovar a remoção.` : `Your site goes away ${expires}, once the operator approves the removal.`}</Box>}
                </SpaceBetween>
              </Alert>}
            </SpaceBetween>
          </Container>
          {demo && <Container header={<Header variant="h2" description={pt ? 'Mesmo golden path, criado antes, para mostrar enquanto o novo nasce.' : 'Same golden path, created earlier, to show while the new one is born.'}>{pt ? 'Pronto no forno' : 'Ready in the oven'}</Header>}>
            {demoUrl
              ? <Link href={demoUrl} external fontSize="heading-m">{demoUrl}</Link>
              : <Box color="text-status-inactive">{pt ? 'O demo-webapp ainda não foi provisionado.' : 'The demo-webapp is not provisioned yet.'}</Box>}
          </Container>}
        </ColumnLayout>
      </SpaceBetween>
    </ContentLayout>
  );
}

/** Bloco de progresso: etapa atual em destaque, barra pelas etapas concluídas, tempo medido, referência da etapa e polling. */
function RunProgress({ progress, lastReadAt, locale }: { progress: FirstRunProgress; lastReadAt: number | null; locale: string }): JSX.Element {
  const pt = locale === 'pt-BR';
  const label = stepLabel(progress.current, pt);
  const indicator: Record<FirstRunProgress['phase'], [StatusIndicatorProps.Type, string]> = {
    'loading-identity': ['loading', ''],
    'loading-status': ['loading', ''],
    'status-error': ['error', ''],
    idle: ['pending', ''],
    running: ['in-progress', pt ? `Agora: ${label}` : `Now: ${label}`],
    slow: ['warning', pt ? `Demorando mais que o normal: ${label}` : `Taking longer than usual: ${label}`],
    'waiting-human': ['pending', pt ? `Aguardando a aprovação do operador: ${label}` : `Waiting for the operator approval: ${label}`],
    done: ['success', pt ? 'Seu site está no ar' : 'Your site is live'],
    error: ['error', pt ? `Parou em: ${label}` : `Stopped at: ${label}`],
  };
  const [type, headline] = indicator[progress.phase];
  const settled = progress.phase === 'done' || progress.phase === 'error';
  const barStatus: ProgressBarProps.Status = progress.phase === 'done' ? 'success' : progress.phase === 'error' ? 'error' : 'in-progress';
  const counted = pt ? `${progress.done} de ${progress.total} etapas concluídas` : `${progress.done} of ${progress.total} steps done`;
  const timing = [
    progress.elapsedSeconds !== null && !settled
      ? (pt ? `Tempo desde o pedido: ${formatDuration(progress.elapsedSeconds)}, medido pelo horário em que o pedido foi gravado.` : `Time since the request: ${formatDuration(progress.elapsedSeconds)}, measured from when the request was recorded.`)
      : '',
    progress.phase === 'waiting-human'
      ? (pt ? 'Esta etapa não tem tempo esperado: depende do operador.' : 'This step has no expected time: it depends on the operator.')
      : progress.expectedStepSeconds !== null && !settled
        ? (pt ? `Referência para esta etapa: até cerca de ${formatDuration(progress.expectedStepSeconds)}.` : `Reference for this step: up to about ${formatDuration(progress.expectedStepSeconds)}.`)
        : '',
  ].filter(Boolean).join(' ');
  const lastRead = lastReadAt ? new Date(lastReadAt * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const polling = settled ? ''
    : pt ? `Verificando a cada ${POLL_MS / 1000} s.${lastRead ? ` Última atualização: ${lastRead}.` : ''}`
      : `Checking every ${POLL_MS / 1000} s.${lastRead ? ` Last update: ${lastRead}.` : ''}`;
  return (
    <SpaceBetween size="xs">
      <LiveRegion>
        <StatusIndicator type={type}>{headline}</StatusIndicator>
      </LiveRegion>
      <ProgressBar
        value={progress.percent}
        status={barStatus}
        label={pt ? 'Progresso do seu site' : 'Your site progress'}
        description={counted}
        additionalInfo={[timing, polling].filter(Boolean).join(' ') || undefined}
        resultText={settled ? counted : undefined}
      />
    </SpaceBetween>
  );
}
