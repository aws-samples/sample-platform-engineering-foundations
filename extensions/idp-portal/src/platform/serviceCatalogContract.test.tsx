/*
 * Contract tests for the Service Catalog (issue #7, criterion "a contract test prevents a stale
 * count between the catalog and the UI").
 *
 * The point of this file is to read the catalog files INDEPENDENTLY of catalogLoader. If the UI and
 * the loader ever disagree with what is on disk -- a capability added by MR that the UI filters
 * out, a facet that stops counting a category, a header counter computed off a different list --
 * the count here stops matching and the test fails. Asserting the loader against itself could not
 * catch that.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from 'yaml';
import { capabilities } from './catalogLoader';
import { ServiceTable } from './ServiceCatalogParts';
import { Facet, applyCatalogQuery, buildServiceCatalog, deriveFacets, normalizeCapabilityKey, unmatchedCapabilityKeys } from './serviceCatalog';

// Cloudscape uses useLayoutEffect; React warns about it under server rendering. Only that warning
// is filtered, so a real console error still surfaces.
const originalError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('useLayoutEffect does nothing on the server')) return;
    originalError(...args);
  });
});
afterAll(() => vi.restoreAllMocks());

// Same glob the loader uses, resolved here on its own so the two are independent readers of disk.
const capabilityFiles = import.meta.glob('../../platform/catalog/**/capability.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const compositionFiles = import.meta.glob('../../platform/compositions/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface CapabilityFile {
  metadata: { name: string; domain: string; version: string };
  spec: { lifecycle: string; engine: string };
}

