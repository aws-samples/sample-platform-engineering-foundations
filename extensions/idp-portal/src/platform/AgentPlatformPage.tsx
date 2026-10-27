import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import AppLayout from '@cloudscape-design/components/app-layout';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import SideNavigation, { SideNavigationProps } from '@cloudscape-design/components/side-navigation';
import SpaceBetween from '@cloudscape-design/components/space-between';
import SplitPanel from '@cloudscape-design/components/split-panel';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import TopNavigation, { TopNavigationProps } from '@cloudscape-design/components/top-navigation';
import { backlogProgress } from './backlogLoader';
import { getOverview, getPlatformView, ClusterOverview, PlatformView } from './clusterApi';
import { listCapabilities } from './kdpInventoryApi';
import { I18nProvider, useI18n } from './i18n';
import { integrations, inventory, IntegrationItem, InventoryItem } from './catalog';
import { agentCapabilities, capabilities, infrastructureCapabilities, Capability } from './catalogLoader';
import { LiveCounts, buildServiceCatalog, servicePathFor } from './serviceCatalog';
import { serviceNavigationSection } from './ServiceCatalogParts';
import { serviceNavHref } from './kdpInventoryModel';
import { ARGO_CD_URL, CLUSTER_CONSOLES, TOOL_LINKS } from './catalog';
import { CompositionsPage } from './CompositionsPage';
import { ScorecardsPage } from './ScorecardsPage';
import { DependenciesPage } from './DependenciesPage';
import { DocsPage } from './DocsPage';
import { IntegrationsPage } from './IntegrationsPage';
import { GlobalSearch } from './GlobalSearch';
import { NotificationsPanel, useNotifications } from './NotificationsPanel';
import { TeamsPage } from './TeamsPage';
import { errorMessage } from './errors';
import Spinner from '@cloudscape-design/components/spinner';
import { useProjectScope } from './scope/useProjectScope';
import { ScopeStateNotice } from './scope/ProjectScopeParts';
import { NAMESPACE_PARAM, PROJECT_PARAM, readUrlScope } from './scope/scopeModel';
import { setActiveScope } from './scope/activeScope';
import Modal from '@cloudscape-design/components/modal';
import {
  contentKey, decideProjectSwitch, focusViewHeading, ProjectSwitch, RootLike, routeParam, VIEW_LOADING_ATTR, viewHash, viewTitle,
} from './shellNavigation';
import { labelOf, resolveRoute, viewHref, VIEW_IDS, ViewId } from './routes/routeRegistry';
import { HOSTING, HOSTING_PURPOSE, INTERNAL } from './deployment';

// Views fora do caminho de entrada (Overview, Inventory, Operate) carregam sob demanda: quem abre
// o portal não baixa o wizard, o Cluster Explorer, o AI Gateway, o Admin, o Help e o backlog.
// O Cloudscape comum à moldura continua neste chunk; ele é a maior parte do peso e toda tela usa.
const DevHomePage = lazy(() => import('./DevHomePage').then(m => ({ default: m.DevHomePage })));
const FirstRun = lazy(() => import('./FirstRun').then(m => ({ default: m.FirstRun })));
const ProvisioningFlow = lazy(() => import('./ProvisioningFlow').then(m => ({ default: m.ProvisioningFlow })));
const AgentBuilder = lazy(() => import('./AgentBuilder').then(m => ({ default: m.AgentBuilder })));
const GatewayPanel = lazy(() => import('./GatewayPanel').then(m => ({ default: m.GatewayPanel })));
const HelpPage = lazy(() => import('./HelpPage').then(m => ({ default: m.HelpPage })));
const AdminConsole = lazy(() => import('./AdminConsole').then(m => ({ default: m.AdminConsole })));
const AuditLogPage = lazy(() => import('./AuditLogPage').then(m => ({ default: m.AuditLogPage })));
const PersonasPage = lazy(() => import('./PersonasPage').then(m => ({ default: m.PersonasPage })));
const ClusterExplorer = lazy(() => import('./ClusterExplorer').then(m => ({ default: m.ClusterExplorer })));
const BacklogModal = lazy(() => import('./BacklogModal').then(m => ({ default: m.BacklogModal })));
const ServiceCatalogPage = lazy(() => import('./ServiceCatalogPage').then(m => ({ default: m.ServiceCatalogPage })));
const LiveInventoryRoute = lazy(() => import('./LiveInventoryPage').then(m => ({ default: m.LiveInventoryRoute })));
const LiveResourceDetailRoute = lazy(() => import('./LiveResourceDetailPage').then(m => ({ default: m.LiveResourceDetailRoute })));
const ServiceStudioPage = lazy(() => import('./devPlatformPages').then(m => ({ default: m.ServiceStudioPage })));
const PlatformAssistantPage = lazy(() => import('./devPlatformPages').then(m => ({ default: m.PlatformAssistantPage })));
const ProjectContextPage = lazy(() => import('./devPlatformPages').then(m => ({ default: m.ProjectContextPage })));
const viewFallback = <div {...{ [VIEW_LOADING_ATTR]: '' }} style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}><Spinner size="large" /></div>;

// A lista de views vive no route registry; o tipo e os ids derivam dela (uma fonte, não quatro).
type View = ViewId;
const VALID_VIEWS: readonly View[] = VIEW_IDS;

/**
 * A view que um hash representa. Hash vazio ou desconhecido cai na home do Dev, que é o ponto de
 * entrada da plataforma; o catálogo segue em `#catalog`, a um clique da home.
 */
export function readView(hash: string): View {
  const resolved = resolveRoute({ hash });
  return VALID_VIEWS.includes(resolved.view) ? resolved.view : 'home';
}

/**
 * O inventário fixo (`#inventory`) saiu do caminho normal: ele lista um snapshot escrito à mão em
 * `catalog.ts`, que envelhece em silêncio e já discordava do cluster. Ele continua alcançável por
 * link antigo, e quando abre diz o que é - este aviso é a condição de ainda existir.
 */
const LEGACY_INVENTORY_NOTICE = {
  pt: 'Esta é uma tela LEGADA: a lista abaixo é um snapshot fixo do laboratório, escrito no código, e não uma leitura do cluster. Ela segue aqui só para não quebrar links antigos. O inventário real de cada serviço fica no catálogo, lido do cluster na hora.',
  en: 'This is a LEGACY screen: the list below is a fixed lab snapshot written in code, not a cluster read. It stays only so old links keep working. The real per-service inventory lives in the catalog and is read from the cluster on open.',
};

