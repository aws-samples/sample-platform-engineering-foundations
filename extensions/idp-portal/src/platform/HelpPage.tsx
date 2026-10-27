import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useI18n } from './i18n';
import { ACCOUNT_CONSOLE_URL, API_IDENTITY_SOURCE, ARGO_CD_URL, INTERNAL, IDENTITY_PROVIDER, API_SIGNING, gitBlobUrl, gitTreeUrl } from './deployment';

const ARGO_URL = ARGO_CD_URL;
const IDC_URL = 'https://console.aws.amazon.com/singlesignon/home?region=sa-east-1';
const ISENGARD_URL = ACCOUNT_CONSOLE_URL;
const DOCS_URL = gitTreeUrl('docs/agent-platform');
const TOUR_URL = gitBlobUrl('docs/agent-platform/product-tour.md');

interface QuickTask {
  title: string;
  description: string;
  href: string;
  action: string;
  external?: boolean;
  icon: 'add-plus' | 'view-full' | 'status-info' | 'gen-ai' | 'share' | 'check' | 'notification';
}

interface AccessRow {
  surface: string;
  identity: string;
  role: string;
  source: string;
}

export function HelpPage({ onOpenDocs }: { onOpenDocs?: () => void } = {}): JSX.Element {
  const { locale, t } = useI18n();
  const pt = locale === 'pt-BR';

  const quickTasks: QuickTask[] = [
    {
      title: pt ? 'Provisionar uma capability' : 'Provision a capability',
      description: pt ? 'Escolha uma capability do catálogo, revise o manifest e proponha a mudança por GitOps.' : 'Choose a catalog capability, review the manifest and propose the change through GitOps.',
      href: '#provision', action: pt ? 'Abrir Provisionar' : 'Open Provision', icon: 'add-plus',
    },
    {
      title: pt ? 'Acompanhar recursos' : 'Track resources',
      description: pt ? 'Abra o Catálogo de serviços e entre na capability para ver objetos live, conditions e status.' : 'Open the Service Catalog and enter a capability to see live objects, conditions and status.',
      href: '#catalog', action: pt ? 'Abrir Catálogo' : 'Open Catalog', icon: 'view-full',
    },
    {
      title: pt ? 'Entender uma composição' : 'Understand a composition',
      description: pt ? 'Veja o grafo de recursos que o kro cria, os campos que você preenche, as revisões da definição e quais instâncias já estão na revisão atual, por definição.' : 'See the resource graph kro creates, the fields you fill, the definition revisions and which instances are already on the current revision, per definition.',
      href: '#compositions', action: pt ? 'Abrir Composições' : 'Open Compositions', icon: 'share',
    },
    {
      title: pt ? 'Medir contra os padrões' : 'Measure against the standards',
      description: pt ? 'Scorecards avalia cada recurso contra as regras da plataforma (owner, GitOps, Ready, proveniência) e diz o nível Bronze, Prata ou Ouro e o que falta para subir.' : 'Scorecards evaluates every resource against the platform rules (owner, GitOps, Ready, provenance) and tells the Bronze, Silver or Gold level and what is missing to move up.',
      href: '#scorecards', action: pt ? 'Abrir Scorecards' : 'Open Scorecards', icon: 'check',
    },
    {
      title: pt ? 'Ver quem depende de quem' : 'See who depends on whom',
      description: pt ? 'Dependências cruza as instâncias do escopo: quem consome o output ou o nome de outra, o que foi declarado por label e qual cópia foi promovida de onde, com a evidência exata de cada aresta.' : 'Dependencies crosses the instances in scope: who consumes another one\'s output or name, what was declared by label and which copy was promoted from where, with the exact evidence of every edge.',
      href: '#dependencies', action: pt ? 'Abrir Dependências' : 'Open Dependencies', icon: 'share',
    },
    {
      title: pt ? 'Ver se as ferramentas estão de pé' : 'See whether the tools are up',
      description: pt ? 'Integrações mede agora Argo CD, kro, ACK, metrics-server, Argo Workflows, kagent, Langfuse, Grafana, Keycloak e a trilha de eventos, com dica de correção por linha.' : 'Integrations measures Argo CD, kro, ACK, metrics-server, Argo Workflows, kagent, Langfuse, Grafana, Keycloak and the events trail right now, with a fix hint per row.',
      href: '#integrations', action: pt ? 'Abrir Integrações' : 'Open Integrations', icon: 'status-info',
    },
    {
      title: pt ? 'Ver quem fez o quê' : 'See who did what',
      description: pt ? 'Auditoria de pedidos, merge requests, planos do Assistant e ações Day 2, com ator, resultado e hora. O sino na barra mostra os eventos dos seus projetos.' : 'Audit log of requests, merge requests, Assistant plans and Day 2 actions, with actor, result and time. The bell in the top bar shows the events of your projects.',
      href: '#audit', action: pt ? 'Abrir Auditoria' : 'Open Audit log', icon: 'notification',
    },
    {
      title: pt ? 'Operar o cluster' : 'Operate the cluster',
      description: pt ? 'Inspecione workloads, pods, logs, services, nodes, events e objetos kro/ACK.' : 'Inspect workloads, pods, logs, services, nodes, events and kro/ACK objects.',
      href: '#cluster', action: pt ? 'Abrir Cluster' : 'Open Cluster', icon: 'status-info',
    },
    {
      title: pt ? 'Conversar com uma persona' : 'Chat with a persona',
      description: pt ? 'Use o Platform Engineer ou TechWriter pelo AI Gateway privado.' : 'Use the Platform Engineer or TechWriter through the private AI Gateway.',
      href: '#personas', action: pt ? 'Abrir Personas' : 'Open Personas', icon: 'gen-ai',
    },
  ];

  const accessRows: AccessRow[] = [
    { surface: pt ? 'Portal' : 'Portal', identity: IDENTITY_PROVIDER, role: pt ? 'Usuário autenticado' : 'Authenticated user', source: INTERNAL ? 'the internal gateway' : 'Cognito user pool' },
    { surface: 'Argo CD', identity: 'IAM Identity Center', role: 'VIEWER / ADMIN', source: 'AppModAgentPlatformViewers' },
    { surface: pt ? 'APIs do portal' : 'Portal APIs', identity: API_SIGNING, role: pt ? 'Allowlist + admin server-side' : 'Allowlist + server-side admin', source: API_IDENTITY_SOURCE },
    { surface: 'Rancher / Headlamp', identity: pt ? 'Port-forward local (scripts/platform-ui.sh start), com a sua credencial AWS' : 'Local port-forward (scripts/platform-ui.sh start), with your AWS credential', role: pt ? 'Sem endpoint público; login único em andamento' : 'No public endpoint; single login in progress', source: 'EKS access entry' },
  ];

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={pt
            ? 'Encontre uma tarefa, entenda o fluxo e resolva problemas sem precisar conhecer kro, ACK ou Argo CD.'
            : 'Find a task, understand the flow and solve problems without needing to know kro, ACK or Argo CD.'}
          actions={
            <SpaceBetween direction="horizontal" size="s">
              {onOpenDocs
                ? <Button variant="primary" iconName="view-full" onClick={onOpenDocs} data-testid="help-open-docs">{pt ? 'Tour visual e guias (no portal)' : 'Visual tour and guides (in the portal)'}</Button>
                : <Button href={TOUR_URL} target="_blank" iconName="view-full">{pt ? 'Tour visual' : 'Visual tour'}</Button>}
              <Button href={DOCS_URL} target="_blank" iconName="external">{pt ? 'Documentação técnica' : 'Technical documentation'}</Button>
            </SpaceBetween>
          }
        >
          {pt ? 'Central de ajuda' : 'Help center'}
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Alert type="info" header={pt ? 'Comece pela tarefa, não pela engine' : 'Start with the task, not the engine'}>
          {pt
            ? 'O portal abstrai a implementação. Use o catálogo para criar, o Inventário para acompanhar e o Cluster para diagnosticar. Argo CD, kro e ACK continuam disponíveis para investigação avançada.'
            : 'The portal abstracts the implementation. Use the catalog to create, Inventory to track and Cluster to diagnose. Argo CD, kro and ACK remain available for advanced investigation.'}
        </Alert>

        <Container header={<Header variant="h2">{pt ? 'Personalizar a Home' : 'Customize the Home'}</Header>}>
          <KeyValuePairs columns={1} items={[
            { label: '1', value: pt ? 'Na Home, clique em Adicionar widget para abrir a paleta e arraste um widget para o painel, ou use a alça dele com o teclado.' : 'On the Home, choose Add widget to open the palette and drag a widget onto the board, or use its handle with the keyboard.' },
            { label: '2', value: pt ? 'Mova um widget pela alça de arrastar e redimensione pela alça do canto. Com o teclado: espaço ou Enter pega, setas movem ou redimensionam, espaço ou Enter solta, Esc cancela. Para tirar um widget, abra o menu Opções no canto dele e escolha Remover do painel.' : 'Move a widget by its drag handle and resize it by the corner handle. With the keyboard: Space or Enter picks up, arrows move or resize, Space or Enter drops, Escape cancels. To take a widget off the board, open its Options menu and choose Remove from board.' },
            { label: '3', value: pt ? 'Cada mudança é salva na hora, por usuário e project, e vale no desktop e no celular. Restaurar padrão volta ao layout inicial com todos os widgets disponíveis para você.' : 'Every change is saved immediately, per user and project, on desktop and mobile. Reset layout returns to the initial layout with every widget available to you.' },
          ]} />
        </Container>

        <Container header={<Header variant="h2" description={pt ? 'Atalhos para os fluxos mais usados.' : 'Shortcuts to the most common workflows.'}>{pt ? 'O que você quer fazer?' : 'What do you want to do?'}</Header>}>
          <Cards
            items={quickTasks}
            cardDefinition={{
              header: item => <SpaceBetween direction="horizontal" size="xs" alignItems="center"><span>{item.title}</span><Badge color="blue">{pt ? 'Tarefa' : 'Task'}</Badge></SpaceBetween>,
              sections: [
                { id: 'description', content: item => item.description },
                { id: 'action', content: item => <Button href={item.href} iconName={item.icon}>{item.action}</Button> },
              ],
            }}
            cardsPerRow={[{ cards: 1 }, { minWidth: 650, cards: 2 }, { minWidth: 1100, cards: 4 }]}
            empty={<Box>-</Box>}
          />
        </Container>

        <ColumnLayout columns={2} variant="text-grid">
          <Container header={<Header variant="h2">{pt ? 'Fluxo de provisionamento' : 'Provisioning flow'}</Header>}>
            <SpaceBetween size="m">
              <KeyValuePairs columns={1} items={[
                { label: '1. Request', value: pt ? 'Escolha uma capability real do catálogo e preencha somente os campos aplicáveis.' : 'Choose a real catalog capability and fill only the applicable fields.' },
                { label: '2. Review', value: pt ? 'Revise o template da capability, lifecycle, ownership e região.' : 'Review the capability template, lifecycle, ownership and region.' },
                { label: '3. Propose', value: pt ? 'Crie o arquivo ou MR. O GitLab é o source of truth.' : 'Create the file or MR. GitLab is the source of truth.' },
                { label: '4. Reconcile', value: pt ? 'CI espelha no CodeCommit; Argo CD reconcilia; kro expande; ACK provisiona AWS.' : 'CI mirrors to CodeCommit; Argo CD reconciles; kro expands; ACK provisions AWS.' },
                { label: '5. Observe', value: pt ? 'Acompanhe no Inventário, Cluster Explorer e Argo CD.' : 'Track it in Inventory, Cluster Explorer and Argo CD.' },
              ]} />
              <Button href="#provision" variant="primary" iconName="add-plus">{pt ? 'Criar solicitação' : 'Create request'}</Button>
            </SpaceBetween>
          </Container>

          <Container header={<Header variant="h2">{pt ? 'Estado da plataforma' : 'Platform state'}</Header>}>
            <SpaceBetween size="s">
              <StatusIndicator type="success">{pt ? 'GitOps -> kro -> ACK: live e provado com DynamoDB/S3 reais' : 'GitOps -> kro -> ACK: live and proven with real DynamoDB/S3'}</StatusIndicator>
              <StatusIndicator type="success">{pt ? 'Cluster Explorer: backend live no endpoint privado do EKS' : 'Cluster Explorer: live backend on the private EKS endpoint'}</StatusIndicator>
              <StatusIndicator type="in-progress">{pt ? 'SSO unificado Keycloak/IDC: em implementação' : 'Unified Keycloak/IDC SSO: in progress'}</StatusIndicator>
              <StatusIndicator type="warning">{pt ? 'Inbox persistido e kagent A2A: planejados' : 'Persisted inbox and kagent A2A: planned'}</StatusIndicator>
              <Box variant="small" color="text-body-secondary">{pt ? 'Abra o Backlog no topo para ver o detalhe e o status de cada item.' : 'Open Backlog in the top bar for item-level detail and status.'}</Box>
            </SpaceBetween>
          </Container>
        </ColumnLayout>

        <Container header={<Header variant="h2" description={pt ? 'Qual identidade protege cada superfície.' : 'Which identity protects each surface.'}>{pt ? 'Acesso e identidade' : 'Access and identity'}</Header>}>
          <Table
            variant="embedded"
            items={accessRows}
            columnDefinitions={[
              { id: 'surface', header: pt ? 'Superfície' : 'Surface', cell: row => row.surface },
              { id: 'identity', header: pt ? 'Autenticação' : 'Authentication', cell: row => row.identity },
              { id: 'role', header: pt ? 'Autorização' : 'Authorization', cell: row => row.role },
              { id: 'source', header: pt ? 'Fonte' : 'Source', cell: row => row.source },
            ]}
            empty={<Box>-</Box>}
          />
          <Box padding={{ top: 'm' }}>
            <SpaceBetween direction="horizontal" size="s">
              <Button href={ARGO_URL} target="_blank" iconName="external">{t('Open managed Argo CD')}</Button>
              <Button href={IDC_URL} target="_blank" iconName="external">{t('Open AWS Identity Center')}</Button>
              {ISENGARD_URL && <Button href={ISENGARD_URL} target="_blank" iconName="external">{t('Open the account console account')}</Button>}
            </SpaceBetween>
          </Box>
        </Container>

        <Container header={<Header variant="h2">{pt ? 'Resolução de problemas' : 'Troubleshooting'}</Header>}>
          <SpaceBetween size="s">
            <ExpandableSection headerText={pt ? 'Cluster ou Admin mostra Access denied / não carrega' : 'Cluster or Admin shows Access denied / does not load'}>
              <SpaceBetween size="s">
                {INTERNAL ? <Box>{pt ? 'Faça hard refresh. Confirme que o portal foi aberto pelo the internal gateway e que a sessão the corporate SSO está válida. O browser chama APIs AWS_IAM assinadas pelo runtime do the internal gateway; uma URL direta fora do the internal gateway não funciona.' : 'Hard refresh. Confirm the portal was opened through the internal gateway and the the corporate SSO session is valid. The browser calls AWS_IAM APIs signed by the the internal gateway runtime; a direct URL outside the internal gateway does not work.'}</Box> : <Box>{pt ? 'Faça hard refresh e confirme que a sessão está válida; se a API responder 403, o seu usuário não está autorizado neste deployment.' : 'Hard refresh and confirm the session is valid; a 403 from the API means your user is not authorized in this deployment.'}</Box>}
                <Box variant="small" color="text-body-secondary">{pt ? 'Se persistir, informe a aba e o horário. O backend registra request, ARN e motivo da recusa sem expor credenciais.' : 'If it persists, provide the tab and time. The backend logs request, ARN and denial reason without exposing credentials.'}</Box>
              </SpaceBetween>
            </ExpandableSection>
            <ExpandableSection headerText={pt ? 'Argo CD não abre ou não mostra Applications' : 'Argo CD does not open or show Applications'}>
              <Box>{pt ? 'Confirme o usuário do IAM Identity Center e a membership no grupo AppModAgentPlatformViewers. VIEWER é o acesso padrão; ADMIN exige aprovação explícita.' : 'Confirm the IAM Identity Center user and membership in AppModAgentPlatformViewers. VIEWER is the default; ADMIN requires explicit approval.'}</Box>
            </ExpandableSection>
            <ExpandableSection headerText={pt ? 'Application está OutOfSync ou Degraded' : 'Application is OutOfSync or Degraded'}>
              <Box>{pt ? 'Abra a Application no Argo CD e revise Resource Tree, conditions, manifests e events. Não sincronize manualmente para esconder drift; o Git continua sendo a fonte.' : 'Open the Application in Argo CD and review Resource Tree, conditions, manifests and events. Do not sync manually to hide drift; Git remains the source.'}</Box>
            </ExpandableSection>
            <ExpandableSection headerText={pt ? 'Manifest não passa no lint' : 'Manifest fails lint'}>
              <Box>{pt ? 'Volte ao schema e ao example da capability selecionada. O Workbench troca o template quando a capability muda; campos de compute só aparecem para agents.' : 'Return to the selected capability schema and example. The Workbench changes templates with the capability; compute fields appear only for agents.'}</Box>
            </ExpandableSection>
            <ExpandableSection headerText={pt ? 'Posso usar uma URL com credenciais?' : 'Can I use a URL with credentials?'}>
              {INTERNAL ? <Box>{pt ? 'Não. URLs não carregam credenciais the account console, tokens ou passwords. Argo CD usa IAM Identity Center e o portal usa the internal gateway/the corporate SSO + SigV4.' : 'No. URLs do not carry the account console credentials, tokens or passwords. This is not a password embedded in the URL. Argo CD uses IAM Identity Center and the portal uses the internal gateway/the corporate SSO + SigV4.'}</Box> : <Box>{pt ? 'Não. URLs não carregam tokens nem passwords; a autenticação é do provedor de identidade do deployment e o browser nunca vê credencial AWS.' : 'No. URLs never carry tokens or passwords; authentication belongs to the deployment identity provider and the browser never sees an AWS credential.'}</Box>}
            </ExpandableSection>
          </SpaceBetween>
        </Container>

        <Alert type="warning" header={pt ? 'Limites conhecidos, sem maquiagem' : 'Known limits, without spin'}>
          <ul>
            <li>{pt ? 'Agent definitions ainda não compilam automaticamente para uma instância kro/kagent.' : 'Agent definitions do not yet compile automatically into a kro/kagent instance.'}</li>
            <li>{pt ? 'Exec/shell interativo do Cluster Explorer exige WebSocket streaming e está no backlog.' : 'Interactive Cluster Explorer exec/shell requires WebSocket streaming and is in the backlog.'}</li>
            <li>{pt ? 'SSO Keycloak/Identity Center ainda não substituiu o onboarding atual.' : 'Keycloak/Identity Center SSO has not yet replaced the current onboarding flow.'}</li>
          </ul>
        </Alert>

        <Box textAlign="center" color="text-body-secondary">
          {pt ? 'Não encontrou? ' : 'Still stuck? '}
          <Link href={DOCS_URL} external>{pt ? 'Abra a documentação técnica' : 'Open the technical documentation'}</Link>
          {pt ? ' ou consulte o Backlog no topo.' : ' or check Backlog in the top bar.'}
        </Box>
      </SpaceBetween>
    </ContentLayout>
  );
}
