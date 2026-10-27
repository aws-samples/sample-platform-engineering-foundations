/*
 * Ownership (backlog ownership-model): quem é o dono e como falar com ele, em todo detalhe.
 *
 * Um owner é texto no objeto (`platform.appmod/owner` ou `spec.owner`). Aqui ele vira UMA de três
 * coisas, sem adivinhar: o id de um time declarado no registry (link para a página Times e para o
 * canal do Slack), um alias (link para o PhoneTool), ou "sem owner". O owner do PROJETO vem do
 * registry e aparece ao lado, nunca no lugar do owner do objeto.
 */
import Box from '@cloudscape-design/components/box';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { ScopeTeam } from './scope/scopeModel';
import { PEOPLE_DIRECTORY_URL } from './deployment';

export const PHONETOOL = PEOPLE_DIRECTORY_URL;
const ALIAS = /^[a-z][a-z0-9._-]{0,63}$/;

export type OwnerRef =
  | { kind: 'team'; team: ScopeTeam }
  | { kind: 'alias'; alias: string }
  | { kind: 'text'; text: string }
  | { kind: 'none' };

/** Resolve o texto do owner contra os times do registry. Alias só quando tem forma de alias. */
export function resolveOwner(owner: string, teams: readonly ScopeTeam[]): OwnerRef {
  const value = owner.trim();
  if (!value) return { kind: 'none' };
  const team = teams.find(candidate => candidate.id === value);
  if (team) return { kind: 'team', team };
  if (ALIAS.test(value)) return { kind: 'alias', alias: value };
  return { kind: 'text', text: value };
}

export function OwnerLink({ owner, teams, pt, onOpenTeams }: { owner: string; teams: readonly ScopeTeam[]; pt: boolean; onOpenTeams?: () => void }): JSX.Element {
  const ref = resolveOwner(owner, teams);
  if (ref.kind === 'none') return <Box color="text-status-inactive">{pt ? 'sem owner declarado' : 'no owner declared'}</Box>;
  if (ref.kind === 'text') return <span>{ref.text}</span>;
  if (ref.kind === 'alias') {
    if (!PHONETOOL) return <span>{ref.alias}</span>; // deployment sem diretório de pessoas: alias como texto
    return <Link href={`${PHONETOOL}${ref.alias}`} external externalIconAriaLabel={pt ? 'Abre em nova aba' : 'Opens in a new tab'}>{ref.alias}</Link>;
  }
  return (
    <SpaceBetween direction="horizontal" size="xs">
      <Link href="#teams" onFollow={event => { if (onOpenTeams) { event.preventDefault(); onOpenTeams(); } }}>{ref.team.name}</Link>
      {ref.team.slack.url && <Link href={ref.team.slack.url} external externalIconAriaLabel={pt ? 'Abre em nova aba' : 'Opens in a new tab'}>{ref.team.slack.channel || 'Slack'}</Link>}
    </SpaceBetween>
  );
}