interface SelectedEntity {
  id: string;
  name: string;
  kind: string;
  description: string;
  owner: string;
  runtime: string;
  status: string;
  deployed: boolean;
  argoApplication?: 'agent-platform-compositions' | 'agent-platform-instances';
}


const EKS_CONSOLE_URL = 'https://console.aws.amazon.com/eks/home?region=sa-east-1#/clusters/appmod-agent-platform-lab';

function inventoryToEntity(item: InventoryItem): SelectedEntity {
  return {
    id: item.name,
    name: item.name,
    kind: item.kind,
    description: `${item.kind} running on ${item.runtime}`,
    owner: item.owner,
    runtime: item.runtime,
    status: item.status,
    deployed: true,
    argoApplication: item.name === 'scheduled-agent'
      ? 'agent-platform-compositions'
      : ['hello-agent', 'smoke-sandbox'].includes(item.name)
        ? 'agent-platform-instances'
        : undefined,
  };
}

function EntitySections({ entity, navigate }: { entity: SelectedEntity; navigate: (view: View) => void }): JSX.Element {
  const { locale, t } = useI18n();
  const pt = locale === 'pt-BR';
  const argoApplicationUrl = entity.argoApplication ? `${ARGO_CD_URL}/applications/argocd/${entity.argoApplication}` : '';
  const statusType = ['Ready', 'Active', 'Available'].includes(entity.status) ? 'success' : 'pending';
  /*
   * Só campos que vêm do próprio item. Environment, Region, Financial owner e the internal allowlist saíram: eram
   * valores fixos escritos no código, apresentados com a mesma tipografia de dado lido, então o
   * usuário não tinha como saber que ninguém os havia medido. Quem precisa desses campos agora lê
   * o objeto no detalhe live, que mostra o que o cluster diz.
   */
  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2">{t('Instance information')}</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <div><Box variant="awsui-key-label">{t('Kind')}</Box>{entity.kind}</div>
          <div><Box variant="awsui-key-label">{t('Status')}</Box><StatusIndicator type={statusType}>{t(entity.status)}</StatusIndicator></div>
          <div><Box variant="awsui-key-label">{t('Runtime / pattern')}</Box>{entity.runtime}</div>
          <div><Box variant="awsui-key-label">{t('Source of truth')}</Box>{entity.argoApplication ? 'GitOps mirror and Argo CD' : entity.deployed ? 'Bootstrap / cluster snapshot' : 'Platform catalog'}</div>
          <div><Box variant="awsui-key-label">{t('Owner')}</Box>{entity.owner}</div>
          <div><Box variant="awsui-key-label">{t('Managed by')}</Box>{entity.argoApplication ? 'Argo CD (GitOps)' : pt ? 'Bootstrap da plataforma' : 'Platform bootstrap'}</div>
        </ColumnLayout>
      </Container>
      <Container header={<Header variant="h2">{t('Connection options')}</Header>}>
        <SpaceBetween size="s">
          <SpaceBetween direction="horizontal" size="xs">
            {!!argoApplicationUrl && <Button href={argoApplicationUrl} target="_blank" iconAlign="right" iconName="external">{t('Open Argo CD application')}</Button>}
            <Button href={EKS_CONSOLE_URL} target="_blank" iconAlign="right" iconName="external">{t('Open EKS cluster')}</Button>
            <Button onClick={() => navigate('gateway')}>{t('Open AI Gateway')}</Button>
            <Button onClick={() => navigate('help')}>{t('Access and onboarding')}</Button>
          </SpaceBetween>
          <Box variant="small">{pt ? 'Rancher, Headlamp e Keycloak ficam no menu Ferramentas; o grafo e a saúde das composições estão na página Composições. Nenhum tem endpoint público: rode scripts/platform-ui.sh start uma vez e os links abrem em 127.0.0.1 com a sua credencial AWS. Grafana e Langfuse usam o mesmo port-forward.' : 'Rancher, Headlamp and Keycloak live in the Tools menu; composition graphs and health are on the Compositions page. None has a public endpoint: run scripts/platform-ui.sh start once and the links open on 127.0.0.1 with your AWS credential. Grafana and Langfuse use the same port-forward.'}</Box>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}


const INTEGRATION_PT: Record<string, string> = {
  'Rancher': 'Explorador do cluster Kubernetes e console de workloads',
  'Headlamp': 'UI leve de Kubernetes em avaliação para substituir o Rancher (RBAC só leitura, logs e shell)',
  'Keycloak': 'SSO broker da plataforma (IdP SAML para federação com o Identity Center)',
  [HOSTING]: HOSTING_PURPOSE.pt,
  'Argo CD': 'Reconciliação GitOps, drift correction, manifests e history',
  'ACK + kro': 'Provisionamento AWS e compositions da plataforma',
  'Argo Workflows': 'DAGs, schedules, retries e histórico de runs',
  'AI Platform Gateway': 'Data plane Bedrock privado; BFF e perimeter de control APIs',
  'ADOT + Langfuse': 'Traces, evaluations e loops trace-to-dataset',
};
/*
 * A jornada do Dev, nesta ordem: Início, Catálogo, Meus recursos, Criar, Studio, Assistant. Operação e
 * ferramentas ficam depois, porque são de quem opera a plataforma, não do caminho de quem a consome.
 * "Meus recursos" é a seção derivada da contagem live por serviço, já no escopo do projeto ativo.
 */
