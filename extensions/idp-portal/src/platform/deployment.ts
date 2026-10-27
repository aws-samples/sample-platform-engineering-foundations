/**
 * Perfil de deployment (backstage-killer passo 4, scrub de conteúdo): o ÚNICO lugar do frontend que
 * conhece host, URL ou nome de ferramenta que muda entre o portal interno (the internal gateway, GitLab interno,
 * PhoneTool, Argo CD do lab) e o formato público da extension em aws-samples (GitHub, Cognito, sem
 * diretório de pessoas). Nenhum outro arquivo de `src/` escreve um desses literais: o gate
 * `scripts/oss-scrub-gate.mjs` varre o bundle `oss` e reprova qualquer identificador interno que sobrar.
 *
 * Os valores INTERNOS vivem em `deployment.internal.ts` (passo 5): o export da extension
 * (`scripts/export-extension.py`) troca só aquele arquivo por um stub, e este fica idêntico nos dois
 * repositórios. Flavor vem do build (`VITE_CLOUDSCAPE_FLAVOR`); cada valor aceita override por env
 * `VITE_*` para a conta de quem instala a extension. Vazio = "não existe neste deployment", e a UI
 * omite o link.
 */
import { INTERNAL_DEPLOYMENT } from './deployment.internal';

const env = import.meta.env as Record<string, string | undefined>;

export type Flavor = 'internal' | 'oss';
// `import.meta.env.VITE_CLOUDSCAPE_FLAVOR` é um literal no build (vite.config.ts `define`), então
// `INTERNAL` vira constante, o ternário abaixo é resolvido e o Rollup descarta o perfil interno (objeto
// sem efeito colateral, import sem uso): o literal interno NÃO entra no bundle oss. Medido pelo gate.
export const INTERNAL: boolean = import.meta.env.VITE_CLOUDSCAPE_FLAVOR !== 'oss';
export const FLAVOR: Flavor = INTERNAL ? 'internal' : 'oss';

/** O que muda entre deployments. Um objeto por perfil; nunca um literal interno solto neste arquivo. */
export interface DeploymentProfile {
  /** Repositório Git que o portal lê e para onde abre arquivos e MRs. */
  gitWebBase: string;
  /** Pasta do portal dentro do repo ('' na raiz; a extension vive em extensions/idp-portal/). */
  gitRoot: string;
  /** Argo CD do deployment; vazio = sem UI exposta. */
  argoCdUrl: string;
  /** Consoles por port-forward local; vazio no público. */
  clusterConsoles: Readonly<Record<string, string>>;
  /** Diretório de pessoas para o alias do owner. Vazio = alias vira texto, sem link. */
  peopleDirectoryUrl: string;
  /** Nomes que a UI usa para explicar quem autentica e quem hospeda. */
  identityProvider: string;
  apiSigning: string;
  hosting: string;
  hostingPurpose: { pt: string; en: string };
  /** Defaults das APIs ('' = exige VITE_*_API_URL; o adapter falha nomeado em vez de bater em outra conta). */
  apiUrls: { cluster: string; platform: string; bff: string };
  apiRegions: { cluster: string; platform: string; bff: string };
  /** Role que o the internal gateway assume para chamar as APIs; '' fora do the internal gateway. */
  harmonyRoleArn: string;
  /** Console da conta que hospeda a plataforma; '' = sem link na Ajuda. */
  accountConsoleUrl: string;
  /** De onde vem a identidade do chamador nas APIs (texto da Ajuda). */
  apiIdentitySource: string;
  /** Entradas do hub além do portal (relatórios internos do time); vazio no público. */
  hubRoutes: readonly HubRoute[];
}

export interface HubRoute {
  path: string;
  name: string;
  icon?: string;
  reports?: { name: string; path: string; description?: string; date?: string; icon?: string; badge?: string }[];
  reportPath?: string;
  maintenance?: boolean;
}

