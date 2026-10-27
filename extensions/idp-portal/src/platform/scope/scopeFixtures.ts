// Fixtures de teste do escopo de projeto. Sem rede, sem storage.
import type { ScopeContext, ScopeProject, ScopeTeam } from './scopeModel';

export function project(partial: Partial<ScopeProject> & { id: string }): ScopeProject {
  return {
    name: partial.id, description: '', role: 'contributor',
    environment: { id: 'lab', name: 'Lab', cluster: 'appmod-agent-platform-lab', region: 'sa-east-1', promotesTo: null },
    namespaces: [`ns-${partial.id}`], appProject: partial.id, gitopsPath: 'platform/instances', argoApplications: [],
    owner: { team: 'platform-team', contact: 'platform-admin' }, quota: { maxInstances: null, enforced: false },
    lifecycle: { state: 'active' }, promotesTo: null, ...partial,
  };
}

export function team(partial: Partial<ScopeTeam> = {}): ScopeTeam {
  return { id: 'platform-team', name: 'Platform Team', description: '', contacts: ['platform-admin'],
    slack: { channel: '#platform-team', url: 'https://slack.example.com/archives/PLATFORM' }, oncall: '', ...partial };
}

export function context(projects: ScopeProject[]): ScopeContext {
  return { organization: { id: 'appmod-latam', name: 'AppMod LATAM' }, alias: 'alice', isAdmin: false,
    enforcement: 'compat', projects, teams: [team()], environments: [], kubeconfig: { offered: false, reason: 'adr-0009' } };
}