function getNavigationItems(t: (text: string) => string, liveCounts: LiveCounts, pt: boolean): SideNavigationProps.Item[] {
  const services = serviceNavigationSection(buildServiceCatalog(capabilities, liveCounts), pt);
  // Texto e href de cada view vêm do route registry; só os badges (estado live) ficam aqui.
  const link = (view: View, extra: Partial<SideNavigationProps.Link> = {}): SideNavigationProps.Link =>
    ({ type: 'link', text: labelOf(view, pt), href: viewHref(view), ...extra });
  return [
    link('home'),
    link('catalog'),
    link('compositions'),
    link('scorecards'),
    link('dependencies'),
    link('teams'),
    link('docs'),
    ...(services ? [{ ...services, text: pt ? 'Meus recursos' : 'My resources' }] : []),
    {
      type: 'section', text: pt ? 'Criar' : 'Create', items: [
        link('provision'),
        link('agent-builder', { info: <Badge color="green">{t('Available')}</Badge> }),
        link('getting-started', { info: <Badge color="blue">10 min</Badge> }),
      ],
    },
    link('studio', { info: <Box variant="small" color="text-status-inactive">Service Owner</Box> }),
    link('assistant'),
    { type: 'divider' },
    link('project'),
    {
      type: 'section', text: t('Operations'), defaultExpanded: false, items: [
        link('overview'),
        link('operate'),
        link('gateway'),
        link('personas'),
        link('cluster'),
        link('admin'),
        link('integrations'),
        link('audit'),
      ],
    },
    // Sem ferramenta neste deployment (flavor público), a seção não aparece: seção vazia é ruído.
    ...(TOOL_LINKS.length ? [{
      type: 'section' as const, text: t('Tools'), defaultExpanded: false, items: TOOL_LINKS.map(tool => ({
        type: 'link' as const,
        text: tool.name,
        href: tool.href,
        external: true,
        externalIconAriaLabel: t('Opens in a new tab'),
        info: <Box variant="small" color="text-status-inactive">{t(tool.access === 'idc' ? 'Identity Center' : 'Local port-forward')}</Box>,
      })),
    }] : []),
  ];
}

/**
 * As duas vitrines do Overview. O card abre o CATÁLOGO, que lê o estado do cluster.
 *
 * Antes ele abria uma tela de entidade montada no clique, com `owner: 'platform'` e um status
 * derivado do lifecycle do arquivo - dados que pareciam lidos e não eram. O catálogo mostra os
 * mesmos serviços com o estado que a cluster-api respondeu, então não há o que inventar aqui.
 */
function Catalog({ title, description, items, onOpenCatalog }: { title: string; description: string; items: Capability[]; onOpenCatalog: () => void }): JSX.Element {
  const { locale, t } = useI18n();
  const pt = locale === 'pt-BR';
  const lifecycleLabel = (item: Capability) => pt
    ? ({ available: 'Disponível', preview: 'Preview', planned: 'Planejado', deprecated: 'Descontinuado' }[item.lifecycle])
    : item.lifecycle.charAt(0).toUpperCase() + item.lifecycle.slice(1);
  return (
    <Cards
      header={<Header variant="h2" description={description}>{title}</Header>}
      items={items}
      cardDefinition={{
        header: item => <Link fontSize="heading-m" href="#catalog" onFollow={event => { event.preventDefault(); onOpenCatalog(); }}>{pt ? item.displayNamePt : item.displayName}</Link>,
        sections: [
          { id: 'description', content: item => pt ? item.descriptionPt : item.description },
          { id: 'pattern', header: t('Platform pattern'), content: item => `${item.pattern} · ${item.goldenPath} · ${item.version}` },
          // Lifecycle declarado no arquivo, e rotulado como tal: o estado adicionado é do catálogo.
          { id: 'status', header: t('Availability'), content: item => <StatusIndicator type={item.lifecycle === 'available' ? 'success' : item.lifecycle === 'preview' ? 'in-progress' : 'pending'}>{lifecycleLabel(item)}</StatusIndicator> },
        ],
      }}
      cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 2 }]}
      empty={<Box textAlign="center">{t('No capabilities found')}</Box>}
    />
  );
}

function Overview({ navigate }: { navigate: (view: View) => void }): JSX.Element {
  const { locale, t } = useI18n();
  const pt = locale === 'pt-BR';
  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={pt ? `Um único Application Plane no ${HOSTING} para autoatendimento de infraestrutura e AI agents.` : `A single ${HOSTING} application plane for infrastructure and AI agent self-service.`}
          actions={<SpaceBetween direction="horizontal" size="xs"><Button onClick={() => navigate('catalog')}>{pt ? 'Ver catálogo' : 'View catalog'}</Button><Button onClick={() => navigate('agent-builder')}>{pt ? 'Criar agent' : 'Build an agent'}</Button><Button variant="primary" onClick={() => navigate('provision')}>{t('Create request')}</Button></SpaceBetween>}
        >
          {t('Agent Platform')}
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Alert type="success" header={pt ? 'Primeira vez aqui? Seu site em 10 minutos' : 'First time here? Your site in 10 minutes'}
          action={<Button variant="primary" onClick={() => navigate('getting-started')}>{t('Getting started')}</Button>}>
          {pt ? 'Um clique cria um site de verdade pelo caminho GitOps da plataforma. Você acompanha cada etapa, e amanhã ele some sozinho.' : 'One click creates a real site through the platform GitOps path. You watch every step, and it goes away on its own tomorrow.'}
        </Alert>
        <Alert type="info" header={t('Security boundary')}>
          {INTERNAL ? (pt ? 'O the internal gateway é o único ingress público da aplicação. O IDP chama um BFF autorizado, e o BFF alcança backends privados. Agents não expõem endpoints públicos.' : 'the internal gateway is the only public application ingress. The IDP calls a the internal gateway-authorized BFF, and the BFF reaches private backends. Agents do not expose public endpoints.') : (pt ? `${HOSTING} é o único ingress público da aplicação; as APIs ficam atrás de um authorizer JWT e o browser nunca vê credencial AWS.` : `${HOSTING} is the only public application ingress; the APIs sit behind a JWT authorizer and the browser never sees an AWS credential.`)}
        </Alert>
        <LiveHealth />
        <Grid gridDefinition={[{ colspan: { default: 12, m: 6 } }, { colspan: { default: 12, m: 6 } }] }>
          <Catalog title={t('Platform Engineering for Infrastructure')} description={pt ? 'Recursos AWS entregues por APIs opinativas da plataforma.' : 'AWS resources delivered through opinionated platform APIs.'} items={infrastructureCapabilities} onOpenCatalog={() => navigate('catalog')} />
          <Catalog title={t('Platform Engineering for Agents')} description={pt ? 'Runtimes de agents com identidade, políticas e observabilidade.' : 'Agent runtimes with identity, policy and observability included.'} items={agentCapabilities} onOpenCatalog={() => navigate('catalog')} />
        </Grid>
        <Container header={<Header variant="h2">{t('Design principles from the benchmarks')}</Header>}>
          <ColumnLayout columns={3} variant="text-grid">
            <KeyValuePairs columns={1} items={[{ label: pt ? 'Ideia mantida do Backstage' : 'Backstage idea retained', value: pt ? 'Catálogo, ownership, templates e documentação no estilo TechDocs.' : 'Catalog, ownership, templates and TechDocs-style documentation.' }, { label: pt ? 'Fraqueza removida do Backstage' : 'Backstage weakness removed', value: pt ? 'Sem monorepo de plugins nem segundo stack de autenticação.' : 'No plugin monorepo or second authentication stack.' }]} />
            <KeyValuePairs columns={1} items={[{ label: pt ? 'Ideia mantida do Shoehorn' : 'Shoehorn idea retained', value: pt ? 'Descoberta automática, grafo de dependências e superfície MCP.' : 'Auto-discovery, dependency graph and agent-readable MCP surface.' }, { label: pt ? 'Ideia mantida do Kratix' : 'Kratix idea retained', value: pt ? 'Tudo como API da plataforma com lifecycle Day 2.' : 'Everything as a platform API with Day 2 lifecycle.' }]} />
            <KeyValuePairs columns={1} items={[{ label: 'CNOE', value: pt ? 'EKS packages, GitOps e capabilities reutilizáveis.' : 'Argo CD, EKS Capabilities and reusable packages.' }, { label: 'kro-ui', value: pt ? 'Saúde e grafo de compositions e instâncias.' : 'Graph-first composition health, instances and revisions.' }]} />
          </ColumnLayout>
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}

