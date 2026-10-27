/**
 * docs-in-portal: o índice do que o portal renderiza. Os arquivos são os MESMOS do repo, empacotados
 * pelo Vite no build (`?raw` sob demanda, uma chunk por documento); as figuras de `docs/architecture`
 * entram como assets. Nada é copiado para `public/`: editar o `.md` em Git muda o portal no próximo
 * deploy, e o validador `scripts/validate-agent-platform-docs.py` continua sendo o gate de links e
 * imagens. Documento fora deste índice não aparece no portal, de propósito: a lista é curada.
 */
import { INTERNAL, gitBlobUrl } from '../deployment';
import { PUBLIC_DOC_PATHS } from './publicDocs';
export interface DocEntry {
  slug: string;
  /** Caminho no repo, a partir da raiz. */
  path: string;
  title: { pt: string; en: string };
  group: 'guias' | 'referencia' | 'autoria';
}

const ALL_DOCS: readonly DocEntry[] = [
  { slug: 'tour', path: 'docs/agent-platform/product-tour.md', title: { pt: 'Tour visual e guia das jornadas', en: 'Visual tour and journey guide' }, group: 'guias' },
  { slug: 'golden-paths', path: 'docs/agent-platform/golden-paths.md', title: { pt: 'Golden paths', en: 'Golden paths' }, group: 'guias' },
  { slug: 'provisioning-ux', path: 'docs/agent-platform/provisioning-ux.md', title: { pt: 'Como provisionar', en: 'How provisioning works' }, group: 'guias' },
  { slug: 'argo-access', path: 'docs/agent-platform/argo-access-onboarding.md', title: { pt: 'Acesso ao Argo CD', en: 'Argo CD access' }, group: 'guias' },
  { slug: 'catalog', path: 'platform/catalog/README.md', title: { pt: 'Catálogo de capabilities', en: 'Capability catalog' }, group: 'referencia' },
  { slug: 'personas', path: 'docs/agent-platform/personas-and-agents.md', title: { pt: 'Personas e agents', en: 'Personas and agents' }, group: 'referencia' },
  { slug: 'maturity', path: 'docs/agent-platform/maturity-model.md', title: { pt: 'Modelo de maturidade', en: 'Maturity model' }, group: 'referencia' },
  { slug: 'benchmark', path: 'docs/agent-platform/idp-benchmark.md', title: { pt: 'Benchmark de IDPs', en: 'IDP benchmark' }, group: 'referencia' },
  { slug: 'infra-authoring', path: 'docs/agent-platform/kb/infra-authoring.md', title: { pt: 'Autoria de infra (kro e ACK)', en: 'Infra authoring (kro and ACK)' }, group: 'autoria' },
  { slug: 'agent-authoring', path: 'docs/agent-platform/kb/agent-authoring.md', title: { pt: 'Autoria de agents', en: 'Agent authoring' }, group: 'autoria' },
];

// Flavor público: só os documentos de publicDocs.ts (o build oss esvazia os demais).
export const DOCS: readonly DocEntry[] = INTERNAL ? ALL_DOCS : ALL_DOCS.filter((doc) => PUBLIC_DOC_PATHS.includes(doc.path));

export const GITLAB_BLOB_BASE = gitBlobUrl('');

// Vite empacota só o que casa com os globs; os caminhos são relativos à raiz do repo (root do Vite).
const RAW = import.meta.glob(['/docs/agent-platform/*.md', '/docs/agent-platform/kb/*.md', '/platform/catalog/README.md'], { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
// Só as figuras das jornadas (agent-platform-*.png): os diagramas dos design docs não estão no índice e
// entrariam no bundle sem leitor. O teste de contrato acusa se um doc do índice apontar para fora.
const FIGURES = import.meta.glob('/docs/architecture/agent-platform-*.{png,svg,jpg,jpeg,webp}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

export function docBySlug(slug: string | null | undefined): DocEntry | null {
  return DOCS.find((doc) => doc.slug === slug) ?? null;
}

export function docByPath(path: string): DocEntry | null {
  return DOCS.find((doc) => doc.path === path) ?? null;
}

/** Normaliza `../architecture/x.png` relativo ao documento para `/docs/architecture/x.png`. */
export function resolveRepoPath(fromDocPath: string, relative: string): string {
  const base = fromDocPath.split('/').slice(0, -1);
  for (const part of relative.replace(/^\.\//, '').split('/')) {
    if (part === '..') base.pop();
    else if (part && part !== '.') base.push(part);
  }
  return base.join('/');
}

export async function loadDoc(doc: DocEntry): Promise<string> {
  const loader = RAW[`/${doc.path}`];
  if (!loader) throw new Error(`documento não empacotado: ${doc.path}`);
  return loader();
}

export function figureUrl(fromDocPath: string, relative: string): string | null {
  return FIGURES[`/${resolveRepoPath(fromDocPath, relative)}`] ?? null;
}

/** Visível para o teste de contrato: todo doc do índice tem que estar no glob. */
export function bundledDocPaths(): string[] {
  return Object.keys(RAW).map((key) => key.replace(/^\//, ''));
}
