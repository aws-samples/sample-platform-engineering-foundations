/*
 * Confirmação explícita das operações Day-2 que mexem em objeto vivo (Restart de workload, Delete de
 * pod). O clique no botão da tabela só ABRE este modal; a chamada à cluster-api sai do botão
 * Confirmar, com nome, namespace e efeito na tela. Scale segue no modal próprio que já pede o número.
 */
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';

export interface Day2Action {
  op: 'restart' | 'delete-pod';
  name: string;
  namespace: string;
  /** deployment | statefulset para restart; "pod" para delete. */
  kind: string;
}

export function day2Copy(action: Day2Action, pt: boolean): { header: string; effect: string; confirm: string } {
  if (action.op === 'restart') {
    return {
      header: pt ? `Reiniciar ${action.kind} ${action.name}?` : `Restart ${action.kind} ${action.name}?`,
      effect: pt ? 'O rollout recria todos os pods do workload; requisições em andamento podem cair durante a troca.'
        : 'The rollout recreates every pod of the workload; in-flight requests may drop during the swap.',
      confirm: pt ? 'Reiniciar' : 'Restart',
    };
  }
  return {
    header: pt ? `Excluir o pod ${action.name}?` : `Delete pod ${action.name}?`,
    effect: pt ? 'O pod é encerrado. Se um controller o gerencia, um pod novo é criado; senão, ele não volta.'
      : 'The pod is terminated. If a controller owns it, a new pod is created; otherwise it does not come back.',
    confirm: pt ? 'Excluir pod' : 'Delete pod',
  };
}

export function Day2ConfirmModal({ action, busy, pt, onCancel, onConfirm }: {
  action: Day2Action | null; busy: boolean; pt: boolean; onCancel(): void; onConfirm(action: Day2Action): void;
}): JSX.Element | null {
  if (!action) return null;
  const copy = day2Copy(action, pt);
  return (
    <Modal visible onDismiss={onCancel} header={copy.header}
      footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onCancel} disabled={busy}>{pt ? 'Cancelar' : 'Cancel'}</Button>
        <Button variant="primary" loading={busy} onClick={() => onConfirm(action)}>{copy.confirm}</Button>
      </SpaceBetween></Box>}>
      <SpaceBetween size="m">
        <KeyValuePairs columns={3} items={[
          { label: pt ? 'Nome' : 'Name', value: action.name },
          { label: 'Namespace', value: action.namespace },
          { label: pt ? 'Tipo' : 'Kind', value: action.kind },
        ]} />
        <Box>{copy.effect}</Box>
      </SpaceBetween>
    </Modal>
  );
}