function LiveHealth(): JSX.Element {
  const { locale, t } = useI18n();
  const pt = locale === 'pt-BR';
  const [overview, setOverview] = useState<ClusterOverview | null>(null);
  const [platform, setPlatform] = useState<PlatformView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([getOverview(), getPlatformView()])
      .then(([o, p]) => { setOverview(o); setPlatform(p); })
      .catch(cause => setError(errorMessage(cause, 'cluster API unavailable')));
  }, []);
  if (error) {
    return <Alert type="error" header={pt ? 'Saúde live indisponível' : 'Live health unavailable'}>{pt ? `A cluster-api não respondeu: ${error}. Nada aqui é snapshot; sem resposta, não mostramos números.` : `The cluster-api did not respond: ${error}. Nothing here is a snapshot; without a response we show no numbers.`}</Alert>;
  }
  const rgdsActive = platform?.rgds.filter(r => r.state === 'Active').length ?? 0;
  const instancesActive = platform?.instances.filter(i => i.state === 'ACTIVE').length ?? 0;
  return (
    <Container header={<Header variant="h2" description={pt ? 'Lido agora da cluster-api (endpoint privado do EKS).' : 'Read now from the cluster-api (private EKS endpoint).'} actions={<Badge color="green">live</Badge>}>{t('Platform health')}</Header>}>
      {!overview ? <StatusIndicator type="loading">{t('Checking')}</StatusIndicator> : (
        <ColumnLayout columns={4} variant="text-grid">
          <div><Box variant="awsui-key-label">{t('EKS runtime')}</Box><StatusIndicator type={overview.nodes.ready === overview.nodes.total ? 'success' : 'warning'}>{overview.nodes.ready}/{overview.nodes.total} nodes · {overview.nodes.spot} spot · {overview.version}</StatusIndicator></div>
          <div><Box variant="awsui-key-label">Pods</Box><StatusIndicator type={overview.pods.failed ? 'warning' : 'success'}>{overview.pods.running}/{overview.pods.total} running{overview.pods.failed ? ` · ${overview.pods.failed} failed` : ''}</StatusIndicator></div>
          <div><Box variant="awsui-key-label">{pt ? 'Compositions (kro)' : 'Compositions (kro)'}</Box><StatusIndicator type={platform && rgdsActive === platform.rgds.length ? 'success' : 'warning'}>{rgdsActive}/{platform?.rgds.length ?? 0} RGDs Active</StatusIndicator></div>
          <div><Box variant="awsui-key-label">{pt ? 'Instâncias' : 'Instances'}</Box><StatusIndicator type={platform && instancesActive === platform.instances.length ? 'success' : 'in-progress'}>{instancesActive}/{platform?.instances.length ?? 0} ACTIVE</StatusIndicator></div>
        </ColumnLayout>
      )}
    </Container>
  );
}

function InventoryGroup({ title, items, selected, onSelect }: { title: string; items: InventoryItem[]; selected: SelectedEntity | null; onSelect: (entity: SelectedEntity | null) => void }): JSX.Element {
  const { t } = useI18n();
  const selectedItems = items.filter(item => selected && item.name === selected.id);
  return (
    <Table
      variant="stacked"
      selectionType="single"
      trackBy="name"
      selectedItems={selectedItems}
      onSelectionChange={({ detail }) => onSelect(detail.selectedItems[0] ? inventoryToEntity(detail.selectedItems[0]) : null)}
      header={<Header variant="h2" counter={`(${items.length})`} actions={<Box variant="small" color="text-body-secondary">{t('Deletion via approved MR (ADR-0007)')}</Box>}>{title}</Header>}
      items={items}
      columnDefinitions={[
        { id: 'name', header: t('Name'), cell: (item: InventoryItem) => <Link onFollow={event => { event.preventDefault(); onSelect(inventoryToEntity(item)); }}>{item.name}</Link>, sortingField: 'name' },
        { id: 'kind', header: t('Kind'), cell: (item: InventoryItem) => item.kind },
        { id: 'owner', header: t('Owner'), cell: (item: InventoryItem) => item.owner },
        { id: 'runtime', header: t('Runtime'), cell: (item: InventoryItem) => item.runtime },
        { id: 'status', header: t('Status'), cell: (item: InventoryItem) => <StatusIndicator type="success">{t(item.status)}</StatusIndicator> },
      ]}
      empty={<Box textAlign="center">{t('No entities found')}</Box>}
    />
  );
}

/**
 * Inventário LEGADO, mantido só para não quebrar link antigo (`#inventory`).
 *
 * Saiu da navegação lateral e do Overview. A lista vem de `catalog.ts`, escrita à mão, então a
 * tela abre dizendo isso: é a condição para ela continuar existindo. A tabela de ARNs da AWS
 * Tagging API saiu daqui junto - ela respondia outra pergunta (recurso AWS com a tag) e aparecia
 * ao lado de um snapshot fixo, o que fazia as duas parecerem a mesma coisa.
 */