const onDisk = Object.entries(capabilityFiles).map(([path, raw]) => ({ path, file: parse(raw) as CapabilityFile }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

describe('catalog files are the single source of the catalog', () => {
  it('finds capability files on disk at all, so a broken glob cannot pass this suite silently', () => {
    expect(onDisk.length).toBeGreaterThan(0);
    for (const { path, file } of onDisk) {
      expect(file.metadata?.name, `${path} has no metadata.name`).toBeTruthy();
      expect(file.metadata?.domain, `${path} has no metadata.domain`).toBeTruthy();
    }
  });

  it('exposes exactly one capability per file, with no extra and none dropped', () => {
    expect(capabilities).toHaveLength(onDisk.length);
    expect(capabilities.map(entry => entry.id).sort()).toEqual(onDisk.map(({ file }) => file.metadata.name).sort());
  });

  it('keeps capability ids unique, because the live instance join matches on the id', () => {
    const ids = capabilities.map(entry => entry.id);
    expect(new Set(ids).size, `duplicate capability id: ${ids.filter((id, index) => ids.indexOf(id) !== index).join(', ')}`).toBe(ids.length);
  });

  it('carries the domain and lifecycle declared in the file, not a value invented in code', () => {
    for (const { file } of onDisk) {
      const loaded = capabilities.find(entry => entry.id === file.metadata.name);
      expect(loaded?.domain).toBe(file.metadata.domain);
      expect(loaded?.lifecycle).toBe(file.spec.lifecycle);
      expect(loaded?.engine).toBe(file.spec.engine);
    }
  });
});

describe('no stale count between the catalog and the UI', () => {
  const entries = buildServiceCatalog(capabilities, { counts: {} });

  it('builds one service entry per capability file', () => {
    expect(entries).toHaveLength(onDisk.length);
    expect(entries.map(entry => entry.id).sort()).toEqual(onDisk.map(({ file }) => file.metadata.name).sort());
  });

  it('shows the whole catalog when nothing is searched or filtered', () => {
    // This is the number the page header reports as visible/total; it must be the file count.
    expect(applyCatalogQuery(entries)).toHaveLength(onDisk.length);
  });

  it('counts every entry exactly once in each facet dimension', () => {
    const facets = deriveFacets(entries);
    const dimensions: [string, Facet[]][] = [
      ['categories', facets.categories],
      ['states', facets.states],
      ['engines', facets.engines],
    ];
    for (const [dimension, values] of dimensions) {
      const total = values.reduce((sum, facet) => sum + facet.count, 0);
      expect(total, `facet ${dimension} counted ${total} of ${entries.length} entries`).toBe(entries.length);
    }
  });

  it('lists every category present on disk as a facet, and no category that is not', () => {
    const onDiskCategories = [...new Set(onDisk.map(({ file }) => file.metadata.domain))].sort();
    expect(deriveFacets(entries).categories.map(facet => facet.value).sort()).toEqual(onDiskCategories);
  });

  it('renders one row per visible entry, so the table cannot disagree with the count', () => {
    const visible = applyCatalogQuery(entries, { query: 'agent' });
    const html = renderToStaticMarkup(
      <ServiceTable
        entries={visible}
        pt={false}
        empty={<span>none</span>}
        sortField="name"
        descending={false}
        onOpen={() => undefined}
        onCreate={() => undefined}
        onSort={() => undefined}
      />,
    );
    expect(visible.length).toBeGreaterThan(0);
    for (const entry of visible) expect(text(html)).toContain(entry.displayName);
    // And an entry filtered out is genuinely absent from the DOM, not merely hidden.
    const excluded = entries.filter(entry => !visible.includes(entry));
    for (const entry of excluded) expect(text(html)).not.toContain(entry.displayName);
  });

  it('grows on its own when a capability is added, proving the UI list is not hardcoded', () => {
    const added = buildServiceCatalog([
      ...capabilities,
      { ...capabilities[0], id: 'contract-probe', name: 'contract-probe', domain: 'probe', displayName: 'Contract probe', displayNamePt: 'Contract probe' },
    ]);
    expect(added).toHaveLength(onDisk.length + 1);
    expect(applyCatalogQuery(added, { query: 'contract-probe' }).map(entry => entry.id)).toEqual(['contract-probe']);
    expect(deriveFacets(added).categories.map(facet => facet.value)).toContain('probe');
  });
});

describe('live instance tags resolve to real catalog entries', () => {
  // Both YAML shapes the compositions use: `platform:capability: x` and `- key: platform:capability\n value: x`.
  const inlineTag = /platform:capability:\s*["']?([A-Za-z0-9._/-]+)["']?/g;
  const keyValueTag = /-\s*key:\s*platform:capability\s*\n\s*value:\s*["']?([A-Za-z0-9._/-]+)["']?/g;

  const tagged = [...new Set(
    Object.values(compositionFiles).flatMap(raw => [
      ...[...raw.matchAll(inlineTag)].map(match => match[1]),
      ...[...raw.matchAll(keyValueTag)].map(match => match[1]),
    ]),
  )].sort();

  it('finds platform:capability tags in the compositions at all', () => {
    expect(tagged.length).toBeGreaterThan(0);
  });

  it('matches every tag a composition writes to a capability in the catalog', () => {
    const ids = new Set(capabilities.map(entry => normalizeCapabilityKey(entry.id)));
    const orphans = tagged.filter(tag => !ids.has(normalizeCapabilityKey(tag)));
    // An orphan tag means instances would exist that the catalog cannot show as added: the exact
    // stale count this issue removes.
    expect(orphans, `composition tags with no capability file: ${orphans.join(', ')}`).toEqual([]);
  });

  it('derives the added state for every capability the cluster counts', () => {
    // A contagem live chega pela identidade LIVE de cada capability (o metadata.name do RGD), que
    // é o que a cluster-api devolve. Montar o mapa a partir do catálogo prova o join nos dois
    // sentidos: toda capability do catálogo tem de ser alcançável por essa chave.
    const counts = Object.fromEntries(capabilities.map(capability => [capability.liveCapability, 1]));
    const entries = buildServiceCatalog(capabilities, { counts });
    expect(entries.filter(entry => entry.state === 'added')).toHaveLength(onDisk.length);
    // Totals are unchanged by the join: counting instances must not add or lose catalog entries.
    expect(entries).toHaveLength(onDisk.length);
    expect(unmatchedCapabilityKeys(capabilities, { counts })).toEqual([]);
  });

  it('a identidade live de cada capability com RGD é o metadata.name do RGD, lido aqui do disco', () => {
    const rgdNames = new Map<string, string>();
    for (const [path, raw] of Object.entries(compositionFiles)) {
      const doc = parse(raw) as { kind?: string; metadata?: { name?: string } };
      if (doc?.kind === 'ResourceGraphDefinition' && doc.metadata?.name) {
        rgdNames.set(`platform/compositions/${path.split('/').pop()}`, doc.metadata.name);
      }
    }
    expect(rgdNames.size).toBeGreaterThan(0);
    const withRgd = capabilities.filter(capability => capability.rgdRef);
    expect(withRgd.length).toBeGreaterThan(0);
    for (const capability of withRgd) {
      expect(capability.liveCapability, `${capability.id} -> ${capability.rgdRef}`).toBe(rgdNames.get(String(capability.rgdRef)));
    }
  });
});