export const PUBLIC_DEPLOYMENT: DeploymentProfile = {
  gitWebBase: 'https://github.com/aws-samples/sample-platform-engineering-foundations',
  gitRoot: 'extensions/idp-portal/',
  argoCdUrl: '',
  clusterConsoles: {},
  peopleDirectoryUrl: '',
  identityProvider: 'Amazon Cognito',
  apiSigning: 'JWT (Cognito)',
  hosting: 'Amazon CloudFront + S3',
  hostingPurpose: { pt: 'Hosting da SPA e autenticação Cognito com PKCE', en: 'SPA hosting and Cognito authentication with PKCE' },
  apiUrls: { cluster: '', platform: '', bff: '' },
  apiRegions: { cluster: 'us-east-1', platform: 'us-east-1', bff: 'us-east-1' },
  harmonyRoleArn: '',
  accountConsoleUrl: '',
  apiIdentitySource: 'API Gateway JWT authorizer',
  hubRoutes: [],
};

const PROFILE: DeploymentProfile = INTERNAL ? INTERNAL_DEPLOYMENT : PUBLIC_DEPLOYMENT;

const over = (value: string | undefined): string => (value?.trim() ? value.trim() : '');

export const GIT_WEB_BASE = over(env.VITE_GIT_WEB_BASE) || PROFILE.gitWebBase;
export const GIT_PROVIDER: 'gitlab' | 'github' = GIT_WEB_BASE.includes('gitlab') ? 'gitlab' : 'github';
export const GIT_DEFAULT_BRANCH = env.VITE_GIT_DEFAULT_BRANCH?.trim() || 'main';
export const GIT_ROOT = over(env.VITE_GIT_ROOT) || PROFILE.gitRoot;

export function gitBlobUrl(path: string): string {
  const rel = `${GIT_ROOT}${path}`;
  return GIT_PROVIDER === 'gitlab' ? `${GIT_WEB_BASE}/-/blob/${GIT_DEFAULT_BRANCH}/${rel}` : `${GIT_WEB_BASE}/blob/${GIT_DEFAULT_BRANCH}/${rel}`;
}
export function gitTreeUrl(path: string): string {
  const rel = `${GIT_ROOT}${path}`;
  return GIT_PROVIDER === 'gitlab' ? `${GIT_WEB_BASE}/-/tree/${GIT_DEFAULT_BRANCH}/${rel}` : `${GIT_WEB_BASE}/tree/${GIT_DEFAULT_BRANCH}/${rel}`;
}
/** "Criar arquivo" com nome pré-preenchido: só o GitLab tem; no GitHub cai na pasta. */
export function gitNewFileUrl(path: string): string {
  return GIT_PROVIDER === 'gitlab'
    ? `${GIT_WEB_BASE}/-/new/${GIT_DEFAULT_BRANCH}?file_name=${encodeURIComponent(`${GIT_ROOT}${path}`)}`
    : `${GIT_WEB_BASE}/new/${GIT_DEFAULT_BRANCH}/${GIT_ROOT}${path.split('/').slice(0, -1).join('/')}`;
}
export function gitMergeRequestsUrl(query: string): string {
  return GIT_PROVIDER === 'gitlab' ? `${GIT_WEB_BASE}/-/merge_requests?${query}` : `${GIT_WEB_BASE}/pulls?q=${encodeURIComponent(query)}`;
}
/** Hostname aceito para links de MR que o servidor devolve (assistant). */
export const GIT_HOST = new URL(GIT_WEB_BASE).hostname;

export const ARGO_CD_URL = over(env.VITE_ARGO_CD_URL) || PROFILE.argoCdUrl;
export const CLUSTER_CONSOLES: Readonly<Record<string, string>> = PROFILE.clusterConsoles;
export const PEOPLE_DIRECTORY_URL = over(env.VITE_PEOPLE_DIRECTORY_URL) || PROFILE.peopleDirectoryUrl;
export const IDENTITY_PROVIDER = PROFILE.identityProvider;
export const API_SIGNING = PROFILE.apiSigning;
export const HOSTING = PROFILE.hosting;
export const HOSTING_PURPOSE = PROFILE.hostingPurpose;
export const API_URLS = PROFILE.apiUrls;
export const API_REGIONS = PROFILE.apiRegions;
export const HARMONY_ROLE_ARN_DEFAULT = PROFILE.harmonyRoleArn;
export const ACCOUNT_CONSOLE_URL = PROFILE.accountConsoleUrl;
export const API_IDENTITY_SOURCE = PROFILE.apiIdentitySource;
export const HUB_ROUTES = PROFILE.hubRoutes;
