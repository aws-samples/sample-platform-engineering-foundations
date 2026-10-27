/**
 * Auditoria (audit-log): quem fez o quê, em ações Day 2, pedidos de provisionamento e planos do
 * Assistant. Fonte: `GET /platform/events`. Admin vê tudo e filtra por ator; quem não é admin vê
 * o que fez e o que aconteceu nos projetos visíveis (o servidor decide, a página só mostra `scope`).
 *
 * Fora daqui, de propósito: o histórico do CloudTrail (mudanças do lado AWS) continua no backlog
 * como item separado; esta trilha cobre o que passou pelo portal e pelo CI.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import Select, { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { errorMessage } from './errors';
import { actionLabel, EVENT_ACTIONS, eventTarget, matchesEvent, objectLabel, relativeTime, resultIndicator } from './eventsModel';
import { useI18n } from './i18n';
import { listEvents, objectTrail, PlatformApiError, PlatformEvent, PlatformEventList } from './platformApi';

type Load = { status: 'loading' } | { status: 'ready'; data: PlatformEventList } | { status: 'disabled' } | { status: 'error'; message: string };

const ALL: SelectProps.Option = { value: '', label: '-' };

export function AuditLogPage({ onNavigateHash }: { onNavigateHash(hash: string): void }): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [action, setAction] = useState<SelectProps.Option>(ALL);
  const [result, setResult] = useState<SelectProps.Option>(ALL);
  const [actor, setActor] = useState('');
  const [text, setText] = useState('');
  const refresh = useCallback(() => {
    setLoad({ status: 'loading' });
    listEvents({ action: action.value, result: result.value, actor: actor.trim(), limit: 200 })
      .then(data => setLoad({ status: 'ready', data }))
      .catch(cause => {
        if (cause instanceof PlatformApiError && cause.status === 503) setLoad({ status: 'disabled' });
        else setLoad({ status: 'error', message: errorMessage(cause, 'events unavailable') });
      });
  }, [action.value, result.value, actor]);
  useEffect(() => { refresh(); }, [refresh]);
  const rows = useMemo(() => (load.status === 'ready' ? load.data.items.filter(item => matchesEvent(item, text)) : []), [load, text]);
  const actionOptions = useMemo<SelectProps.Option[]>(() => [ALL, ...EVENT_ACTIONS.map(value => ({ value, label: actionLabel(value, pt) }))], [pt]);
  const resultOptions: SelectProps.Option[] = [ALL, { value: 'ok', label: 'ok' }, { value: 'failed', label: pt ? 'falhou' : 'failed' }, { value: 'denied', label: pt ? 'negado' : 'denied' }];
  const scopeText = load.status === 'ready'
    ? (load.data.scope === 'all' ? (pt ? 'Todos os eventos (admin).' : 'All events (admin).') : (pt ? 'Suas ações e os eventos dos seus projetos.' : 'Your actions and the events of your projects.'))
    : '';
  return (
    <ContentLayout header={(
      <Header variant="h1" actions={<Button iconName="refresh" onClick={refresh}>{pt ? 'Atualizar' : 'Refresh'}</Button>}
        description={pt
          ? 'Quem fez o quê pelo portal e pelo CI: pedidos de provisionamento, merge requests, planos do Assistant e ações Day 2. Cada evento leva ator, objeto, resultado e hora; eventos expiram em 90 dias.'
          : 'Who did what through the portal and the CI: provision requests, merge requests, Assistant plans and Day 2 actions. Each event carries actor, object, result and time; events expire after 90 days.'}>
        {pt ? 'Auditoria' : 'Audit log'}
      </Header>
    )}>
      <SpaceBetween size="m">
        <SpaceBetween direction="horizontal" size="s">
          <Select selectedOption={action} onChange={({ detail }) => setAction(detail.selectedOption)} options={actionOptions} ariaLabel={pt ? 'Ação' : 'Action'} placeholder={pt ? 'Ação' : 'Action'} />
          <Select selectedOption={result} onChange={({ detail }) => setResult(detail.selectedOption)} options={resultOptions} ariaLabel={pt ? 'Resultado' : 'Result'} placeholder={pt ? 'Resultado' : 'Result'} />
          {load.status === 'ready' && load.data.scope === 'all' && (
            <Input value={actor} onChange={({ detail }) => setActor(detail.value)} placeholder={pt ? 'Ator (alias)' : 'Actor (alias)'} ariaLabel={pt ? 'Ator' : 'Actor'} />
          )}
          <Input value={text} onChange={({ detail }) => setText(detail.value)} type="search" placeholder={pt ? 'Filtrar por objeto, projeto, detalhe' : 'Filter by object, project, detail'} ariaLabel={pt ? 'Filtro' : 'Filter'} />
        </SpaceBetween>
        {load.status === 'loading' && <StatusIndicator type="loading">{pt ? 'Lendo eventos' : 'Reading events'}</StatusIndicator>}
        {load.status === 'disabled' && <Box color="text-body-secondary">{pt ? 'Trilha de eventos desligada neste deployment.' : 'Event trail disabled in this deployment.'}</Box>}
        {load.status === 'error' && <StatusIndicator type="error">{pt ? `Eventos não lidos: ${load.message}` : `Events not read: ${load.message}`}</StatusIndicator>}
        {load.status === 'ready' && (
          <Table<PlatformEvent>
            variant="container"
            header={<Header counter={`(${rows.length})`} description={scopeText}>{pt ? 'Eventos' : 'Events'}</Header>}
            items={rows}
            trackBy="id"
            empty={<Box textAlign="center" color="text-body-secondary">{pt ? 'Nenhum evento com estes filtros.' : 'No event with these filters.'}</Box>}
            columnDefinitions={[
              { id: 'time', header: pt ? 'Quando' : 'When', cell: row => <span title={new Date(row.time * 1000).toISOString()}>{relativeTime(row.time, pt)}</span> },
              { id: 'actor', header: pt ? 'Ator' : 'Actor', cell: row => row.actor },
              {
                id: 'action', header: pt ? 'Ação' : 'Action', isRowHeader: true,
                cell: row => { const target = eventTarget(row); return target
                  ? <Link href={target.hash} onFollow={event => { event.preventDefault(); onNavigateHash(target.hash); }}>{actionLabel(row.action, pt)}</Link>
                  : actionLabel(row.action, pt); },
              },
              { id: 'object', header: pt ? 'Objeto' : 'Object', cell: row => objectLabel(row) },
              { id: 'project', header: pt ? 'Projeto' : 'Project', cell: row => row.project || '-' },
              { id: 'result', header: pt ? 'Resultado' : 'Result', cell: row => { const i = resultIndicator(row.result, pt); return <StatusIndicator type={i.type}>{i.text}</StatusIndicator>; } },
              { id: 'detail', header: pt ? 'Detalhe' : 'Detail', cell: row => row.detail || '-' },
              { id: 'source', header: pt ? 'Origem' : 'Source', cell: row => row.source || '-' },
            ]}
          />
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}

/** Trilha de UM objeto para o detalhe da instância: as ações do portal e do CI sobre ele. */
export function ObjectTrail({ kind, namespace, name }: { kind: string; namespace: string; name: string }): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const refresh = useCallback(() => {
    setLoad({ status: 'loading' });
    objectTrail(kind, namespace, name)
      .then(data => setLoad({ status: 'ready', data }))
      .catch(cause => {
        if (cause instanceof PlatformApiError && cause.status === 503) setLoad({ status: 'disabled' });
        else setLoad({ status: 'error', message: errorMessage(cause, 'events unavailable') });
      });
  }, [kind, namespace, name]);
  useEffect(() => { refresh(); }, [refresh]);
  if (load.status === 'loading') return <StatusIndicator type="loading">{pt ? 'Lendo trilha' : 'Reading trail'}</StatusIndicator>;
  if (load.status === 'disabled') return <Box color="text-body-secondary">{pt ? 'Trilha de eventos desligada neste deployment.' : 'Event trail disabled in this deployment.'}</Box>;
  if (load.status === 'error') return <StatusIndicator type="error">{pt ? `Trilha não lida: ${load.message}` : `Trail not read: ${load.message}`}</StatusIndicator>;
  if (load.data.items.length === 0) return <Box color="text-body-secondary">{pt ? 'Nenhuma ação registrada pelo portal ou pelo CI para este objeto.' : 'No action recorded by the portal or the CI for this object.'}</Box>;
  return (
    <Table<PlatformEvent>
      variant="borderless"
      items={load.data.items}
      trackBy="id"
      columnDefinitions={[
        { id: 'time', header: pt ? 'Quando' : 'When', cell: row => <span title={new Date(row.time * 1000).toISOString()}>{relativeTime(row.time, pt)}</span> },
        { id: 'actor', header: pt ? 'Ator' : 'Actor', cell: row => row.actor },
        { id: 'action', header: pt ? 'Ação' : 'Action', isRowHeader: true, cell: row => actionLabel(row.action, pt) },
        { id: 'result', header: pt ? 'Resultado' : 'Result', cell: row => { const i = resultIndicator(row.result, pt); return <StatusIndicator type={i.type}>{i.text}</StatusIndicator>; } },
        { id: 'detail', header: pt ? 'Detalhe' : 'Detail', cell: row => row.detail || '-' },
      ]}
    />
  );
}
