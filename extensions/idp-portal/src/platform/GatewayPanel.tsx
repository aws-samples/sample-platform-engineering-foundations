import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import { chatWithGateway, checkGatewayHealth, GatewayAuditRecord, GatewayOperations, loadGatewayOperations } from './gatewayApi';
import { useI18n } from './i18n';
import { errorMessage } from './errors';
import { INTERNAL } from './deployment';

export function GatewayPanel(): JSX.Element {
  const { locale, t } = useI18n();
  const pt = locale === 'pt-BR';
  const [health, setHealth] = useState<'unknown' | 'loading' | 'healthy' | 'error'>('unknown');
  const [modelAlias, setModelAlias] = useState('claude-sonnet');
  const [message, setMessage] = useState(pt ? 'Explique o papel do kro e ACK nesta plataforma em três frases.' : 'Explain the role of kro and ACK in this platform in three sentences.');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [operations, setOperations] = useState<GatewayOperations | null>(null);
  const [loadingOperations, setLoadingOperations] = useState(false);

  const checkHealth = async () => {
    setHealth('loading');
    setError('');
    try {
      const result = await checkGatewayHealth();
      setModelAlias(result.modelAlias);
      setHealth('healthy');
    } catch (cause) {
      setError(errorMessage(cause, (pt ? 'Falha ao verificar saúde do gateway.' : 'Gateway health check failed.')));
      setHealth('error');
    }
  };

  const loadOperations = async () => {
    setLoadingOperations(true);
    setError('');
    try {
      setOperations(await loadGatewayOperations());
    } catch (cause) {
      setError(errorMessage(cause, (pt ? 'Falha ao carregar dados operacionais.' : 'Operational data failed to load.')));
    } finally {
      setLoadingOperations(false);
    }
  };

  const send = async () => {
    setSending(true);
    setError('');
    setAnswer('');
    try {
      setAnswer(await chatWithGateway(message));
    } catch (cause) {
      setError(errorMessage(cause, (pt ? 'Falha na chamada ao gateway.' : 'Gateway request failed.')));
    } finally {
      setSending(false);
    }
  };

  const indicator = health === 'healthy'
    ? <StatusIndicator type="success">{t('Healthy')}</StatusIndicator>
    : health === 'error'
      ? <StatusIndicator type="error">{t('Unavailable')}</StatusIndicator>
      : health === 'loading'
        ? <StatusIndicator type="loading">{t('Checking')}</StatusIndicator>
        : <StatusIndicator type="pending">{t('Not checked')}</StatusIndicator>;

  return (
    <SpaceBetween size="l">
      <Alert type="warning" header={t('Platform administrator feature')}>
        {pt ? 'As operações do AI Gateway estão restritas a aliases de administradores configurados. Outros usuários podem navegar no catálogo e Argo CD conforme seu acesso.' : 'AI Gateway operations are currently restricted to configured administrator aliases. Other portal users can browse the catalog and Argo CD according to their own access.'}
      </Alert>
      <Alert type="info" header={t('Private data path')}>
        {INTERNAL ? (pt ? 'O the internal gateway assina a chamada ao BFF com SigV4. O BFF injeta a API key dentro da VPC e alcança o AI Gateway privado pelo VPC endpoint. Nenhuma credencial chega ao browser.' : 'the internal gateway signs the BFF request with SigV4. The BFF injects the API key inside the VPC and reaches the private AI Gateway through its VPC endpoint. No gateway credential reaches this browser.') : (pt ? 'Neste deployment o BFF e o AI Gateway privado não estão publicados; o Assistant e o Agent Builder ficam desligados.' : 'This deployment does not publish the BFF nor the private AI Gateway; the Assistant and the Agent Builder are off.')}
      </Alert>
      {!!error && <Alert type="error" header={t('Request failed')}>{error}</Alert>}
      <Container header={<Header variant="h2" actions={<SpaceBetween direction="horizontal" size="xs"><Button onClick={checkHealth} loading={health === 'loading'}>{t('Check health')}</Button><Button onClick={loadOperations} loading={loadingOperations}>{t('Load operations')}</Button></SpaceBetween>}>{t('Gateway status')}</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          <div><Box variant="awsui-key-label">{t('Status')}</Box>{indicator}</div>
          <div><Box variant="awsui-key-label">{t('Model alias')}</Box>{modelAlias}</div>
          <div><Box variant="awsui-key-label">{t('Provider')}</Box>Amazon Bedrock</div>
        </ColumnLayout>
      </Container>
      {operations && (
        <SpaceBetween size="l">
          <ColumnLayout columns={2}>
            <Container header={<Header variant="h2">{t('Governance')}</Header>}>
              <ColumnLayout columns={2} variant="text-grid">
                <div><Box variant="awsui-key-label">{t('Aliases')}</Box>{operations.config.modelAliases.join(', ')}</div>
                <div><Box variant="awsui-key-label">{t('Auto cheapest')}</Box>{operations.config.autoCheapest ? t('Enabled') : t('Disabled')}</div>
                <div><Box variant="awsui-key-label">{t('Cache TTL')}</Box>{operations.config.cacheTtlSeconds}s</div>
                <div><Box variant="awsui-key-label">{t('Budget')}</Box>{operations.config.budget.configured ? t('Configured') : t('Not configured')}</div>
                <div><Box variant="awsui-key-label">{t('Guardrails')}</Box>{operations.config.guardrails.enabled ? operations.config.guardrails.policies.join(', ') : t('Disabled')}</div>
              </ColumnLayout>
            </Container>
            <Container header={<Header variant="h2">{t('Usage and cost')}</Header>}>
              <ColumnLayout columns={2} variant="text-grid">
                <div><Box variant="awsui-key-label">{t('Requests')} ({pt ? 'últimos' : 'last'} {operations.usage.windowDays} {pt ? 'dias' : 'days'})</Box>{operations.usage.requests}{operations.usage.requestsAreComplete ? '' : '+'}</div>
                <div><Box variant="awsui-key-label">{t('Tokens')}</Box>{operations.usage.tokensIn + operations.usage.tokensOut}</div>
                <div><Box variant="awsui-key-label">{t('Estimated cost')}</Box>${operations.usage.estimatedCostUsd.toFixed(6)}</div>
                <div><Box variant="awsui-key-label">{t('Cache hits')}</Box>{operations.usage.cacheHits}</div>
                <div><Box variant="awsui-key-label">{t('Errors')}</Box>{operations.usage.errors}</div>
              </ColumnLayout>
            </Container>
          </ColumnLayout>
          <Table
            header={<Header variant="h2" counter={`(${operations.audit.count}${operations.audit.hasMore ? '+' : ''})`}>{t('Recent audit activity')}</Header>}
            items={operations.audit.records}
            columnDefinitions={[
              { id: 'timestamp', header: t('Timestamp'), cell: (item: GatewayAuditRecord) => item.timestamp || '-' },
              { id: 'category', header: t('Category'), cell: (item: GatewayAuditRecord) => item.category || '-' },
              { id: 'action', header: t('Action'), cell: (item: GatewayAuditRecord) => item.action || '-' },
              { id: 'target', header: t('Target'), cell: (item: GatewayAuditRecord) => item.target || '-' },
              { id: 'role', header: t('Actor role'), cell: (item: GatewayAuditRecord) => item.actorRole || '-' },
            ]}
            empty={<Box textAlign="center">{t('No audit records found')}</Box>}
          />
        </SpaceBetween>
      )}
      <Container header={<Header variant="h2" description={pt ? 'Playground Bedrock-only pelo BFF governado.' : 'Bedrock-only playground through the governed BFF.'}>{t('Playground')}</Header>}>
        <SpaceBetween size="m">
          <FormField label={t('Message')} description={pt ? 'Máximo de 2.048 caracteres. O modelo é selecionado pelo alias da plataforma.' : 'Maximum 2,048 characters. The model is selected by the platform alias.'}>
            <Textarea value={message} onChange={({ detail }) => setMessage(detail.value)} rows={5} />
          </FormField>
          <Button variant="primary" onClick={send} loading={sending} disabled={!message.trim()}>{t('Send')}</Button>
          {!!answer && <Box padding="m" variant="div">{answer}</Box>}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
