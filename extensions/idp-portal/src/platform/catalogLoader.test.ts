import { describe, expect, it } from 'vitest';
import { agentCapabilities, capabilities, infrastructureCapabilities } from './catalogLoader';

describe('file-driven catalog', () => {
  it('loads capabilities from platform/catalog files, not hardcode', () => {
    expect(capabilities.length).toBeGreaterThanOrEqual(9);
    const ids = capabilities.map(c => `${c.domain}/${c.name}`);
    expect(ids).toContain('agent/scheduled');
    expect(ids).toContain('compute/lambda');
  });

  it('exposes the live scheduled agent as available with its RGD reference', () => {
    const scheduled = capabilities.find(c => c.domain === 'agent' && c.name === 'scheduled');
    expect(scheduled?.lifecycle).toBe('available');
    expect(scheduled?.rgdRef).toBe('platform/compositions/scheduled-agent-rgd.yaml');
    expect(scheduled?.goldenPath).toBe('GP-G1');
  });

  it('splits agent and infrastructure domains and carries pt-BR strings', () => {
    expect(agentCapabilities.every(c => c.domain === 'agent')).toBe(true);
    expect(infrastructureCapabilities.some(c => c.name === 'lambda')).toBe(true);
    const lambda = capabilities.find(c => c.name === 'lambda');
    expect(lambda?.displayNamePt).toBe('Função Lambda');
    expect(lambda?.lifecycle).toBe('preview');
  });
});