function LegacyInventory({ navigate, selected, onSelect }: { navigate: (view: View) => void; selected: SelectedEntity | null; onSelect: (entity: SelectedEntity | null) => void }): JSX.Element {
  const { locale, t } = useI18n();
  const pt = locale === 'pt-BR';
  const agents = inventory.filter(item => item.kind !== 'ResourceGraphDefinition');
  const compositions = inventory.filter(item => item.kind === 'ResourceGraphDefinition');
  return (
    <ContentLayout header={<Header variant="h1" description={pt ? 'Snapshot fixo do laboratório, mantido para links antigos.' : 'Fixed lab snapshot, kept for old links.'} actions={<SpaceBetween direction="horizontal" size="xs"><Button onClick={() => navigate('catalog')}>{pt ? 'Ir ao catálogo' : 'Go to the catalog'}</Button><Button variant="primary" onClick={() => navigate('provision')}>{t('Create request')}</Button></SpaceBetween>}>{`${t('Developer resources')} (legacy)`}</Header>}>
      <SpaceBetween size="l">
        <Alert
          type="warning"
          header={pt ? 'Tela legada: lista fixa, não leitura do cluster' : 'Legacy screen: fixed list, not a cluster read'}
          action={<Button onClick={() => navigate('catalog')}>{pt ? 'Abrir o catálogo' : 'Open the catalog'}</Button>}
        >
          {pt ? LEGACY_INVENTORY_NOTICE.pt : LEGACY_INVENTORY_NOTICE.en}
        </Alert>
        <InventoryGroup title={t('Agents')} items={agents} selected={selected} onSelect={onSelect} />
        <InventoryGroup title={t('Compositions and infrastructure')} items={compositions} selected={selected} onSelect={onSelect} />
      </SpaceBetween>
    </ContentLayout>
  );
}

function EntityDetail({ entity, navigate }: { entity: SelectedEntity; navigate: (view: View) => void }): JSX.Element {
  const { locale, t } = useI18n();
  const pt = locale === 'pt-BR';
  return (
    <ContentLayout header={<Header variant="h1" description={entity.description} actions={<Button onClick={() => navigate('inventory')}>{t('Back to inventory')}</Button>}>{entity.name}</Header>}>
      <SpaceBetween size="l">
        {!entity.deployed && <Alert type="info" header={t('Catalog capability')}>{pt ? 'Esta capability ainda não foi implantada. Use Provisionar para criar uma proposta governada.' : 'This capability is not deployed yet. Use Provision to create a governed manifest proposal.'}</Alert>}
        <EntitySections entity={entity} navigate={navigate} />
      </SpaceBetween>
    </ContentLayout>
  );
}

function Operate({ navigate }: { navigate: (view: View) => void }): JSX.Element {
  const { locale, t } = useI18n();
  const pt = locale === 'pt-BR';
  return (
    <ContentLayout header={<Header variant="h1" description={pt ? 'Uma visão operacional entre Application, Execution e Data Planes.' : 'One operational view across application, execution and data planes.'}>{t('Operate')}</Header>}>
      <Cards
        items={integrations}
        cardDefinition={{
          header: (item: IntegrationItem) => item.name,
          sections: [
            { id: 'purpose', content: (item: IntegrationItem) => pt ? (INTEGRATION_PT[item.name] ?? item.purpose) : item.purpose },
            { id: 'plane', header: t('Plane'), content: (item: IntegrationItem) => item.plane },
            { id: 'status', header: t('Status'), content: (item: IntegrationItem) => <StatusIndicator type={item.status === 'Active' ? 'success' : 'warning'}>{t(item.status)}</StatusIndicator> },
            { id: 'action', header: t('Access'), content: (item: IntegrationItem) => item.name === 'Argo CD'
              ? <Link href={ARGO_CD_URL} external>{t('Open Argo CD')}</Link>
              : item.name === 'AI Platform Gateway'
                ? <Link href="#gateway" onFollow={event => { event.preventDefault(); navigate('gateway'); }}>{t('Open AI Gateway')}</Link>
              : CLUSTER_CONSOLES[item.name]
                ? <Link href={CLUSTER_CONSOLES[item.name]} external>{pt ? 'Abrir console (port-forward local)' : 'Open console (local port-forward)'}</Link>
                : <Box variant="small" color="text-status-inactive">{pt ? 'Sem console público (opera via GitOps/port-forward)' : 'No public console (operated via GitOps/port-forward)'}</Box> },
          ],
        }}
        cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 2 }, { minWidth: 1000, cards: 3 }]}
        empty={<Box textAlign="center">{t('No integrations found')}</Box>}
      />
    </ContentLayout>
  );
}

