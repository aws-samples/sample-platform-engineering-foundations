// schema.json de cada capability do catálogo, pela capability.yaml do MESMO diretório. É o que o
// wizard de provisionamento renderiza com o renderer do Service Owner Studio (schemaForm.ts), então o
// formulário que o Service Owner pré-visualiza é o que o consumidor vê depois do merge (issue #11).
import { parse } from 'yaml';
import type { CapabilitySchema } from './serviceStudio/schemaForm';

const capabilityFiles = import.meta.glob('../../platform/catalog/**/capability.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const schemaFiles = import.meta.glob('../../platform/catalog/**/schema.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const byCapability = new Map<string, CapabilitySchema>();
for (const [path, raw] of Object.entries(capabilityFiles)) {
  const schema = schemaFiles[path.replace(/capability\.yaml$/, 'schema.json')];
  if (!schema) continue;
  try {
    const id = String((parse(raw) as { metadata?: { name?: unknown } })?.metadata?.name ?? '');
    if (id) byCapability.set(id, JSON.parse(schema) as CapabilitySchema);
  } catch {
    // Arquivo ilegível: a capability fica sem formulário e o wizard segue no YAML, como antes.
  }
}

/** O schema publicado da capability, ou `undefined` quando ela não tem um (o wizard usa só o YAML). */
export function schemaFor(capabilityId: string | undefined): CapabilitySchema | undefined {
  return capabilityId ? byCapability.get(capabilityId) : undefined;
}

export function capabilitiesWithSchema(): string[] {
  return [...byCapability.keys()].sort();
}
