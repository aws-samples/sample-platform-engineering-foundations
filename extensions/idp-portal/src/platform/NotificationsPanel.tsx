/**
 * Central de notificações (notifications-center): o sino na barra superior abre este painel no
 * drawer `tools` do AppLayout. Fonte: `GET /platform/notifications` (eventos relevantes ao usuário:
 * ator é ele ou objeto num projeto visível), com lido/não lido por marca d'água e por evento.
 *
 * Polling de 60 s enquanto o shell está montado, para o badge do sino; leitura falha vira estado de
 * erro com retry, nunca "0 notificações". Clicar numa notificação marca o evento como lido e navega
 * para o link dele quando aponta para dentro do portal.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { errorMessage } from './errors';
import { actionLabel, eventTarget, objectLabel, relativeTime, resultIndicator } from './eventsModel';
import { getNotifications, markNotificationsRead, Notification, NotificationBox, PlatformApiError } from './platformApi';

export type NotificationsState =
  | { status: 'loading' }
  | { status: 'ready'; box: NotificationBox }
  | { status: 'disabled' }
  | { status: 'error'; message: string };

export const NOTIFICATIONS_POLL_MS = 60_000;

/** Estado das notificações com polling; o shell usa `unread` para o badge do sino. */
export function useNotifications(enabled = true): { state: NotificationsState; unread: number; refresh(): void; markAllRead(): Promise<void>; markRead(id: string): Promise<void> } {
  const [state, setState] = useState<NotificationsState>({ status: 'loading' });
  const alive = useRef(true);
  const load = useCallback(() => {
    getNotifications()
      .then(box => { if (alive.current) setState({ status: 'ready', box }); })
      .catch(cause => {
        if (!alive.current) return;
        // 503 = store desligado neste deployment: o sino não aparece, em vez de parecer quebrado.
        if (cause instanceof PlatformApiError && cause.status === 503) setState({ status: 'disabled' });
        else setState({ status: 'error', message: errorMessage(cause, 'notifications unavailable') });
      });
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!enabled) return undefined;
    load();
    const timer = window.setInterval(load, NOTIFICATIONS_POLL_MS);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [enabled, load]);
  const unread = state.status === 'ready' ? state.box.unread : 0;
  const markAllRead = useCallback(async () => {
    if (state.status !== 'ready' || state.box.items.length === 0) return;
    const latest = Math.max(...state.box.items.map(item => item.time));
    await markNotificationsRead({ until: latest });
    setState({ status: 'ready', box: { ...state.box, unread: 0, readAt: latest, items: state.box.items.map(item => ({ ...item, read: true })) } });
  }, [state]);
  const markRead = useCallback(async (id: string) => {
    if (state.status !== 'ready') return;
    const items = state.box.items.map(item => (item.id === id ? { ...item, read: true } : item));
    setState({ status: 'ready', box: { ...state.box, items, unread: items.filter(item => !item.read).length } });
    await markNotificationsRead({ eventId: id }).catch(() => undefined);
  }, [state]);
  return { state, unread, refresh: load, markAllRead, markRead };
}

export function NotificationsPanel({ state, pt, onMarkAllRead, onOpen, onRetry }: {
  state: NotificationsState; pt: boolean; onMarkAllRead(): void; onOpen(item: Notification, hash: string | null): void; onRetry(): void;
}): JSX.Element {
  if (state.status === 'loading') return <StatusIndicator type="loading">{pt ? 'Lendo notificações' : 'Reading notifications'}</StatusIndicator>;
  if (state.status === 'disabled') return <Box color="text-body-secondary">{pt ? 'Notificações desligadas neste deployment.' : 'Notifications are disabled in this deployment.'}</Box>;
  if (state.status === 'error') {
    return (
      <SpaceBetween size="s">
        <StatusIndicator type="error">{pt ? `Notificações não lidas: ${state.message}` : `Notifications not read: ${state.message}`}</StatusIndicator>
        <Button onClick={onRetry}>{pt ? 'Tentar de novo' : 'Retry'}</Button>
      </SpaceBetween>
    );
  }
  const { items, unread } = state.box;
  return (
    <SpaceBetween size="m">
      <SpaceBetween direction="horizontal" size="s" alignItems="center">
        <Box color="text-body-secondary">{pt ? `${unread} não lida(s) de ${items.length}` : `${unread} unread of ${items.length}`}</Box>
        <Button variant="inline-link" disabled={unread === 0} onClick={onMarkAllRead}>{pt ? 'Marcar todas como lidas' : 'Mark all as read'}</Button>
      </SpaceBetween>
      {items.length === 0 && <Box color="text-body-secondary">{pt ? 'Nada por aqui: nenhum evento nos seus projetos ainda.' : 'Nothing here: no event in your projects yet.'}</Box>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="notifications-list">
        {items.map(item => {
          const indicator = resultIndicator(item.result, pt);
          const target = eventTarget(item);
          return (
            <li key={item.id} data-read={item.read ? 'true' : 'false'} style={{ padding: '8px 0', borderBottom: '1px solid var(--color-border-divider-default, #e9ebed)' }}>
              <SpaceBetween size="xxs">
                <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                  {!item.read && <Box variant="span" fontWeight="bold" color="text-status-info" aria-label={pt ? 'não lida' : 'unread'}>●</Box>}
                  <Link onFollow={event => { event.preventDefault(); onOpen(item, target?.hash ?? null); }} href={target?.hash ?? '#'} fontSize="body-m">
                    <span style={{ fontWeight: item.read ? 400 : 700 }}>{actionLabel(item.action, pt)}</span>
                  </Link>
                  <StatusIndicator type={indicator.type}>{indicator.text}</StatusIndicator>
                </SpaceBetween>
                <Box fontSize="body-s">{objectLabel(item)}{item.detail ? ` · ${item.detail}` : ''}</Box>
                <Box fontSize="body-s" color="text-body-secondary">{pt ? 'por' : 'by'} {item.actor} · {relativeTime(item.time, pt)}</Box>
              </SpaceBetween>
            </li>
          );
        })}
      </ul>
    </SpaceBetween>
  );
}
