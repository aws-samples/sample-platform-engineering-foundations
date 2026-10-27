/*
 * Página Integrações (backlog integrations-health): uma linha por ferramenta da plataforma com o que
 * o servidor MEDIU agora (GET /cluster/integrations): estado, detalhe (versão, contagem, réplicas),
 * última leitura, dica de correção e o deep link do menu Ferramentas quando existe. Substitui a
 * lista de links atrás de port-forward por algo que diz se a ferramenta está de pé. Estado sempre
 * em texto + ícone (nunca só cor); falha de leitura da página inteira é erro nomeado.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import StatusIndicator, { StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { ARGO_CD_URL, CLUSTER_CONSOLES } from './catalog';
import { errorMessage } from './errors';
import { relativeTime } from './eventsModel';
import { useI18n } from './i18n';
import { IntegrationRow, IntegrationStatus, IntegrationsResponse, InventoryError, getIntegrations } from './kdpInventoryApi';
import { LoadFailure } from './KdpInventoryParts';

type Load = { status: 'loading' } | { status: 'ready'; data: IntegrationsResponse } | { status: 'error'; message: string; httpStatus?: number };

const REFRESH_MS = 60_000;

/** Deep link por integração: os mesmos destinos do menu Ferramentas. Sem link = ferramenta sem UI própria. */
export const INTEGRATION_LINKS: Record<string, string> = {
  argocd: ARGO_CD_URL,
  kro: '#compositions',
  keycloak: CLUSTER_CONSOLES['Keycloak'],
  events: '#audit',
};

export function statusIndicator(status: IntegrationStatus, pt: boolean): { type: StatusIndicatorProps.Type; text: string } {
  switch (status) {
    case 'ok': return { type: 'success', text: pt ? 'OK' : 'OK' };
    case 'degraded': return { type: 'warning', text: pt ? 'Degradada' : 'Degraded' };
    case 'failed': return { type: 'error', text: pt ? 'Falha' : 'Failed' };
    default: return { type: 'stopped', text: pt ? 'Não medida' : 'Not measured' };
  }
}

function Kpi({ label, value }: { label: string; value: number }): JSX.Element {
  return <div><Box variant="awsui-key-label">{label}</Box><Box fontSize="display-l" fontWeight="bold">{value}</Box></div>;
}

export function IntegrationsPage(): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const gate = useRef(new AbortController());

  useEffect(() => {
    gate.current.abort();
    const controller = new AbortController();
    gate.current = controller;
    let active = true;
    const read = async () => {
      try {
        const data = await getIntegrations(controller.signal);
        if (active) setLoad({ status: 'ready', data });
      } catch (cause) {
        if (!active || (cause instanceof InventoryError && cause.aborted)) return;
        setLoad({ status: 'error', message: errorMessage(cause, 'cluster-api unavailable'), httpStatus: cause instanceof InventoryError ? cause.status : undefined });
      }
    };
    void read();
    const interval = window.setInterval(() => void read(), REFRESH_MS);
    return () => { active = false; controller.abort(); window.clearInterval(interval); };
  }, [nonce]);
  const retry = useCallback(() => { setLoad({ status: 'loading' }); setNonce((v) => v + 1); }, []);

  const header = (
    <Header variant="h1"
      counter={load.status === 'ready' ? `(${load.data.items.length})` : undefined}
      description={pt
        ? 'Cada linha é o que a cluster-api mediu agora: alcance, contagem, réplicas e última leitura. Argo CD, kro e ACK rodam como EKS Capabilities, então a saúde deles é a dos objetos que publicam. Falha de leitura aparece como falha, nunca como OK.'
        : 'Each row is what the cluster-api measured now: reachability, counts, replicas and last read. Argo CD, kro and ACK run as EKS Capabilities, so their health is that of the objects they publish. A read failure shows as a failure, never as OK.'}
      actions={<Button iconName="refresh" onClick={retry}>{pt ? 'Medir de novo' : 'Measure again'}</Button>}
    >{pt ? 'Integrações' : 'Integrations'}</Header>
  );

  if (load.status === 'loading') return <ContentLayout header={header}><StatusIndicator type="loading">{pt ? 'Medindo as integrações' : 'Measuring the integrations'}</StatusIndicator></ContentLayout>;
  if (load.status === 'error') return <ContentLayout header={header}><LoadFailure message={load.message} status={load.httpStatus} pt={pt} onRetry={retry} /></ContentLayout>;

  const { data } = load;
  return (
    <ContentLayout header={header}>
      <SpaceBetween size="l">
        <Container>
          <ColumnLayout columns={4} variant="text-grid">
            <Kpi label="OK" value={data.summary.ok} />
            <Kpi label={pt ? 'Degradadas' : 'Degraded'} value={data.summary.degraded} />
            <Kpi label={pt ? 'Falhas' : 'Failed'} value={data.summary.failed} />
            <Kpi label={pt ? 'Não medidas' : 'Not measured'} value={data.summary.unknown} />
          </ColumnLayout>
        </Container>
        <Table<IntegrationRow>
          items={data.items}
          trackBy="id"
          variant="container"
          header={<Header variant="h2">{pt ? 'Ferramentas' : 'Tools'}</Header>}
          columnDefinitions={[
            { id: 'name', header: pt ? 'Integração' : 'Integration', cell: (row) => INTEGRATION_LINKS[row.id]
              ? <Link href={INTEGRATION_LINKS[row.id]} external={!INTEGRATION_LINKS[row.id].startsWith('#')}>{row.name}</Link>
              : row.name },
            { id: 'plane', header: pt ? 'Plano' : 'Plane', cell: (row) => row.plane },
            { id: 'status', header: pt ? 'Estado' : 'Status', cell: (row) => { const s = statusIndicator(row.status, pt); return <StatusIndicator type={s.type}>{s.text}</StatusIndicator>; } },
            { id: 'detail', header: pt ? 'Medido' : 'Measured', cell: (row) => row.detail },
            { id: 'hint', header: pt ? 'Dica' : 'Hint', cell: (row) => row.hint ? <code>{row.hint}</code> : '-' },
            { id: 'readAt', header: pt ? 'Última leitura' : 'Last read', cell: (row) => relativeTime(row.readAt, pt) },
          ]}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
