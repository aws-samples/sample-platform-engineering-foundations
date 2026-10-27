/*
 * Peças de scorecard (backlog scorecards-standards), compartilhadas por inventário, detalhe, página
 * Scorecards e widget da Home. Nível é SEMPRE texto + ícone (StatusIndicator), nunca só cor: o leitor
 * daltônico distingue Ouro de Bronze pelo glifo e pela palavra. Nada aqui calcula regra: o servidor
 * avalia e manda `passed` e `evidence`; esta camada só apresenta.
 */
import Box from '@cloudscape-design/components/box';
import StatusIndicator, { StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import type { Scorecard, ScorecardLevel, ScorecardRuleResult, ScorecardSummary, StandardRule } from './kdpInventoryApi';

export interface LevelIndicator { type: StatusIndicatorProps.Type; text: string }

const LEVEL_TEXT: Record<ScorecardLevel, { pt: string; en: string; type: StatusIndicatorProps.Type }> = {
  none: { pt: 'Sem nível', en: 'No level', type: 'error' },
  bronze: { pt: 'Bronze', en: 'Bronze', type: 'warning' },
  silver: { pt: 'Prata', en: 'Silver', type: 'info' },
  gold: { pt: 'Ouro', en: 'Gold', type: 'success' },
};

export function levelLabel(level: ScorecardLevel, pt: boolean): string {
  return LEVEL_TEXT[level][pt ? 'pt' : 'en'];
}

/** `Ouro · 7/7`: nível por glifo e palavra, contagem ao lado. */
export function levelIndicator(card: ScorecardSummary | null, pt: boolean): LevelIndicator {
  if (!card) return { type: 'pending', text: pt ? 'Não avaliado' : 'Not evaluated' };
  return { type: LEVEL_TEXT[card.level].type, text: `${levelLabel(card.level, pt)} · ${card.passed}/${card.total}` };
}

export function ScorecardLevelCell({ card, pt }: { card: ScorecardSummary | null; pt: boolean }): JSX.Element {
  const indicator = levelIndicator(card, pt);
  return <StatusIndicator type={indicator.type}>{indicator.text}</StatusIndicator>;
}

/** Regra que falhou primeiro, depois por nível (bronze antes de ouro), depois por id: o que corrigir primeiro no topo. */
export function orderRules(rules: readonly ScorecardRuleResult[]): ScorecardRuleResult[] {
  const rank: Record<ScorecardRuleResult['level'], number> = { bronze: 0, silver: 1, gold: 2 };
  return [...rules].sort((a, b) => Number(a.passed) - Number(b.passed) || rank[a.level] - rank[b.level] || a.id.localeCompare(b.id));
}

export function ScorecardRulesTable({ card, standards, pt }: { card: Scorecard; standards?: readonly StandardRule[]; pt: boolean }): JSX.Element {
  const byId = new Map((standards ?? []).map(rule => [rule.id, rule] as const));
  const title = (rule: ScorecardRuleResult) => {
    const standard = byId.get(rule.id);
    const text = standard ? (pt ? standard.titlePt : standard.title) : (pt ? rule.titlePt : rule.title);
    return text || rule.id;
  };
  return (
    <Table<ScorecardRuleResult>
      variant="borderless"
      items={orderRules(card.rules)}
      trackBy="id"
      ariaLabels={{ tableLabel: pt ? 'Regras do scorecard' : 'Scorecard rules' }}
      columnDefinitions={[
        { id: 'rule', header: pt ? 'Regra' : 'Rule', cell: rule => <Box variant="strong">{title(rule)}</Box> },
        { id: 'level', header: pt ? 'Nível' : 'Level', cell: rule => levelLabel(rule.level, pt) },
        {
          id: 'result', header: pt ? 'Resultado' : 'Result',
          cell: rule => <StatusIndicator type={rule.passed ? 'success' : 'error'}>{rule.passed ? (pt ? 'Passou' : 'Passed') : (pt ? 'Falhou' : 'Failed')}</StatusIndicator>,
        },
        { id: 'evidence', header: pt ? 'Evidência' : 'Evidence', cell: rule => <Box variant="code">{rule.evidence}</Box> },
      ]}
      empty={<Box textAlign="center">{pt ? 'Nenhuma regra se aplica a este tipo de recurso.' : 'No rule applies to this kind of resource.'}</Box>}
    />
  );
}

/** Aviso único quando o Argo não foi lido: a regra de GitOps conta como falha "não verificável". */
export function argoUnreadableNote(pt: boolean): string {
  return pt
    ? 'O Argo CD não pôde ser lido agora: "Gerido por GitOps" aparece como não verificável e conta como não atingido.'
    : 'Argo CD could not be read now: "Managed by GitOps" shows as not verifiable and counts as not attained.';
}
