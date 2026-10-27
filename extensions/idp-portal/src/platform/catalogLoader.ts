// Catalog loader: the portal catalog is driven by platform/catalog/**/capability.yaml.
// Files are bundled at build time; adding a capability via MR changes the portal with zero code.
import { parse } from 'yaml';

export interface Capability {
  id: string;
  domain: string;
  name: string;
  version: string;
  displayName: string;
  displayNamePt: string;
  description: string;
  descriptionPt: string;
  pattern: string;
  engine: string;
  lifecycle: 'available' | 'preview' | 'planned' | 'deprecated';
  goldenPath: string;
  rgdRef?: string;
  /**
   * Identidade da capability no CLUSTER, que é o `metadata.name` do RGD apontado pelo `rgdRef`.
   *
   * Ela existe porque o id do catálogo NÃO é essa identidade: `scheduled` compõe o RGD
   * `scheduled-agent`, `lambda` compõe `lambda-function`, `dynamodb` compõe `dynamodb-table` e
   * `http-api` compõe `web-api`. A cluster-api lista por nome de RGD (ver `_kro_capabilities` no
   * backend), então usar o id do catálogo na rota do serviço consultava uma capability que não
   * existe e a tela abria vazia. Sem RGD a identidade é o próprio id: a capability é planejada e
   * não tem objeto live para divergir.
   */
  liveCapability: string;
  exampleYaml?: string;
}

interface CapabilityFile {
  metadata: { name: string; domain: string; version: string };
  spec: {
    displayName: string; displayNamePt?: string;
    description: string; descriptionPt?: string;
    pattern: string; engine: string; lifecycle: Capability['lifecycle'];
    goldenPath?: string; rgdRef?: string;
  };
}

const files = import.meta.glob('../../platform/catalog/**/capability.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const exampleFiles = import.meta.glob('../../platform/catalog/**/examples/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// As compositions entram no bundle só como texto, para que a identidade live venha do RGD de
// verdade e não de uma convenção de nome de arquivo (que já divergiu: `web-api-rgd.yaml` compõe
// `web-api`, mas `scheduled-agent-rgd.yaml` é apontado por uma capability chamada `scheduled`).
const compositionFiles = import.meta.glob('../../platform/compositions/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface RgdFile {
  kind?: string;
  metadata?: { name?: string };
}

const rgdNameByRef = new Map<string, string>();
for (const [path, raw] of Object.entries(compositionFiles)) {
  let doc: RgdFile;
  try {
    doc = parse(raw) as RgdFile;
  } catch {
    continue; // Um YAML ilegível não derruba o catálogo; a capability cai no fallback.
  }
  if (doc?.kind !== 'ResourceGraphDefinition') continue;
  const name = String(doc.metadata?.name ?? '');
  if (name) rgdNameByRef.set(`platform/compositions/${path.split('/').pop()}`, name);
}

/**
 * Identidade live de uma capability. O `rgdRef` do catálogo é um caminho relativo à raiz do repo,
 * então a chave do mapa é normalizada para `platform/compositions/<arquivo>` antes de casar.
 * Sem rgdRef, ou com rgdRef que não resolve, o fallback é o id - nunca um palpite.
 */
export function liveCapabilityOf(id: string, rgdRef?: string): string {
  if (!rgdRef) return id;
  const file = String(rgdRef).split('/').pop() ?? '';
  return rgdNameByRef.get(`platform/compositions/${file}`) ?? id;
}

function exampleFor(capabilityPath: string): string | undefined {
  const dir = capabilityPath.replace(/capability\.yaml$/, '');
  const match = Object.keys(exampleFiles).find(key => key.startsWith(dir));
  return match ? exampleFiles[match] : undefined;
}

export const capabilities: Capability[] = Object.entries(files)
  .map(([path, raw]) => ({ path, file: parse(raw) as CapabilityFile }))
  .map(({ path, file }) => ({
    id: file.metadata.name,
    domain: file.metadata.domain,
    name: file.metadata.name,
    version: file.metadata.version,
    displayName: file.spec.displayName,
    displayNamePt: file.spec.displayNamePt ?? file.spec.displayName,
    description: file.spec.description,
    descriptionPt: file.spec.descriptionPt ?? file.spec.description,
    pattern: file.spec.pattern,
    engine: file.spec.engine,
    lifecycle: file.spec.lifecycle,
    goldenPath: file.spec.goldenPath ?? '',
    rgdRef: file.spec.rgdRef,
    liveCapability: liveCapabilityOf(file.metadata.name, file.spec.rgdRef),
    exampleYaml: exampleFor(path),
  }))
  .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));

export const agentCapabilities = capabilities.filter(c => c.domain === 'agent');
export const infrastructureCapabilities = capabilities.filter(c => c.domain !== 'agent');
