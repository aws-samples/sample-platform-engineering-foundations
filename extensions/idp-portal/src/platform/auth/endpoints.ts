import { API_REGIONS, API_URLS } from '../deployment';
/**
 * Endpoints das APIs do portal, num lugar só.
 *
 * Antes cada client (clusterApi, platformApi, gatewayApi, agentBuilderApi, assistantApi, scopeApi,
 * kdpInventoryApi, serviceStudioApi) repetia as três URLs e a região. Para a extension do
 * aws-samples isso era o bloqueio: oito arquivos para trocar de conta. Aqui as URLs internas são o
 * DEFAULT e qualquer build pode sobrescrever por variável de ambiente do Vite (`VITE_*_API_URL`),
 * que é como o Terraform público entrega as URLs ao bundle.
 */

export type EndpointId = 'cluster' | 'platform' | 'bff';

export interface Endpoint {
  readonly id: EndpointId;
  readonly url: string;
  readonly region: string;
}

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

function endpoint(id: EndpointId, fallbackUrl: string, fallbackRegion: string, envUrl?: string, envRegion?: string): Endpoint {
  const url = (envUrl && envUrl.trim()) || fallbackUrl;
  return { id, url: url.replace(/\/+$/, ''), region: (envRegion && envRegion.trim()) || fallbackRegion };
}

// Defaults vêm do perfil de deployment (deployment.ts; os internos em deployment.internal.ts, que o Rollup
// descarta no build oss e o export da extension troca por um stub). No público, sem VITE_*_API_URL a URL
// fica vazia e o adapter falha nomeado em vez de bater no endpoint de outra conta.
export const ENDPOINTS: Readonly<Record<EndpointId, Endpoint>> = {
  cluster: endpoint('cluster', API_URLS.cluster, API_REGIONS.cluster, env.VITE_CLUSTER_API_URL, env.VITE_CLUSTER_API_REGION),
  platform: endpoint('platform', API_URLS.platform, API_REGIONS.platform, env.VITE_PLATFORM_API_URL, env.VITE_PLATFORM_API_REGION),
  bff: endpoint('bff', API_URLS.bff, API_REGIONS.bff, env.VITE_BFF_URL, env.VITE_BFF_REGION),
};

/** O endpoint cujo `url` prefixa a URL absoluta dada, ou null. Para clients que recebem URL pronta. */
export function endpointForUrl(url: string): Endpoint | null {
  return Object.values(ENDPOINTS).find(candidate => url.startsWith(candidate.url)) ?? null;
}
