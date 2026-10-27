/**
 * environments-promotion: a cópia de uma instância kro para o ambiente seguinte, como manifest.
 *
 * Função pura sobre o detalhe que a cluster-api devolve (spec já sanitizado no servidor) e o alvo
 * resolvido do registry (`promotionTargetFor`). Não lê Git nem cluster: o que entra em Git é o
 * pedido de infra que o servidor valida (namespace do alvo, cadeia `promotesTo`) e o CI escreve.
 *
 * Regras de cópia:
 *  - `apiVersion` e `kind` iguais; `metadata.name` ganha o sufixo do ambiente quando origem e alvo
 *    aplicam o MESMO diretório GitOps (um cluster, um `platform/instances`: dois arquivos com o mesmo
 *    nome não cabem). Com diretórios distintos o nome se mantém.
 *  - labels `platform.appmod/*` da origem seguem (o owner é obrigatório pelo gate de Git), menos
 *    `promoted-from`, que é reescrita; labels `kro.run/*`, `app.kubernetes.io/instance` e as
 *    annotations de rastreio do Argo CD e do kubectl ficam de fora: são do objeto vivo, não do desejo.
 *  - `platform.appmod/environment` e `platform.appmod/promoted-from` (label com o NOME da origem,
 *    annotation com `project/ns/name`) marcam a cópia.
 *  - `spec` vai inteiro como veio do servidor, sem `lifecycle: ephemeral` (um tour promovido deixa de
 *    ser efêmero? Não: efêmero não se promove, e o botão nem aparece).
 */
import { stringify } from 'yaml';
import type { InstanceDetail } from './kdpInventoryApi';
import type { PromotionTarget } from './scope/activeScope';

export const ENVIRONMENT_LABEL = 'platform.appmod/environment';
export const PROMOTED_FROM_KEY = 'platform.appmod/promoted-from';
const DNS_LABEL_MAX = 63;
const DROPPED_LABEL_PREFIXES = ['kro.run/', 'app.kubernetes.io/instance', 'argocd.argoproj.io/'];
const KEPT_LABEL_PREFIX = 'platform.appmod/';

export interface PromotionPlan {
  name: string;
  namespace: string;
  project: string;
  environment: string;
  /** `project/namespace/name` da origem, o mesmo que vai em `promotedFrom` do pedido. */
  promotedFrom: string;
  manifest: string;
  /** Strings do spec que embutiam o nome da instância e ganharam o sufixo do ambiente (identidade
   *  global, como nome de bucket ou tabela). Vazio quando origem e alvo têm diretórios distintos. */
  rewrites: SpecRewrite[];
}

export interface SpecRewrite { path: string; from: string; to: string }

/** Reescreve, em todo valor string do spec, o token `name` (palavra inteira, delimitado por `-`, `.`, `_`
 *  ou bordas) por `promoted`. Retorna o spec novo e a lista do que mudou, com caminho pontilhado. */
export function rewriteIdentity(spec: unknown, name: string, promoted: string, path = 'spec'): { value: unknown; rewrites: SpecRewrite[] } {
  if (typeof spec === 'string') {
    const pattern = new RegExp(`(^|[-._/])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[-._/])`, 'g');
    const next = spec.replace(pattern, `$1${promoted}`);
    return next === spec ? { value: spec, rewrites: [] } : { value: next, rewrites: [{ path, from: spec, to: next }] };
  }
  if (Array.isArray(spec)) {
    const rewrites: SpecRewrite[] = [];
    const value = spec.map((item, index) => { const r = rewriteIdentity(item, name, promoted, `${path}[${index}]`); rewrites.push(...r.rewrites); return r.value; });
    return { value, rewrites };
  }
  if (typeof spec === 'object' && spec !== null) {
    const rewrites: SpecRewrite[] = [];
    const value: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(spec as Record<string, unknown>)) {
      const r = rewriteIdentity(item, name, promoted, `${path}.${key}`);
      rewrites.push(...r.rewrites);
      value[key] = r.value;
    }
    return { value, rewrites };
  }
  return { value: spec, rewrites: [] };
}

export function promotedNameFor(name: string, environmentId: string, sameDirectory: boolean): string {
  if (!sameDirectory) return name;
  const suffix = `-${environmentId}`;
  if (name.endsWith(suffix)) return name;
  return `${name.slice(0, Math.max(1, DNS_LABEL_MAX - suffix.length))}${suffix}`.replace(/-+$/, '').replace(/-{2,}/g, '-');
}

export function isPromotable(detail: Pick<InstanceDetail, 'engine' | 'spec' | 'metadata'>): boolean {
  if (detail.engine !== 'kro' || !detail.spec || detail.metadata.deleting) return false;
  return (detail.spec as Record<string, unknown>).lifecycle !== 'ephemeral';
}

export function buildPromotionPlan(detail: InstanceDetail, target: PromotionTarget): PromotionPlan {
  const sourceLabels = detail.metadata.labels ?? {};
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceLabels)) {
    if (!key.startsWith(KEPT_LABEL_PREFIX) || key === PROMOTED_FROM_KEY || key === ENVIRONMENT_LABEL) continue;
    if (DROPPED_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    labels[key] = value;
  }
  const environment = target.project.environment.id;
  labels[ENVIRONMENT_LABEL] = environment;
  labels[PROMOTED_FROM_KEY] = detail.metadata.name;
  const promotedFrom = `${target.source.id}/${detail.metadata.namespace}/${detail.metadata.name}`;
  const sameDirectory = target.project.gitopsPath === target.source.gitopsPath;
  const name = promotedNameFor(detail.metadata.name, environment, sameDirectory);
  // Mesmo diretório = mesma conta e região: identidade global embutida no spec (bucket, tabela) tem que
  // mudar junto com o nome, senão a cópia pede o recurso que a origem já ocupa.
  const identity = sameDirectory ? rewriteIdentity(detail.spec ?? {}, detail.metadata.name, name) : { value: detail.spec ?? {}, rewrites: [] };
  // `spec.environment` é o campo das composições do lab para o ambiente lógico: a cópia leva o ambiente
  // ALVO, senão o scorecard e a própria composição veriam "lab" dentro de staging.
  const spec = identity.value as Record<string, unknown>;
  if (typeof spec.environment === 'string' && spec.environment !== environment) {
    identity.rewrites.push({ path: 'spec.environment', from: spec.environment, to: environment });
    spec.environment = environment;
  }
  const document = {
    apiVersion: detail.apiVersion,
    kind: detail.kind,
    metadata: {
      name,
      namespace: target.namespace,
      labels,
      annotations: { [PROMOTED_FROM_KEY]: promotedFrom },
    },
    spec: identity.value,
  };
  return {
    name, namespace: target.namespace, project: target.project.id, environment, promotedFrom,
    manifest: stringify(document, { lineWidth: 0 }), rewrites: identity.rewrites,
  };
}
