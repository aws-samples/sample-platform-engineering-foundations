/**
 * Modal "Promover para <ambiente>" (environments-promotion). Mostra o alvo resolvido do registry e o
 * manifest exato que vai para o pedido de infra; "Abrir merge request" grava o pedido no projeto ALVO
 * (o servidor valida namespace e cadeia `promotesTo`) e mostra o estado com o link para abrir o MR
 * agora. Nada é aplicado no cluster por aqui: o caminho de escrita continua sendo o MR.
 */
import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import { errorMessage } from './errors';
import type { InstanceDetail } from './kdpInventoryApi';
import { ProvisionRequest, createProvisionRequest, openMrNowUrl } from './platformApi';
import { buildPromotionPlan } from './promotion';
import type { PromotionTarget } from './scope/activeScope';

export function PromotionModal({ detail, target, pt, onDismiss }: {
  detail: InstanceDetail; target: PromotionTarget | null; pt: boolean; onDismiss: () => void;
}): JSX.Element | null {
  const [request, setRequest] = useState<ProvisionRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [edited, setEdited] = useState<string | null>(null);
  if (!target) return null;
  const plan = buildPromotionPlan(detail, target);
  const manifest = edited ?? plan.manifest;
  const envName = target.project.environment.name || target.project.environment.id;

  const submit = async () => {
    setBusy(true); setError('');
    try {
      setRequest(await createProvisionRequest({
        kind: 'infra', name: plan.name, capability: detail.capability, manifest,
        namespace: plan.namespace, promotedFrom: plan.promotedFrom,
      }));
    } catch (failure) {
      setError(errorMessage(failure, pt ? 'O pedido de promoção falhou' : 'The promotion request failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      visible
      size="large"
      onDismiss={onDismiss}
      header={pt ? `Promover para ${envName}` : `Promote to ${envName}`}
      footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onDismiss}>{request ? (pt ? 'Fechar' : 'Close') : (pt ? 'Cancelar' : 'Cancel')}</Button>
        {!request && <Button variant="primary" loading={busy} onClick={() => void submit()} data-testid="promotion-submit">
          {pt ? 'Abrir merge request' : 'Open merge request'}
        </Button>}
      </SpaceBetween></Box>}
    >
      <SpaceBetween size="m">
        <KeyValuePairs columns={2} items={[
          { label: pt ? 'Origem' : 'Source', value: `${target.source.name} · ${detail.metadata.namespace}/${detail.metadata.name}` },
          { label: pt ? 'Destino' : 'Target', value: `${target.project.name} · ${plan.namespace}/${plan.name}` },
          { label: pt ? 'Ambiente' : 'Environment', value: `${target.source.environment.name || target.source.environment.id} → ${envName}` },
          { label: pt ? 'Caminho de escrita' : 'Write path', value: `platform/instances/${plan.name}.yaml (merge request)` },
        ]} />
        {plan.name !== detail.metadata.name && (
          <Alert type="info" statusIconAriaLabel={pt ? 'Informação' : 'Info'}>
            {pt
              ? `Origem e destino aplicam o mesmo diretório GitOps, então a cópia se chama ${plan.name}. Com um cluster por ambiente o nome se mantém.`
              : `Source and target apply the same GitOps directory, so the copy is named ${plan.name}. With one cluster per environment the name is kept.`}
          </Alert>
        )}
        {plan.rewrites.length > 0 && (
          <Alert type="info" header={pt ? 'Identidade global reescrita no spec' : 'Global identity rewritten in the spec'} statusIconAriaLabel={pt ? 'Informação' : 'Info'}>
            <SpaceBetween size="xxs">
              <span>{pt
                ? 'Mesma conta e região: valores que embutiam o nome da instância ganharam o sufixo do ambiente, senão a cópia pediria o recurso que a origem já ocupa. Revise e edite abaixo se precisar.'
                : 'Same account and region: values embedding the instance name got the environment suffix, otherwise the copy would ask for the resource the source already holds. Review and edit below if needed.'}</span>
              {plan.rewrites.map((rewrite) => <code key={rewrite.path}>{rewrite.path}: {rewrite.from} → {rewrite.to}</code>)}
            </SpaceBetween>
          </Alert>
        )}
        <ExpandableSection headerText={pt ? 'Manifest que vai para o merge request (editável)' : 'Manifest going into the merge request (editable)'} defaultExpanded>
          <Textarea value={manifest} onChange={({ detail: change }) => setEdited(change.value)} disabled={request !== null}
            rows={Math.min(24, manifest.split('\n').length + 1)} spellcheck={false}
            ariaLabel={pt ? 'Manifest promovido' : 'Promoted manifest'} />
          <Box variant="small">{pt
            ? `O CI recusa o pedido se metadata.name sair de ${plan.name} ou metadata.namespace de ${plan.namespace}.`
            : `The CI refuses the request if metadata.name leaves ${plan.name} or metadata.namespace leaves ${plan.namespace}.`}</Box>
        </ExpandableSection>
        {error && <Alert type="error" statusIconAriaLabel={pt ? 'Erro' : 'Error'}>{error}</Alert>}
        {request && (
          <Alert type="success" header={pt ? 'Pedido registrado' : 'Request recorded'} statusIconAriaLabel={pt ? 'Sucesso' : 'Success'}>
            <SpaceBetween size="xs">
              <span>{pt
                ? `O bot abre o MR de ${request.path} sozinho em alguns minutos; o recurso aparece em ${target.project.name} depois do merge.`
                : `The bot opens the MR for ${request.path} on its own within minutes; the resource shows up in ${target.project.name} after the merge.`}</span>
              <Link href={openMrNowUrl(request.requestId)} external>{pt ? 'Abrir o MR agora (no GitLab, clique em Run pipeline)' : 'Open the MR now (in GitLab, click Run pipeline)'}</Link>
              <span>{pt ? `Pedido ${request.requestId}.` : `Request ${request.requestId}.`}</span>
            </SpaceBetween>
          </Alert>
        )}
      </SpaceBetween>
    </Modal>
  );
}
