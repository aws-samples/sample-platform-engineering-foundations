import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select, { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Textarea from '@cloudscape-design/components/textarea';
import Tiles from '@cloudscape-design/components/tiles';
import Wizard from '@cloudscape-design/components/wizard';
import { parse } from 'yaml';
import { generateArtifact } from './gatewayApi';
import { createProvisionRequest, getProvisionRequest, isSettled, openMrNowUrl, ProvisionRequest } from './platformApi';
import { useI18n } from './i18n';
import { lintAgentJson, lintInfrastructureYaml, LintResult } from './manifestLint';
import { agentCapabilities, capabilities, infrastructureCapabilities } from './catalogLoader';
import { clearedCreateLocation, resolveCreateCapability } from './serviceCatalog';
import { namespaceOf, withNamespace, withOwnerLabel } from './manifestNamespace';
import { errorMessage } from './errors';
import { schemaFor } from './capabilitySchemas';
import { specOf, unknownSpecKeys, withSpecValue } from './manifestSpec';
import { formModelFromSchema, FormValues, validateValues } from './serviceStudio/schemaForm';
import { SchemaFormPreview } from './serviceStudio/ServiceStudioParts';
import { infraTarget, offersManualFallback, targetNamespace } from './createTarget';
import { setProjectDraft } from './shellNavigation';
import type { ScopeProject } from './scope/scopeModel';
import { gitNewFileUrl } from './deployment';

const DEFAULT_INFRA_CAP = infrastructureCapabilities.find(c => c.lifecycle !== 'planned') ?? infrastructureCapabilities[0];
const INFRA = DEFAULT_INFRA_CAP?.exampleYaml ?? `apiVersion: kro.run/v1alpha1
kind: DynamoDBTable
metadata:
  name: sample-table
  namespace: appmod
spec:
  name: sample-table
  hashKeyName: id
  hashKeyType: S
  environment: internal
`;

function statusSuffix(lifecycle: string, pt: boolean): string {
  if (lifecycle === 'available') return '';
  if (lifecycle === 'preview') return ' (preview)';
  return pt ? ' (planejado)' : ' (planned)';
}

const AGENT = JSON.stringify({
  name: 'eks-health-agent', description: 'Summarizes EKS health using approved tools.', model: 'claude-sonnet',
  runtime: { type: 'scheduled', schedule: '0 10 * * 1', timeoutSeconds: 900, retries: 2 },
  instructions: ['Read the declared inputs', 'Use only allowed tools', 'Return a structured summary'],
  tools: [], skills: [], observability: { traces: true, evaluations: true },
  security: { networkProfile: 'restricted', dataClassification: 'internal-restricted' },
}, null, 2);

/**
 * `project`: o projeto ativo do shell. É dele que saem o namespace e a permissão de Create de infra:
 * projeto com outro diretório GitOps (agent-builder) ou fora de `active` bloqueia o envio, e o
 * namespace fica restrito aos do projeto. Sem projeto (compat, todos), o servidor decide o dono.
 */
export function ProvisioningFlow({ project = null }: { project?: ScopeProject | null } = {}): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const target = infraTarget(project);
  const initial = useMemo(() => {
    /*
     * Qual capability abrir: `resolveCreateCapability` decide por precedência intent > hash >
     * query, e devolve QUAL sinal venceu. O que havia aqui lia a query primeiro, então um
     * `?capability=` de uma visita anterior vencia o clique que o usuário acabou de dar.
     */
    const resolved = resolveCreateCapability({
      search: window.location.search,
      hash: window.location.hash,
      capabilities,
      fallback: DEFAULT_INFRA_CAP ?? null,
    });
    const capability = resolved.capability ?? DEFAULT_INFRA_CAP;
    return {
      capability,
      kind: capability?.domain === 'agent' ? 'agent' as const : 'infra' as const,
      namespace: resolved.namespace,
      source: resolved.source,
    };
  }, []);
  /*
   * Consumido, o sinal sai da URL - mantendo a view. Enquanto `capability`/`ns` ficavam lá, o
   * próximo Create herdava a escolha antiga. `replaceState` não cria entrada de history, então o
   * Back do usuário continua indo para onde ele veio.
   */
  useEffect(() => {
    const cleared = clearedCreateLocation(window.location.search, window.location.hash);
    if (!cleared.changed) return;
    window.history.replaceState(null, '', `${window.location.pathname}${cleared.search}${cleared.hash}`);
  }, []);
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<'infra' | 'agent'>(initial.kind);
  const [environment, setEnvironment] = useState('internal');
  const [lifecycle, setLifecycle] = useState('persistent');
  const [name, setName] = useState('reports');
  const [owner, setOwner] = useState('platform-team');
  const [namespace, setNamespace] = useState(targetNamespace(target, initial.namespace));
  const [type, setType] = useState<SelectProps.Option | null>(initial.capability ? { label: pt ? initial.capability.displayNamePt : initial.capability.displayName, value: initial.capability.id } : null);
  const [architecture, setArchitecture] = useState('arm64');
  const [runtimeBase, setRuntimeBase] = useState('al2023');
  const [targetRegion, setTargetRegion] = useState<SelectProps.Option | null>({ label: 'sa-east-1 (São Paulo)', value: 'sa-east-1' });
  const [profile, setProfile] = useState('standard');
  const [customProfile, setCustomProfile] = useState('2 vCPU / 4 GiB');
  const [networkProfile, setNetworkProfile] = useState<SelectProps.Option | null>({ label: 'restricted', value: 'restricted' });
  const [schedule, setSchedule] = useState('0 10 * * 1');
  const [timeoutSeconds, setTimeoutSeconds] = useState('900');
  const [prompt, setPrompt] = useState(pt ? 'Crie uma capability privada, criptografada e retida na exclusão.' : 'Create a private encrypted capability retained on deletion.');
  // O manifest nasce JÁ com o namespace pedido: é por ele que o namespace alcança o backend, cujo
  // contrato (`{kind, name, capability, manifest}`) não tem campo de namespace nenhum.
  const [artifact, setArtifact] = useState(initial.kind === 'infra'
    ? withNamespace(initial.capability?.exampleYaml ?? INFRA, targetNamespace(target, initial.namespace))
    : AGENT);
  const [lint, setLint] = useState<LintResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [proposalUrl, setProposalUrl] = useState('');
  const [request, setRequest] = useState<ProvisionRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Trocar de projeto (o shell não remonta o wizard) reaplica um namespace que pertença ao novo.
  const targetKey = target.allowed ? (target.namespaces ?? []).join(',') : '';
  useEffect(() => {
    const next = targetNamespace(target, namespace);
    if (next === namespace) return;
    setNamespace(next);
    if (kind === 'infra') { setArtifact(current => withNamespace(current, next)); setLint(null); }
  }, [targetKey]);

  // Rascunho preso ao projeto: o shell confirma antes de trocar de projeto com o wizard alterado.
  const pristine = useRef({ artifact, name, prompt });
  const dirty = !request && (step > 0 || artifact !== pristine.current.artifact || name !== pristine.current.name
    || prompt !== pristine.current.prompt);
  useEffect(() => {
    setProjectDraft('provision', dirty ? (pt ? 'wizard de Create' : 'Create wizard') : null);
    return () => setProjectDraft('provision', null);
  }, [dirty, pt]);

  // Poll until the CI job settles the request. The bound keeps a forgotten tab from polling
  // forever: after 30 min the user still has the request id and the GitLab link.
  useEffect(() => {
    if (!request || isSettled(request.status)) return;
    const startedAt = Date.now();
    const timer = window.setInterval(async () => {
      if (Date.now() - startedAt > 30 * 60 * 1000) { window.clearInterval(timer); return; }
      try { setRequest(await getProvisionRequest(request.requestId)); } catch { /* transient: keep polling */ }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [request?.requestId, request?.status]);

  const options: SelectProps.Option[] = kind === 'infra'
    ? infrastructureCapabilities.map(c => ({
        label: (pt ? c.displayNamePt : c.displayName) + statusSuffix(c.lifecycle, pt),
        value: c.id,
        description: `${c.pattern} · ${c.domain}`,
        disabled: c.lifecycle === 'planned',
      }))
    : agentCapabilities.map(c => ({
        label: (pt ? c.displayNamePt : c.displayName) + statusSuffix(c.lifecycle, pt),
        value: c.id,
        description: `${c.pattern} · ${c.domain}`,
        disabled: c.lifecycle === 'planned',
      }));

  const selectCapability = (option: SelectProps.Option | null) => {
    setType(option);
    if (kind === 'infra' && option) {
      const cap = infrastructureCapabilities.find(c => c.id === option.value);
      // Trocar a capability troca o exemplo, e o exemplo traz o namespace default do arquivo. O
      // namespace que o usuário (ou a listagem live) escolheu é reaplicado, senão a escolha dele
      // desaparecia ao mexer no Select.
      if (cap?.exampleYaml) { setArtifact(withNamespace(cap.exampleYaml, namespace)); setLint(null); }
    }
  };

  const lintArtifact = (value = artifact) => {
    const result = kind === 'infra' ? lintInfrastructureYaml(value) : lintAgentJson(value);
    setLint(result);
    return result;
  };

  const changeKind = (next: string) => {
    const target = next as 'infra' | 'agent';
    setKind(target); setArtifact(target === 'infra' ? INFRA : AGENT); setName(target === 'infra' ? 'reports' : 'eks-health-agent');
    setType(target === 'infra'
      ? (DEFAULT_INFRA_CAP ? { label: pt ? DEFAULT_INFRA_CAP.displayNamePt : DEFAULT_INFRA_CAP.displayName, value: DEFAULT_INFRA_CAP.id } : null)
      : { label: pt ? 'Agent agendado' : 'Scheduled agent', value: 'scheduled' });
    setLint(null); setProposalUrl(''); setRequest(null);
  };

  const generate = async () => {
    setGenerating(true); setError('');
    try {
      const constraints = `Name: ${name}; owner: ${owner}; environment: ${environment}; region: ${targetRegion?.value}; architecture: ${architecture}; profile: ${profile}; network: ${networkProfile?.value}.`;
      const result = await generateArtifact(kind, `${prompt}\n\nPlatform request fields:\n${constraints}`, artifact);
      const cleaned = result.artifact.replace(/^```(?:yaml|json)?\s*/i, '').replace(/\s*```$/, '');
      setArtifact(cleaned); lintArtifact(cleaned);
    } catch (cause) { setError(errorMessage(cause, (pt ? 'Falha na geração.' : 'Generation failed.'))); }
    finally { setGenerating(false); }
  };

  /*
   * Formulário gerado do schema.json publicado da capability, pelo MESMO renderer do Service Owner
   * Studio (issue #11): o que o Service Owner pré-visualiza é o que o consumidor preenche aqui.
   * Capability sem schema segue só no YAML, como antes. O form edita o `spec` do manifest; o YAML
   * continua editável e é ele que vai no pedido, então nenhum caminho existente regride.
   */
  const capabilitySchema = kind === 'infra' ? schemaFor(String(type?.value ?? '')) : undefined;
  const formFields = useMemo(() => capabilitySchema ? formModelFromSchema(capabilitySchema) : [], [capabilitySchema]);
  const manifestSpec = formFields.length ? specOf(artifact) : null;
  const formValues: FormValues = manifestSpec
    ? Object.fromEntries(formFields.filter(field => field.name in manifestSpec).map(field => [field.name, manifestSpec[field.name]]))
    : {};
  const formErrors = manifestSpec ? validateValues(formFields, formValues) : [];
  const extraSpecKeys = unknownSpecKeys(manifestSpec, formFields.map(field => field.name));
  const setSpecValue = (field: string, value: unknown) => { setArtifact(withNamespace(withSpecValue(artifact, field, value), namespace)); setLint(null); };

  const profileLabel = profile === 'standard' ? 'Standard' : profile === 'gpu' ? 'GPU' : `Custom: ${customProfile}`;
  const review = useMemo(() => ({
    target: kind === 'infra' ? (pt ? 'Infraestrutura' : 'Infrastructure') : 'Agent',
    environment: environment === 'internal' ? (pt ? 'Interno AppMod' : 'Internal AppMod') : (pt ? 'Demo para cliente' : 'Customer demo'),
    lifecycle: lifecycle === 'persistent' ? 'Persistent / Retain' : 'Ephemeral', name, owner, namespace,
    type: String(type?.label ?? '-'), architecture: kind === 'agent' ? architecture : 'N/A', runtimeBase: kind === 'agent' ? runtimeBase.toUpperCase() : 'Managed by ACK/kro',
    region: String(targetRegion?.label ?? '-'), profile: profileLabel, network: String(networkProfile?.label ?? '-'),
  }), [architecture, environment, kind, lifecycle, name, namespace, networkProfile, owner, profileLabel, pt, runtimeBase, targetRegion, type]);

  const prepareProposal = async () => {
    // Agents implantáveis nascem no Agent Builder (ADR-0008): o portal deixa de gravar kind: agent.
    if (kind === 'agent') {
      setError(pt ? 'Agents agora são criados no Agent Builder, que valida, compila e abre o MR.' : 'Agents are now created in the Agent Builder, which validates, compiles and opens the MR.');
      return;
    }
    if (!target.allowed) {
      setError(target.reason === 'gitops_path'
        ? (pt ? `O projeto ${target.project.name} escreve em ${target.project.gitopsPath}; instâncias de infra só existem em platform/instances. Escolha outro projeto.` : `Project ${target.project.name} writes ${target.project.gitopsPath}; infra instances only live in platform/instances. Choose another project.`)
        : (pt ? `O projeto ${target.project.name} está ${target.project.lifecycle.state}: não aceita pedidos novos.` : `Project ${target.project.name} is ${target.project.lifecycle.state}: it accepts no new requests.`));
      return;
    }
    if (target.namespaces && !target.namespaces.includes(namespace)) {
      setError(pt ? `O namespace ${namespace} não é do projeto ${project?.name}.` : `Namespace ${namespace} is not part of project ${project?.name}.`);
      return;
    }
    const result = lintArtifact();
    if (result.errors.length) { setError(pt ? 'Corrija os erros de lint antes de propor.' : 'Fix lint errors before proposing.'); return; }
    if (formErrors.length) { setError(pt ? `O spec não atende ao schema da capability: ${formErrors.map(e => e.name).join(', ')}.` : `The spec does not satisfy the capability schema: ${formErrors.map(e => e.name).join(', ')}.`); return; }
    /*
     * O manifest ENVIADO leva o namespace do wizard. Sem isto, um pedido vindo de
     * `?ns=team-a` era gravado no namespace default do exemplo: o campo da tela dizia uma coisa e
     * o arquivo do MR dizia outra. `withNamespace` só mexe em `metadata.namespace`, então o resto
     * do artefato (inclusive comentários) chega ao MR como o usuário o viu.
     */
    // Owner / Team do formulário vira label no manifest (ownership-model): só para infra, que é YAML.
    const submitted = kind === 'infra' ? withOwnerLabel(withNamespace(artifact, namespace), owner) : withNamespace(artifact, namespace);
    if (submitted !== artifact) setArtifact(submitted);
    const artifactName = kind === 'infra' ? ((parse(submitted) as { metadata?: { name?: string } })?.metadata?.name ?? name) : ((JSON.parse(submitted) as { name?: string }).name ?? name);
    setError(''); setSubmitting(true);
    try {
      setRequest(await createProvisionRequest({ kind, name: artifactName, capability: String(type?.value ?? ''), manifest: submitted, namespace }));
      setProposalUrl('');
    } catch (cause) {
      // 4xx é o servidor recusando (escopo, papel, validação): mostra o motivo e não oferece atalho.
      if (!offersManualFallback(cause)) {
        setProposalUrl('');
        setError(errorMessage(cause, pt ? 'O servidor recusou o pedido.' : 'The server refused the request.'));
        return;
      }
      // Rede ou 5xx: o caminho que sempre funcionou. Copia o artefato e abre o new-file do GitLab.
      await navigator.clipboard.writeText(submitted).catch(() => undefined);
      const base = kind === 'infra' ? 'platform/instances' : 'docs/agent-definitions';
      setProposalUrl(gitNewFileUrl(`${base}/${artifactName}.${kind === 'infra' ? 'yaml' : 'json'}`));
      setError(errorMessage(cause, pt ? 'Não foi possível registrar o pedido; use o caminho manual abaixo.' : 'Could not record the request; use the manual path below.'));
    } finally { setSubmitting(false); }
  };

  const requestStatus = request && (() => {
    if (request.status === 'mr_open') {
      return <Alert type="success" header={pt ? 'Merge request aberto' : 'Merge request opened'}>
        <SpaceBetween size="xs">
          <Link href={request.mrUrl ?? '#'} external>{request.mrUrl}</Link>
          <span>{pt ? 'Revise e faça o merge: CI, mirror, Argo CD, kro e ACK fazem o resto, e o recurso aparece no Inventory.' : 'Review and merge: CI, mirror, Argo CD, kro and ACK do the rest, and the resource shows up in Inventory.'}</span>
        </SpaceBetween>
      </Alert>;
    }
    if (request.status === 'merged') {
      return <Alert type="success" header={pt ? 'Merge feito' : 'Merged'}>
        {pt ? 'CI, mirror, Argo CD, kro e ACK estão criando o recurso; ele aparece no Inventory.' : 'CI, mirror, Argo CD, kro and ACK are creating the resource; it shows up in Inventory.'}
      </Alert>;
    }
    if (request.status === 'closed') {
      return <Alert type="info" header={pt ? 'Pedido encerrado' : 'Request closed'}>
        {pt ? 'O merge request foi fechado sem merge. Nada foi criado.' : 'The merge request was closed without merging. Nothing was created.'}
      </Alert>;
    }
    if (request.status === 'failed') {
      return <Alert type="error" header={pt ? 'O pedido não virou MR' : 'The request did not become an MR'}>{request.error}</Alert>;
    }
    return <Alert type="info" header={<StatusIndicator type="in-progress">{request.status === 'processing' ? (pt ? 'Abrindo o merge request...' : 'Opening the merge request...') : (pt ? 'Pedido registrado' : 'Request recorded')}</StatusIndicator>}>
      <SpaceBetween size="xs">
        <span>{pt ? `O bot abre o MR de ${request.path} sozinho em alguns minutos. Quer agora?` : `The bot opens the MR for ${request.path} on its own within minutes. Want it now?`}</span>
        <Link href={openMrNowUrl(request.requestId)} external>{pt ? 'Abrir o MR agora (no GitLab, clique em Run pipeline)' : 'Open the MR now (in GitLab, click Run pipeline)'}</Link>
        <span>{pt ? `Pedido ${request.requestId}. Pode fechar esta aba: o MR abre mesmo assim.` : `Request ${request.requestId}. You can close this tab: the MR opens anyway.`}</span>
      </SpaceBetween>
    </Alert>;
  })();

  const lintStatus = lint && (lint.errors.length
    ? <Alert type="error" header={pt ? `${lint.errors.length} erro(s) de lint` : `${lint.errors.length} lint error(s)`}>{lint.errors.join(' ')}</Alert>
    : lint.warnings.length ? <Alert type="warning" header={pt ? 'Válido com avisos' : 'Valid with warnings'}>{lint.warnings.join(' ')}</Alert>
      : <Alert type="success" header={pt ? 'Lint aprovado' : 'Lint passed'}>{pt ? 'O artefato atende ao contrato atual.' : 'The artifact satisfies the current contract.'}</Alert>);

  const editButton = (targetStep: number) => <Button onClick={() => setStep(targetStep)}>{pt ? 'Editar' : 'Edit'}</Button>;

  const blocked = kind === 'infra' && !target.allowed ? target : null;
  return <SpaceBetween size="l">{blocked && <Alert type="warning" header={pt ? 'Este projeto não aceita Create de infra' : 'This project does not accept infra Create'}>
    {blocked.reason === 'gitops_path'
      ? (pt ? `${blocked.project.name} escreve em ${blocked.project.gitopsPath}. Instâncias kro só existem em platform/instances: escolha um projeto desse diretório no seletor do topo. Para agents, use o Agent Builder.` : `${blocked.project.name} writes ${blocked.project.gitopsPath}. kro instances only live in platform/instances: pick a project of that directory in the top selector. For agents, use the Agent Builder.`)
      : (pt ? `${blocked.project.name} está ${blocked.project.lifecycle.state} e não aceita pedidos novos.` : `${blocked.project.name} is ${blocked.project.lifecycle.state} and accepts no new requests.`)}
  </Alert>}<Wizard
    activeStepIndex={step} allowSkipTo
    onNavigate={({ detail }) => setStep(detail.requestedStepIndex)}
    onSubmit={prepareProposal}
    isLoadingNextStep={submitting}
    onCancel={() => { setStep(0); setProposalUrl(''); setError(''); setRequest(null); }}
    submitButtonText={pt ? 'Propor mudança' : 'Propose change'}
    i18nStrings={{ stepNumberLabel: n => pt ? `Etapa ${n}` : `Step ${n}`, collapsedStepsLabel: (n, total) => pt ? `Etapa ${n} de ${total}` : `Step ${n} of ${total}`, skipToButtonLabel: item => pt ? `Ir para ${item.title}` : `Skip to ${item.title}`, navigationAriaLabel: pt ? 'Etapas de provisioning' : 'Provisioning steps', cancelButton: pt ? 'Cancelar' : 'Cancel', previousButton: pt ? 'Anterior' : 'Previous', nextButton: pt ? 'Próximo' : 'Next', submitButton: pt ? 'Propor mudança' : 'Propose change', optional: pt ? 'opcional' : 'optional' }}
    steps={[
      { title: pt ? 'Definição da solicitação' : 'Request definition', description: pt ? 'Defina primeiro o que será provisionado e seu lifecycle.' : 'Define what will be provisioned and its lifecycle first.', content: <Container header={<Header variant="h2">{pt ? 'Definição da solicitação' : 'Request definition'}</Header>}><SpaceBetween size="l"><FormField label={pt ? 'Tipo de provisioning' : 'Provisioning type'}><RadioGroup value={kind} onChange={({ detail }) => changeKind(detail.value)} items={[{ value: 'infra', label: pt ? 'Infraestrutura' : 'Infrastructure', description: 'kro / ACK' }, { value: 'agent', label: 'Agent', description: pt ? 'Contrato JSON de agent' : 'Agent JSON contract' }]} /></FormField><FormField label={pt ? 'Ambiente' : 'Environment'}><RadioGroup value={environment} onChange={({ detail }) => setEnvironment(detail.value)} items={[{ value: 'internal', label: pt ? 'Interno AppMod' : 'Internal AppMod' }, { value: 'demo', label: pt ? 'Demo para cliente' : 'Customer demo' }]} /></FormField><FormField label="Lifecycle"><RadioGroup value={lifecycle} onChange={({ detail }) => setLifecycle(detail.value)} items={[{ value: 'persistent', label: pt ? 'Persistente' : 'Persistent', description: 'Retain' }, { value: 'ephemeral', label: pt ? 'Efêmero' : 'Ephemeral' }]} /></FormField></SpaceBetween></Container> },
      { title: pt ? 'Informações básicas' : 'Basic information', description: pt ? 'Customize os defaults opinativos da plataforma.' : 'Customize the platform opinionated defaults.', content: <Container header={<Header variant="h2">{pt ? 'Informações básicas' : 'Basic information'}</Header>}><SpaceBetween size="l"><FormField label={pt ? 'Nome do ambiente/recurso' : 'Environment/resource name'} description={`${owner}/`}><Input value={name} onChange={({ detail }) => setName(detail.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /></FormField><FormField label="Owner / Team"><Input value={owner} onChange={({ detail }) => setOwner(detail.value)} /></FormField><FormField label={pt ? 'Capability / runtime' : 'Capability / runtime'}><Select selectedOption={type} onChange={({ detail }) => selectCapability(detail.selectedOption)} options={options} /></FormField>{formFields.length > 0 && <Container header={<Header variant="h3" description={pt ? 'Gerado do schema.json publicado da capability. Mudar um campo reescreve o spec do manifest; o YAML segue editável na revisão.' : 'Generated from the capability published schema.json. Changing a field rewrites the manifest spec; the YAML stays editable in review.'}>{pt ? 'Parâmetros da capability' : 'Capability parameters'}</Header>}><SpaceBetween size="m">{manifestSpec === null && <Alert type="warning">{pt ? 'O manifest atual não é legível; corrija o YAML na revisão para usar o formulário.' : 'The current manifest does not parse; fix the YAML in review to use the form.'}</Alert>}{extraSpecKeys.length > 0 && <Alert type="warning">{pt ? `Campos fora do schema publicado: ${extraSpecKeys.join(', ')}.` : `Fields outside the published schema: ${extraSpecKeys.join(', ')}.`}</Alert>}<SchemaFormPreview fields={formFields} values={formValues} errors={formErrors} pt={pt} readOnly={manifestSpec === null} onChange={setSpecValue} /></SpaceBetween></Container>}{kind === 'agent' && <><FormField label={pt ? 'Arquitetura' : 'Architecture'}><Tiles value={architecture} onChange={({ detail }) => setArchitecture(detail.value)} items={[{ value: 'arm64', label: 'arm64', description: 'Graviton' }, { value: 'x86_64', label: 'x86_64' }]} /></FormField><FormField label={pt ? 'Runtime base / sistema operacional' : 'Runtime base / operating system'}><Tiles value={runtimeBase} onChange={({ detail }) => setRuntimeBase(detail.value)} items={[{ value: 'al2023', label: 'Amazon Linux 2023' }, { value: 'distroless', label: 'Distroless' }]} /></FormField></>}<FormField label={pt ? 'Região alvo' : 'Target region'}><Select selectedOption={targetRegion} onChange={({ detail }) => setTargetRegion(detail.selectedOption)} options={[{ label: 'sa-east-1 (São Paulo)', value: 'sa-east-1' }, { label: 'us-east-1 (N. Virginia)', value: 'us-east-1' }]} /></FormField>{kind === 'agent' && <FormField label={pt ? 'Opção default da plataforma' : 'Default platform option'}><Tiles value={profile} onChange={({ detail }) => setProfile(detail.value)} items={[{ value: 'standard', label: 'Standard', description: '2 vCPU / 4 GiB' }, { value: 'gpu', label: 'GPU', description: pt ? 'Somente agents compatíveis' : 'Compatible agents only' }, { value: 'custom', label: 'Custom', description: pt ? 'Customize o profile' : 'Customize the profile' }]} /></FormField>}{kind === 'agent' && profile === 'custom' && <FormField label={pt ? 'Profile customizado' : 'Custom profile'}><Input value={customProfile} onChange={({ detail }) => setCustomProfile(detail.value)} /></FormField>}<FormField label="Namespace" description={namespaceOf(artifact) && namespaceOf(artifact) !== namespace ? (pt ? `O manifest está em "${namespaceOf(artifact)}". Ao propor, ele vai gravado em "${namespace}".` : `The manifest says "${namespaceOf(artifact)}". On proposing it is written as "${namespace}".`) : (pt ? 'Vai para metadata.namespace do manifest, que é o que o backend grava.' : 'Goes to the manifest metadata.namespace, which is what the backend records.')}><Input value={namespace} onChange={({ detail }) => setNamespace(detail.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /></FormField></SpaceBetween></Container> },
      { title: pt ? 'Opções avançadas' : 'Advanced options', description: pt ? 'Ajuste runtime, rede e campos derivados.' : 'Adjust runtime, network and derived fields.', isOptional: true, content: <Container header={<Header variant="h2">{pt ? 'Opções avançadas' : 'Advanced options'}</Header>}><SpaceBetween size="l"><FormField label={pt ? 'Network profile' : 'Network profile'}><Select selectedOption={networkProfile} onChange={({ detail }) => setNetworkProfile(detail.selectedOption)} options={[{ label: 'restricted', value: 'restricted' }, { label: 'egress-aws', value: 'egress-aws' }, { label: 'egress-internal', value: 'egress-internal' }]} /></FormField>{kind === 'agent' && <><FormField label="Schedule"><Input value={schedule} onChange={({ detail }) => setSchedule(detail.value)} /></FormField><FormField label={pt ? 'Timeout em segundos' : 'Timeout seconds'}><Input value={timeoutSeconds} inputMode="numeric" onChange={({ detail }) => setTimeoutSeconds(detail.value.replace(/\D/g, ''))} /></FormField><FormField label="Model alias"><Input value="claude-sonnet" disabled /></FormField></>} {kind === 'infra' && <><FormField label="Deletion policy"><Input value={lifecycle === 'persistent' ? 'Retain' : 'Ephemeral cleanup policy'} disabled /></FormField><FormField label="Encryption"><Input value={pt ? 'Obrigatória pela composition' : 'Required by the composition'} disabled /></FormField></>}<KeyValuePairs columns={2} items={[{ label: pt ? 'Git path derivado' : 'Derived Git path', value: `${kind === 'infra' ? 'platform/instances' : 'docs/agent-definitions'}/${name}.${kind === 'infra' ? 'yaml' : 'json'}` }, { label: 'Argo Application', value: kind === 'infra' ? 'agent-platform-instances' : (pt ? 'Compiler pendente' : 'Compiler pending') }]} /></SpaceBetween></Container> },
      { title: pt ? 'Revisar e propor' : 'Review and propose', content: <SpaceBetween size="l"><Container header={<Header variant="h2" actions={editButton(0)}>{pt ? 'Definição da solicitação' : 'Request definition'}</Header>}><KeyValuePairs columns={2} items={[{ label: pt ? 'Tipo' : 'Type', value: review.target }, { label: pt ? 'Ambiente' : 'Environment', value: review.environment }, { label: 'Lifecycle', value: review.lifecycle }]} /></Container><Container header={<Header variant="h2" actions={editButton(1)}>{pt ? 'Informações básicas' : 'Basic information'}</Header>}><KeyValuePairs columns={3} items={[{ label: pt ? 'Nome' : 'Name', value: review.name }, { label: 'Owner / Team', value: review.owner }, { label: 'Capability / runtime', value: review.type }, { label: pt ? 'Arquitetura' : 'Architecture', value: review.architecture }, { label: pt ? 'Runtime base' : 'Runtime base', value: review.runtimeBase }, { label: pt ? 'Região' : 'Region', value: review.region }, { label: 'Profile', value: kind === 'agent' ? review.profile : 'N/A' }, { label: 'Namespace', value: review.namespace }]} /></Container><Container header={<Header variant="h2" actions={editButton(2)}>{pt ? 'Opções avançadas' : 'Advanced options'}</Header>}><KeyValuePairs columns={3} items={[{ label: 'Network profile', value: review.network }, { label: 'Schedule', value: kind === 'agent' ? schedule : 'N/A' }, { label: 'Timeout', value: kind === 'agent' ? `${timeoutSeconds}s` : 'N/A' }]} /></Container><Container header={<Header variant="h2">{pt ? 'Manifest workbench' : 'Manifest workbench'}</Header>}><SpaceBetween size="m">{kind === 'agent' && <Alert type="info" header={pt ? 'Use o Agent Builder' : 'Use the Agent Builder'} action={<Button href="#agent-builder">{pt ? 'Abrir o Agent Builder' : 'Open the Agent Builder'}</Button>}>{pt ? 'O Agent JSON deste wizard é só um contrato de definição e não vira agent. Para criar um agent kagent governado, com tools read-only, MR e teste A2A, use o Agent Builder.' : 'Agent JSON is a definition contract here and does not become an agent. To create a governed kagent agent, with read-only tools, an MR and an A2A test, use the Agent Builder.'}</Alert>}{!!error && <Alert type="error">{error}</Alert>}<FormField label={pt ? 'Descreva o que deseja' : 'Describe what you need'}><Textarea value={prompt} onChange={({ detail }) => setPrompt(detail.value)} rows={4} /></FormField><SpaceBetween direction="horizontal" size="s"><Button onClick={generate} loading={generating} variant="primary">{pt ? 'Gerar com Bedrock' : 'Generate with Bedrock'}</Button><Button onClick={() => lintArtifact()}>Lint</Button></SpaceBetween><FormField label={kind === 'infra' ? 'YAML' : 'JSON'}><Textarea value={artifact} onChange={({ detail }) => { setArtifact(detail.value); setLint(null); }} rows={18} /></FormField>{lintStatus}{requestStatus}{!!proposalUrl && <Alert type="success" header={pt ? 'Proposta preparada' : 'Proposal prepared'}>{pt ? 'Artefato copiado. ' : 'Artifact copied. '}<Link href={proposalUrl} external>{pt ? 'Abrir novo arquivo no GitLab' : 'Open GitLab new file'}</Link>.</Alert>}<Alert type="info">{pt ? 'Propor não aplica no cluster. O artefato passa por GitLab, CI, CodeCommit e Argo CD.' : 'Proposing does not apply to the cluster. The artifact goes through GitLab, CI, CodeCommit and Argo CD.'}</Alert></SpaceBetween></Container></SpaceBetween> },
    ]}
  /></SpaceBetween>;
}
