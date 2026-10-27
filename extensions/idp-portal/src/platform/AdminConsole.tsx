import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useI18n } from './i18n';
import { getPlatformMe, listPlatformResources, onboardUser, PlatformMe, PlatformResource } from './platformApi';
import { errorMessage } from './errors';
import { gitMergeRequestsUrl } from './deployment';

const DELETE_MRS_URL = gitMergeRequestsUrl('state=opened&search=delete%3A');

export function AdminConsole(): JSX.Element {
  const { locale, t } = useI18n();
  const pt = locale === 'pt-BR';
  const [me, setMe] = useState<PlatformMe | null>(null);
  const [denied, setDenied] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [resources, setResources] = useState<PlatformResource[]>([]);
  const [alias, setAlias] = useState('');
  const [given, setGiven] = useState('');
  const [family, setFamily] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    getPlatformMe()
      .then(profile => {
        if (!profile.isAdmin) { setDenied(true); return; }
        setMe(profile);
        return listPlatformResources().then(r => setResources(r.resources));
      })
      .catch(cause => setLoadError(errorMessage(cause, 'platform API unavailable')));
  }, []);

  const onboard = async () => {
    setBusy(true); setError(''); setResult('');
    try {
      const r = await onboardUser(alias.trim(), given.trim(), family.trim());
      setResult(pt
        ? `${r.alias}: usuário ${r.userCreated ? 'criado' : 'já existia'}; ${r.addedToViewers ? 'adicionado ao' : 'já estava no'} grupo VIEWER.`
        : `${r.alias}: user ${r.userCreated ? 'created' : 'already existed'}; ${r.addedToViewers ? 'added to' : 'already in'} VIEWER group.`);
      setAlias(''); setGiven(''); setFamily('');
    } catch (cause) {
      setError(errorMessage(cause, 'onboarding failed'));
    } finally { setBusy(false); }
  };

  if (denied) {
    return <ContentLayout header={<Header variant="h1">{t('Admin console')}</Header>}>
      <Alert type="error" header={t('Access denied')}>{pt ? 'Esta seção exige um platform admin. A verificação é feita no servidor.' : 'This section requires a platform admin. The check is enforced server-side.'}</Alert>
    </ContentLayout>;
  }
  if (loadError) {
    return <ContentLayout header={<Header variant="h1">{t('Admin console')}</Header>}>
      <Alert type="error" header={pt ? 'Não foi possível verificar seu acesso' : 'Could not verify your access'}>
        {pt ? 'A platform-api não foi alcançada, então o portal não sabe se você é admin. Motivo: ' : 'The platform-api was not reached, so the portal cannot tell whether you are an admin. Reason: '}{loadError}
      </Alert>
    </ContentLayout>;
  }
  if (!me) {
    return <ContentLayout header={<Header variant="h1">{t('Admin console')}</Header>}><StatusIndicator type="loading">{t('Checking')}</StatusIndicator></ContentLayout>;
  }
  return (
    <ContentLayout header={<Header variant="h1" description={pt ? `Sessão admin verificada no servidor: ${me.alias}.` : `Server-verified admin session: ${me.alias}.`}>{t('Admin console')}</Header>}>
      <SpaceBetween size="l">
        <Container header={<Header variant="h2" description={pt ? 'ADR-0007: deleção só por MR "delete:" aprovado por você, seguida de remoção manual no mirror.' : 'ADR-0007: deletion only through a "delete:" MR you approve, followed by manual mirror removal.'}>{t('Deletion approvals')}</Header>}>
          <SpaceBetween size="s">
            <Button href={DELETE_MRS_URL} target="_blank" iconAlign="right" iconName="external">{pt ? 'Abrir MRs de deleção pendentes no GitLab' : 'Open pending deletion MRs in GitLab'}</Button>
            <Box variant="small">{pt ? 'O mirror é append-only: nada é removido do delivery sem sua ação manual documentada no runbook.' : 'The mirror is append-only: nothing leaves delivery without your manual, runbook-documented action.'}</Box>
          </SpaceBetween>
        </Container>
        <Container header={<Header variant="h2" description={pt ? 'Cria o usuário no Identity Center e adiciona ao grupo VIEWER do Argo CD.' : 'Creates the Identity Center user and adds it to the Argo CD VIEWER group.'}>{t('User onboarding')}</Header>}>
          <SpaceBetween size="m">
            {!!result && <Alert type="success">{result}</Alert>}
            {!!error && <Alert type="error">{error}</Alert>}
            <FormField label={pt ? 'Alias Amazon' : 'Amazon alias'}><Input value={alias} onChange={({ detail }) => setAlias(detail.value.toLowerCase())} /></FormField>
            <FormField label={pt ? 'Nome' : 'Given name'}><Input value={given} onChange={({ detail }) => setGiven(detail.value)} /></FormField>
            <FormField label={pt ? 'Sobrenome' : 'Family name'}><Input value={family} onChange={({ detail }) => setFamily(detail.value)} /></FormField>
            <Button variant="primary" onClick={onboard} loading={busy} disabled={!alias.trim() || !given.trim() || !family.trim()}>{pt ? 'Fazer onboarding como VIEWER' : 'Onboard as VIEWER'}</Button>
          </SpaceBetween>
        </Container>
        <Table
          header={<Header variant="h2" counter={`(${resources.length})`} description={pt ? 'Fonte live: AWS Tagging API, filtro ManagedBy=KRO-ACK.' : 'Live source: AWS Tagging API, ManagedBy=KRO-ACK filter.'}>{pt ? 'Recursos AWS provisionados pela plataforma' : 'AWS resources provisioned by the platform'}</Header>}
          items={resources}
          columnDefinitions={[
            { id: 'service', header: pt ? 'Serviço' : 'Service', cell: r => r.service },
            { id: 'name', header: t('Name'), cell: r => r.name },
            { id: 'env', header: t('Environment'), cell: r => r.environment || '-' },
            { id: 'retained', header: 'Retain', cell: r => <StatusIndicator type={r.retained ? 'success' : 'error'}>{r.retained ? 'auto-delete: no' : pt ? 'sem tag' : 'missing tag'}</StatusIndicator> },
            { id: 'arn', header: 'ARN', cell: r => <Link href={`https://console.aws.amazon.com/resource-groups/tag-editor/find-resources`} external>{r.arn.slice(-40)}</Link> },
          ]}
          empty={<Box textAlign="center">{pt ? 'Nenhum recurso provisionado ainda.' : 'No provisioned resources yet.'}</Box>}
        />
        <KeyValuePairs columns={3} items={[
          { label: pt ? 'Grupo de viewers' : 'Viewer group', value: me.viewerGroup },
          { label: pt ? 'Admins da plataforma' : 'Platform admins', value: me.alias },
          { label: 'Audit', value: pt ? 'Toda ação admin é logada na platform-api' : 'Every admin action is logged by the platform-api' },
        ]} />
      </SpaceBetween>
    </ContentLayout>
  );
}
