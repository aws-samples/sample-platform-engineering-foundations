import { ARGO_CD_URL, CLUSTER_CONSOLES, HOSTING, HOSTING_PURPOSE } from './deployment';
// Catalog capabilities now live in platform/catalog/**/capability.yaml (see catalogLoader.ts).
export interface InventoryItem {
  name: string;
  kind: string;
  owner: string;
  runtime: string;
  status: 'Ready' | 'Active';
}

export interface IntegrationItem {
  name: string;
  purpose: string;
  plane: 'Application' | 'Execution' | 'Data';
  status: 'Active' | 'Hardening';
}

export const inventory: InventoryItem[] = [
  { name: 'hello-agent', kind: 'ScheduledAgent', owner: 'platform-team', runtime: 'Argo Workflows', status: 'Ready' },
  { name: 'k8s-agent', kind: 'ConversationalAgent', owner: 'platform', runtime: 'kagent 0.9.9', status: 'Ready' },
  { name: 'smoke-sandbox', kind: 'Sandbox', owner: 'platform', runtime: 'Agent Sandbox v1beta1', status: 'Ready' },
  { name: 'scheduled-agent', kind: 'ResourceGraphDefinition', owner: 'platform', runtime: 'kro', status: 'Active' },
];

// Consoles do cluster pelo port-forward local (scripts/platform-ui.sh start), sempre em
// 127.0.0.1. Os NLBs internet-facing (/32 do operador) saíram em 28/09/2026: nenhuma UI
// recebe endpoint público. As portas precisam bater com o platform-ui.sh.
// Hosts e consoles mudam por flavor (interno vs extension pública): vivem em deployment.ts.
export { ARGO_CD_URL, CLUSTER_CONSOLES } from './deployment';

// Ferramentas com UX própria, listadas no menu lateral. `access` diz como se entra HOJE:
// Argo CD pelo IAM Identity Center; os outros pelo port-forward local, que usa a sua
// credencial AWS, até o login único (backlog consoles-via-sigv4-proxy / sso-oidc-consoles).
// kro-ui saiu daqui em 24/10/2026: a página Composições (#compositions) mostra o mesmo, nativo.
export interface ToolLink {
  name: string;
  href: string;
  access: 'idc' | 'port-forward';
}

// Só ferramentas que existem neste deployment: href vazio (flavor sem a UI) não vira item de menu.
export const TOOL_LINKS: ToolLink[] = ([
  { name: 'Argo CD', href: ARGO_CD_URL, access: 'idc' },
  { name: 'Rancher', href: CLUSTER_CONSOLES['Rancher'] ?? '', access: 'port-forward' },
  { name: 'Headlamp', href: CLUSTER_CONSOLES['Headlamp'] ?? '', access: 'port-forward' },
  { name: 'Keycloak', href: CLUSTER_CONSOLES['Keycloak'] ?? '', access: 'port-forward' },
] as ToolLink[]).filter(tool => tool.href);

export const integrations: IntegrationItem[] = [
  { name: HOSTING, purpose: HOSTING_PURPOSE.en, plane: 'Application', status: 'Active' },
  { name: 'Argo CD', purpose: 'GitOps reconciliation and drift correction', plane: 'Execution', status: 'Active' },
  { name: 'ACK + kro', purpose: 'AWS resource provisioning and platform compositions', plane: 'Execution', status: 'Active' },
  { name: 'Argo Workflows', purpose: 'Agent DAGs, schedules, retries and run history', plane: 'Execution', status: 'Active' },
  { name: 'AI Platform Gateway', purpose: 'Private Bedrock data plane; BFF and control API perimeter are the next increment', plane: 'Data', status: 'Hardening' },
  { name: 'ADOT + Langfuse', purpose: 'Agent traces, evaluations and trace-to-dataset loops', plane: 'Data', status: 'Active' },
  { name: 'Rancher', purpose: 'Kubernetes cluster explorer and workload console', plane: 'Execution', status: 'Active' },
  { name: 'Headlamp', purpose: 'Lightweight Kubernetes UI under evaluation to replace Rancher (read-only RBAC, logs and shell)', plane: 'Execution', status: 'Hardening' },
  { name: 'Keycloak', purpose: 'Platform SSO broker (SAML IdP for Identity Center federation)', plane: 'Application', status: 'Hardening' },
];