function AgentPlatformContent(): JSX.Element {
  const { locale, setLocale, t } = useI18n();
  const location = useLocation();
  const navigatePath = useNavigate();
  const pt = locale === 'pt-BR';
  const serviceRoute = location.pathname.startsWith('/agent-platform/services/');
  /*
   * A view é DERIVADA do location, não guardada em paralelo a ele.
   *
   * Antes havia um `useState` sincronizado por um listener de `hashchange` mais `history.pushState`
   * direto. Isso dava duas fontes de verdade para a mesma coisa, e elas divergiam: o pushState
   * manual não notifica o router, então `useLocation` e o estado local discordavam depois de um
   * Back, e a aba abria numa view diferente da URL. Com a derivação, a URL é a única fonte e o
   * Back do browser funciona sem código nenhum.
   */
  const resolved = resolveRoute(location);
  const view: View = resolved.view;
  /*
   * Normalização de URL: caminho canônico (`/agent-platform/catalog`) ou alias de hash antigo vira o
   * hash canônico com `replace`, preservando `?project=`. Um hash que não existe cai na home E diz
   * qual era (`resolved.unknown`), em vez de fingir que o link funcionou.
   */
  useEffect(() => {
    if (!resolved.redirect || serviceRoute) return;
    navigatePath({ pathname: '/agent-platform/', search: location.search, hash: resolved.canonical }, { replace: true });
  }, [resolved.redirect, resolved.canonical, serviceRoute, location.search, navigatePath]);
  const [liveCounts, setLiveCounts] = useState<LiveCounts>({ counts: null, loading: true, error: '' });
  const [backlogOpen, setBacklogOpen] = useState(false);
  /*
   * Notificações (notifications-center): o sino na barra abre o drawer `tools` do AppLayout; o badge
   * vem do polling de `useNotifications`. 503 (store desligado) esconde o sino em vez de parecer erro.
   */
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notifications = useNotifications();
  /*
   * Escopo de projeto (issue #10). A URL é a fonte: `?project=` e `ns`, nada em storage. O projeto
   * é "pegajoso" na sessão da aba: uma navegação interna que monta a URL sem ele (link de serviço,
   * filtro da listagem) recebe de volta o último projeto escolhido, então trocar de tela nunca
   * troca de projeto em silêncio. Escolher "Todos os projetos" limpa a memória.
   *
   * Projeto pedido na URL e que não existe para a sessão continua sendo PEDIDO: o servidor responde
   * 404 e a tela mostra isso, em vez de cair calada na visão de todos os projetos.
   */
  const scope = useProjectScope();
  const urlProject = readUrlScope(location.search).project ?? null;
  const lastProject = useRef<string | null>(urlProject);
  if (urlProject) lastProject.current = urlProject;
  const implicitProject = scope.selection?.status === 'ready' && scope.selection.implicit ? scope.selection.project.id : null;
  const activeProject = urlProject ?? lastProject.current ?? implicitProject;
  const owners: Record<string, string> = {};
  const projectOwners: Record<string, { team: string; contact: string }> = {};
  if (scope.state.status === 'loaded') {
    for (const project of scope.state.context.projects) {
      projectOwners[project.id] = project.owner;
      for (const ns of project.namespaces) owners[ns] = project.id;
    }
  }
  // Publicado no render, antes dos efeitos dos filhos: o primeiro fetch de qualquer view já sai com o escopo.
  setActiveScope({ project: activeProject, owners, teams: scope.state.status === 'loaded' ? scope.state.context.teams : [], projectOwners,
    projects: scope.state.status === 'loaded' ? scope.state.context.projects : [] });
  const scopeSearch = activeProject ? `?${new URLSearchParams({ [PROJECT_PARAM]: activeProject }).toString()}` : '';
  const setView = (next: View) => navigatePath({ pathname: '/agent-platform/', search: scopeSearch, hash: `#${next}` });
  const applyProject = (project: string | null) => {
    lastProject.current = project;
    const params = new URLSearchParams(location.search);
    params.delete(NAMESPACE_PARAM);
    if (project) params.set(PROJECT_PARAM, project); else params.delete(PROJECT_PARAM);
    const search = params.toString();
    // Um plano ou pedido aberto pela rota pertence ao projeto anterior: a view volta ao início dela.
    const hash = routeParam(location.hash, view) ? viewHash(view) : location.hash;
    navigatePath({ pathname: location.pathname, search: search ? `?${search}` : '', hash });
  };
  /*
   * Trocar de projeto com rascunho preso ao projeto (wizard de Create, pedido do Assistant) pede
   * confirmação. Studio e Agent Builder não são presos ao projeto e não remontam (contentKey).
   */
  const [pendingSwitch, setPendingSwitch] = useState<Extract<ProjectSwitch, { kind: 'confirm' }> | null>(null);
  const selectProject = (project: string | null) => {
    const decision = decideProjectSwitch(activeProject, project);
    if (decision.kind === 'apply') applyProject(decision.project);
    else if (decision.kind === 'confirm') setPendingSwitch(decision);
  };
  const activeScopeProject = scope.state.status === 'loaded'
    ? scope.state.context.projects.find(project => project.id === activeProject) ?? null : null;
  const routeTo = (target: View, param: string | null) =>
    navigatePath({ pathname: '/agent-platform/', search: scopeSearch, hash: viewHash(target, param) });

  /*
   * Troca de view: título da aba, topo da página e foco no h1 da view nova, para teclado e leitor
   * de tela não ficarem presos no item de menu. O primeiro render não move o foco.
   */
  const contentRef = useRef<HTMLDivElement>(null);
  const viewId = serviceRoute ? 'services' : view;
  const viewKey = serviceRoute ? location.pathname : view;
  const firstView = useRef(true);
  useEffect(() => { document.title = viewTitle(viewId, pt); }, [viewId, pt]);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return undefined; }
    window.scrollTo({ top: 0 });
    return focusViewHeading(contentRef.current as unknown as RootLike | null,
      run => window.requestAnimationFrame(run), id => window.cancelAnimationFrame(id));
  }, [viewKey]);
  useEffect(() => {
    if (urlProject || !lastProject.current) return;
    const params = new URLSearchParams(location.search);
    params.set(PROJECT_PARAM, lastProject.current);
    navigatePath({ pathname: location.pathname, search: `?${params.toString()}`, hash: location.hash }, { replace: true });
  }, [location.pathname, location.search, location.hash, urlProject, navigatePath]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    /*
     * Contagem live por capability, da cluster-api. É a MESMA fonte que o catálogo usa, e é o que
     * faz o badge do menu e o estado Adicionado do catálogo não poderem discordar. Falha deixa
     * `counts: null`, que a UI mostra como não lido em vez de inventar disponibilidade.
     */
    const refresh = () => listCapabilities({ counts: true }, controller.signal)
      .then(response => {
        if (!active) return;
        const map: Record<string, number | null> = {};
        for (const capability of response.capabilities) {
          map[capability.capability] = capability.instances === undefined ? null : capability.instances;
        }
        setLiveCounts({ counts: map, loading: false, error: '' });
      })
      .catch(cause => {
        if (!active) return;
        const message = cause instanceof Error && cause.message ? cause.message : 'cluster-api unavailable';
        setLiveCounts({ counts: null, loading: false, error: message });
      });
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, [activeProject]);
  const [panelEntity, setPanelEntity] = useState<SelectedEntity | null>(null);

  const content = serviceRoute
    ? <Routes>
        <Route path="services/:capabilitySlug/:namespace/:name" element={<LiveResourceDetailRoute />} />
        <Route path="services/:capabilitySlug" element={<LiveInventoryRoute />} />
      </Routes>
    : view === 'home'
      ? <DevHomePage
          counts={liveCounts}
          onNavigateView={next => setView(next as View)}
          onNavigatePath={path => navigatePath(path)}
        />
    : view === 'catalog'
      ? <ServiceCatalogPage
          counts={liveCounts}
          onOpenService={capability => navigatePath(servicePathFor(capability))}
          onCreate={() => setView('provision')}
          onNavigateView={next => setView(next as View)}
        />
    : view === 'compositions'
      ? <CompositionsPage
          onOpenService={capability => navigatePath(servicePathFor(capability))}
          onCreate={() => setView('provision')}
        />
    : view === 'scorecards'
      ? <ScorecardsPage onOpenDetail={path => navigatePath(path)} />
    : view === 'dependencies'
      ? <DependenciesPage onOpenDetail={path => navigatePath(path)} />
    : view === 'teams'
      ? <TeamsPage scope={scope} onNavigateView={next => setView(next)} />
    : view === 'overview'
    ? <Overview navigate={setView} />
    : view === 'getting-started'
      ? <FirstRun />
    : view === 'provision'
      /*
       * Sem ContentLayout com h1 próprio: o Wizard do Cloudscape já renderiza o título da etapa
       * como h1 (e o foca a cada troca de etapa), então o h1 "Provisionar" deixava a página com
       * dois h1. O nome da tela segue no título da aba e na navegação lateral.
       */
      ? <ProvisioningFlow project={activeScopeProject} />
    : view === 'studio'
      ? <ServiceStudioPage locale={locale} requestId={routeParam(location.hash, 'studio')} onRequested={id => routeTo('studio', id)} />
    : view === 'assistant'
      ? <PlatformAssistantPage scope={scope} locale={locale} onSelectProject={project => selectProject(project)}
          planId={routeParam(location.hash, 'assistant')} onPlanOpened={id => routeTo('assistant', id)} />
    : view === 'project'
      ? <ProjectContextPage scope={scope} locale={locale} />
    : view === 'agent-builder'
      /*
       * Sem ContentLayout com h1 próprio, pelo mesmo motivo do Provisionar: na aba Criar o Wizard
       * já tem o h1. O AgentBuilder é dono do título e decide a tag por aba (BuilderTitle).
       */
      ? <AgentBuilder />
      : view === 'inventory'
        ? <LegacyInventory navigate={setView} selected={panelEntity} onSelect={setPanelEntity} />
        /*
         * `#entity` é um link antigo e só existe dentro do caminho legado. Ele usa a MESMA
         * seleção do painel, em vez de um segundo estado: havia `selectedEntity` e `panelEntity`
         * guardando a mesma coisa, e eles divergiam. Sem item selecionado, o link cai no
         * inventário legado, que explica onde o usuário está.
         */
        : view === 'entity'
          ? (panelEntity
            ? <EntityDetail entity={panelEntity} navigate={setView} />
            : <LegacyInventory navigate={setView} selected={panelEntity} onSelect={setPanelEntity} />)
          : view === 'operate'
            ? <Operate navigate={setView} />
          : view === 'gateway'
            ? <ContentLayout header={<Header variant="h1" description={locale === 'pt-BR' ? 'Saúde, governança, custo e playground pelo AI Gateway privado.' : 'Health, governance, cost and playground through the private AI Platform Gateway.'}>{t('AI Gateway')}</Header>}><GatewayPanel /></ContentLayout>
            : view === 'personas'
              ? <PersonasPage />
            : view === 'cluster'
              ? <ClusterExplorer />
            : view === 'help'
              ? <HelpPage onOpenDocs={() => setView('docs')} />
            : view === 'docs'
              ? <DocsPage />
            : view === 'integrations'
              ? <IntegrationsPage />
            : view === 'audit'
              ? <AuditLogPage onNavigateHash={hash => navigatePath({ pathname: '/agent-platform/', search: scopeSearch, hash })} />
              : <AdminConsole />;

  /*
   * Seletor de projeto no padrão de seletor de contexto do Cloudscape (menu da barra superior), com
   * o texto do contexto sempre visível. "Todos os projetos" só existe em `compat`, que é o único
   * modo em que o servidor aceita pedido sem projeto, e só para quem enxerga todos.
   */
  const scopeContext = scope.state.status === 'loaded' ? scope.state.context : null;
  const visibleProjects = (scopeContext?.projects ?? []).filter(project => project.lifecycle.state !== 'retired');
  const activeName = visibleProjects.find(project => project.id === activeProject)?.name ?? activeProject;
  const projectUtility: TopNavigationProps.Utility = {
    type: 'menu-dropdown',
    iconName: 'folder',
    ariaLabel: pt ? 'Projeto ativo' : 'Active project',
    text: scope.state.status === 'loading'
      ? (pt ? 'Projeto: carregando' : 'Project: loading')
      : scope.state.status === 'error'
        ? (pt ? 'Projeto: indisponível' : 'Project: unavailable')
        : `${pt ? 'Projeto' : 'Project'}: ${activeName ?? (pt ? 'todos' : 'all')}`,
    items: [
      ...(scopeContext?.enforcement === 'compat' && visibleProjects.length > 1
        ? [{ id: '__all', text: `${activeProject ? '' : '✓ '}${pt ? 'Todos os projetos' : 'All projects'}` }]
        : []),
      ...visibleProjects.map(project => ({
        id: project.id,
        text: `${project.id === activeProject ? '✓ ' : ''}${project.name}`,
        secondaryText: `${project.namespaces.join(', ')} · ${project.role}`,
      })),
      { id: '__details', text: pt ? 'Detalhes do projeto' : 'Project details' },
    ],
    onItemClick: ({ detail }) => {
      if (detail.id === '__details') setView('project');
      else selectProject(detail.id === '__all' ? null : detail.id);
    },
  };

  return (
    <>
      <TopNavigation
        identity={{ href: '#home', title: t('AppMod Agent Platform'), onFollow: event => { event.preventDefault(); setView('home'); } }}
        // A busca NÃO fica aqui: com `search` preenchido o TopNavigation recolhe os rótulos das utilities
        // (Backlog, idioma, Ajuda viram só ícone em 1440 px, medido live em 24/10/2026). Ela vive no topo
        // do menu lateral, ver `navigation` do AppLayout.
        utilities={[
          projectUtility,
          { type: 'button', text: pt ? 'Catálogo de serviços' : 'Service catalog', iconName: 'grid-view', variant: 'primary-button', href: '#catalog', onClick: event => { event.preventDefault(); setView('catalog'); } },
          { type: 'button', text: `${locale === 'pt-BR' ? 'Backlog' : 'Backlog'} ${backlogProgress().done}/${backlogProgress().total}`, iconName: 'gen-ai', onClick: () => setBacklogOpen(true) },
          {
            type: 'menu-dropdown',
            text: locale === 'pt-BR' ? 'Português (BR)' : 'English (US)',
            iconName: 'globe',
            items: [
              { id: 'pt-BR', text: locale === 'pt-BR' ? '✓ Português (Brasil)' : 'Português (Brasil)' },
              { id: 'en-US', text: locale === 'en-US' ? '✓ English (US)' : 'English (US)' },
            ],
            onItemClick: ({ detail }) => setLocale(detail.id as 'pt-BR' | 'en-US'),
          },
          ...(notifications.state.status === 'disabled' ? [] : [{
            type: 'button' as const, iconName: 'notification' as const, ariaLabel: pt ? 'Notificações' : 'Notifications',
            text: pt ? 'Notificações' : 'Notifications', badge: notifications.unread > 0,
            onClick: () => setNotificationsOpen(open => !open),
          }]),
          { type: 'button', text: t('Help'), iconName: 'status-info', onClick: () => setView('help') },
          { type: 'button', text: t('Reports portal'), href: '/', external: true },
        ]}
      />
      {backlogOpen && <Suspense fallback={null}><BacklogModal onDismiss={() => setBacklogOpen(false)} /></Suspense>}
      <Modal visible={pendingSwitch !== null} onDismiss={() => setPendingSwitch(null)}
        header={pt ? 'Trocar de projeto?' : 'Switch project?'}
        footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
          <Button variant="link" onClick={() => setPendingSwitch(null)}>{pt ? 'Ficar neste projeto' : 'Stay in this project'}</Button>
          <Button variant="primary" onClick={() => { const next = pendingSwitch; setPendingSwitch(null); if (next) applyProject(next.project); }}>
            {pt ? 'Trocar de projeto' : 'Switch project'}</Button>
        </SpaceBetween></Box>}>
        {pendingSwitch && (pt
          ? `Há rascunho preso ao projeto atual (${pendingSwitch.drafts.join(', ')}). O Assistant descarta o pedido; o wizard de Create mantém o que você preencheu e passa a gravar no namespace do novo projeto.`
          : `There is a draft bound to the current project (${pendingSwitch.drafts.join(', ')}). The Assistant discards its request; the Create wizard keeps what you filled in and writes to the new project's namespace.`)}
      </Modal>
      <AppLayout
        navigation={
          <div data-testid="navigation-panel">
            {/* Busca global no topo do menu: largura do painel (280 px), dropdown em `expandToViewport`. */}
            <Box padding={{ horizontal: 'l', top: 'm' }}>
              <GlobalSearch catalog={capabilities} onNavigate={target => (target.kind === 'view' ? setView(target.view as View) : navigatePath(target.path))} />
            </Box>
            <SideNavigation
              header={{ href: '#home', text: t('Agent Platform') }}
              activeHref={serviceRoute ? serviceNavHref(location.pathname) : `#${view}`}
              items={getNavigationItems(t, liveCounts, pt)}
              onFollow={event => {
                if (event.detail.external) return;
                event.preventDefault();
                const href = event.detail.href;
                if (href.startsWith('#')) setView(href.slice(1) as View);
                else navigatePath(href);
              }}
            />
          </div>
        }
        breadcrumbs={<BreadcrumbGroup items={[{ text: 'AppMod LATAM', href: '#home' }, { text: t('Agent Platform'), href: '#home' }]} onFollow={event => { event.preventDefault(); setView('home'); }} />}
        // Um aviso de escopo só, aqui. A página de projeto mostra os mesmos estados junto do seletor.
        notifications={<>
          {resolved.unknown && !serviceRoute && (
            <Alert type="warning" dismissible onDismiss={() => setView('home')} header={pt ? 'Página não encontrada' : 'Page not found'} data-testid="unknown-route">
              {pt ? `Não existe a página "#${resolved.unknown}". Você está no Início.` : `There is no "#${resolved.unknown}" page. You are on Home.`}
            </Alert>
          )}
          {view === 'project' && !serviceRoute ? null
            : <ScopeStateNotice state={scope.state} selection={scope.selection} locale={locale} onRetry={scope.retry} onChooseProject={selectProject} />}
        </>}
        // key: trocar de projeto remonta as views de LEITURA, então nada lido no projeto anterior fica
        // na tela. Views com rascunho (Create, Agent Builder, Studio) ficam montadas: ver contentKey.
        content={scope.state.status === 'loading' ? viewFallback : <div ref={contentRef} tabIndex={-1} data-view={viewId}>
          <Suspense key={contentKey(viewId, activeProject)} fallback={viewFallback}>{content}</Suspense></div>}
        splitPanel={view === 'inventory' && panelEntity
          ? <SplitPanel header={panelEntity.name} i18nStrings={{ preferencesTitle: t('Split panel preferences'), preferencesConfirm: 'OK', preferencesCancel: t('Cancel'), closeButtonAriaLabel: t('Close panel'), openButtonAriaLabel: t('Open panel'), resizeHandleAriaLabel: t('Resize panel') }}><EntitySections entity={panelEntity} navigate={setView} /></SplitPanel>
          : undefined}
        splitPanelOpen={view === 'inventory' && Boolean(panelEntity)}
        onSplitPanelToggle={({ detail }) => { if (!detail.open) setPanelEntity(null); }}
        tools={(
          <div data-testid="notifications-panel" style={{ padding: '16px' }}>
            <Header variant="h2">{pt ? 'Notificações' : 'Notifications'}</Header>
            <NotificationsPanel state={notifications.state} pt={pt}
              onMarkAllRead={() => { void notifications.markAllRead(); }}
              onRetry={notifications.refresh}
              onOpen={(item, hash) => {
                void notifications.markRead(item.id);
                if (hash) { setNotificationsOpen(false); navigatePath({ pathname: '/agent-platform/', search: scopeSearch, hash }); }
              }} />
          </div>
        )}
        toolsOpen={notificationsOpen}
        toolsWidth={440}
        onToolsChange={({ detail }) => setNotificationsOpen(detail.open)}
        toolsHide={notifications.state.status === 'disabled'}
        ariaLabels={{ tools: pt ? 'Notificações' : 'Notifications', toolsClose: pt ? 'Fechar notificações' : 'Close notifications', toolsToggle: pt ? 'Abrir notificações' : 'Open notifications' }}
      />
    </>
  );
}

export function AgentPlatformPage(): JSX.Element {
  return <I18nProvider><AgentPlatformContent /></I18nProvider>;
}

export default AgentPlatformPage;
