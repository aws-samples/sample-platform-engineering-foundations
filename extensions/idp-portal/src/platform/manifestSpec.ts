// O `spec` do manifest do wizard, lido e escrito pelo formulário gerado do schema da capability.
//
// Ler é tolerante (manifest ilegível = sem formulário, o lint do YAML continua sendo o caminho).
// Escrever reserializa o documento: é a única forma de mudar um valor de forma segura, e por isso só
// acontece quando o usuário mexe num campo do formulário. Editar o YAML à mão continua preservando
// o texto exatamente como foi escrito, inclusive comentários.
import { parse, stringify } from 'yaml';

type Doc = { spec?: Record<string, unknown> } & Record<string, unknown>;

function document(manifest: string): Doc | null {
  try {
    const doc = parse(manifest) as unknown;
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc as Doc : null;
  } catch {
    return null;
  }
}

export function specOf(manifest: string): Record<string, unknown> | null {
  const spec = document(manifest)?.spec;
  return spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : null;
}

/** O manifest com `spec[name] = value`; `undefined` remove a chave. Manifest ilegível volta intacto. */
export function withSpecValue(manifest: string, name: string, value: unknown): string {
  const doc = document(manifest);
  if (!doc) return manifest;
  const spec = { ...(specOf(manifest) ?? {}) };
  if (value === undefined) delete spec[name]; else spec[name] = value;
  return stringify({ ...doc, spec });
}

/** Chaves do spec que o schema publicado não aceita (`additionalProperties: false`). */
export function unknownSpecKeys(spec: Record<string, unknown> | null, known: string[]): string[] {
  return spec ? Object.keys(spec).filter(key => !known.includes(key)).sort() : [];
}
