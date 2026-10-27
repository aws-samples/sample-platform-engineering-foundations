/*
 * Página Scorecards (backlog scorecards-standards): toda instância do escopo pontuada contra os
 * padrões em Git, com o agregado por nível e por regra. O que todo IDP comercial (Port, Cortex,
 * OpsLevel) e o Tech Insights do Backstage têm e aqui faltava.
 *
 * Nada é calculado no cliente: GET /cluster/scorecards devolve nível, regras avaliadas e evidência
 * por instância, mais as próprias regras (texto bilíngue) para a página nunca inventar uma. Fonte
 * que falhou aparece nomeada; Argo ilegível aparece como aviso e a regra de GitOps conta como não
 * atingida (fail-closed, igual ao servidor).
 *
 * Leitura: pior nível primeiro, porque a página existe para dizer o que corrigir.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { errorMessage } from './errors';
import { useI18n } from './i18n';
import { ALL_NAMESPACES, InventoryError, ScorecardItem, ScorecardLevel, ScorecardsResponse, StandardRule, listScorecards } from './kdpInventoryApi';
import { detailPath } from './kdpInventoryModel';
import { LoadFailure, SourceWarning } from './KdpInventoryParts';
import { OwnerLink } from './ownership';
import { getActiveScope } from './scope/activeScope';
import { ScorecardLevelCell, ScorecardRulesTable, argoUnreadableNote, levelLabel } from './scorecardParts';

export interface ScorecardsPageProps {
  onOpenDetail(path: string): void;
}

type Load =
  | { status: 'loading' }
  | { status: 'ready'; data: ScorecardsResponse }
  | { status: 'error'; message: string; httpStatus?: number; sources?: ScorecardsResponse['sources'] };

const REFRESH_MS = 60_000;

/** Linhas do painel "por regra": taxa de aprovação sobre as instâncias a que a regra se aplica. */
export function ruleRows(data: Pick<ScorecardsResponse, 'standards' | 'rules'>): (StandardRule & { applicable: number; passed: number; percent: number | null })[] {
  const counts = new Map(data.rules.map(row => [row.id, row] as const));
  return data.standards.rules.map(rule => {
    const count = counts.get(rule.id) ?? { applicable: 0, passed: 0 };
    return { ...rule, ...count, percent: count.applicable ? Math.round((count.passed / count.applicable) * 100) : null };
  });
}

function LevelKpi({ level, value, pt }: { level: ScorecardLevel; value: number; pt: boolean }): JSX.Element {
  return (
    <div>
      <Box variant="awsui-key-label">{levelLabel(level, pt)}</Box>
      <ScorecardLevelCell card={{ level, passed: value, total: value }} pt={pt} />
      <Box variant="small" color="text-body-secondary">{pt ? `${value} ${value === 1 ? 'recurso' : 'recursos'}` : `${value} ${value === 1 ? 'resource' : 'resources'}`}</Box>
    </div>
  );
}

export function ScorecardsPage({ onOpenDetail }: ScorecardsPageProps): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [selected, setSelected] = useState<ScorecardItem | null>(null);
  const [nonce, setNonce] = useState(0);
  const gate = useRef(new AbortController());

  useEffect(() => {
    gate.current.abort();
    const controller = new AbortController();
    gate.current = controller;
    let active = true;
    const read = async () => {
      try {
        const data = await listScorecards(ALL_NAMESPACES, controller.signal);
        if (!active) return;
        setLoad({ status: 'ready', data });
        setSelected(current => (current ? data.items.find(item => item.namespace === current.namespace && item.name === current.name) ?? null : null));
      } catch (cause) {
        if (!active || (cause instanceof InventoryError && cause.aborted)) return;
        setLoad({ status: 'error', message: errorMessage(cause, 'cluster-api unavailable'),
          httpStatus: cause instanceof InventoryError ? cause.status : undefined,
          sources: cause instanceof InventoryError ? cause.sources : undefined });
      }
    };
    void read();
    const interval = window.setInterval(() => void read(), REFRESH_MS);
    return () => { active = false; controller.abort(); window.clearInterval(interval); };
  }, [nonce]);

  const retry = useCallback(() => { setLoad({ status: 'loading' }); setNonce(value => value + 1); }, []);
  const rules = useMemo(() => (load.status === 'ready' ? ruleRows(load.data) : []), [load]);
  const teams = getActiveScope().teams ?? [];

  const header = (
    <Header
      variant="h1"
      counter={load.status === 'ready' ? `(${load.data.summary.total})` : undefined}
      description={pt
        ? 'Todo recurso do escopo pontuado contra os padrões da plataforma. Níveis cumulativos: Ouro exige Prata e Bronze inteiros. As regras vivem em Git (platform/scorecards/standards.json) e são avaliadas no servidor a partir do objeto vivo; o portal não inventa regra.'
        : 'Every resource in scope scored against the platform standards. Levels are cumulative: Gold requires all of Silver and Bronze. Rules live in Git (platform/scorecards/standards.json) and are evaluated server-side from the live object; the portal never invents a rule.'}
      actions={<Button iconName="refresh" onClick={retry}>{pt ? 'Ler de novo' : 'Read again'}</Button>}
    >
      Scorecards
    </Header>
  );

  if (load.status === 'loading') {
    return <ContentLayout header={header}><StatusIndicator type="loading">{pt ? 'Avaliando os recursos do escopo' : 'Evaluating the resources in scope'}</StatusIndicator></ContentLayout>;
  }
  if (load.status === 'error') {
    return (
      <ContentLayout header={header}>
        <LoadFailure message={load.message} status={load.httpStatus} sources={load.sources} pt={pt} onRetry={retry} />
      </ContentLayout>
    );
  }

  const { data } = load;
  const levels: ScorecardLevel[] = ['gold', 'silver', 'bronze', 'none'];
  return (
    <ContentLayout header={header}>
      <SpaceBetween size="l">
        <SourceWarning partial={data.partial} sources={data.sources} truncatedSources={data.truncatedSources} pt={pt} />
        {!data.argoReadable && <Alert type="warning">{argoUnreadableNote(pt)}</Alert>}

        <Container header={<Header variant="h2" description={pt ? 'Quantos recursos atingem cada nível agora.' : 'How many resources attain each level now.'}>{pt ? 'Por nível' : 'By level'}</Header>}>
          <ColumnLayout columns={4} variant="text-grid" minColumnWidth={150}>
            {levels.map(level => <LevelKpi key={level} level={level} value={data.summary.byLevel[level]} pt={pt} />)}
          </ColumnLayout>
        </Container>

        <Container header={<Header variant="h2" description={pt ? 'Taxa de aprovação de cada regra sobre os recursos a que ela se aplica. A regra com menor taxa é onde a plataforma mais perde nível.' : 'Pass rate of each rule over the resources it applies to. The lowest rate is where the platform loses the most levels.'}>{pt ? 'Por regra' : 'By rule'}</Header>}>
          <Table
            variant="borderless"
            items={rules}
            trackBy="id"
            ariaLabels={{ tableLabel: pt ? 'Regras e taxa de aprovação' : 'Rules and pass rate' }}
            columnDefinitions={[
              {
                id: 'rule', header: pt ? 'Regra' : 'Rule',
                cell: rule => <SpaceBetween size="xxs"><Box variant="strong">{pt ? rule.titlePt : rule.title}</Box><Box variant="small" color="text-body-secondary">{pt ? rule.descriptionPt : rule.description}</Box></SpaceBetween>,
              },
              { id: 'level', header: pt ? 'Nível' : 'Level', cell: rule => levelLabel(rule.level, pt) },
              { id: 'applies', header: pt ? 'Aplica-se a' : 'Applies to', cell: rule => (rule.engines ? rule.engines.join(', ') : (pt ? 'todos' : 'all')) },
              {
                id: 'rate', header: pt ? 'Aprovação' : 'Pass rate', minWidth: 220,
                cell: rule => rule.percent === null
                  ? <Box color="text-status-inactive">{pt ? 'nenhum recurso' : 'no resource'}</Box>
                  : <ProgressBar value={rule.percent} additionalInfo={`${rule.passed}/${rule.applicable}`} ariaLabel={pt ? `${rule.titlePt}: ${rule.passed} de ${rule.applicable}` : `${rule.title}: ${rule.passed} of ${rule.applicable}`} />,
              },
            ]}
          />
        </Container>

        <Table<ScorecardItem>
          header={<Header variant="h2" counter={`(${data.items.length})`} description={pt ? 'Pior nível primeiro. Selecione um recurso para ver cada regra e a evidência medida.' : 'Worst level first. Select a resource to see each rule and the measured evidence.'}>{pt ? 'Recursos' : 'Resources'}</Header>}
          items={data.items}
          trackBy={item => `${item.namespace}/${item.name}`}
          selectionType="single"
          selectedItems={selected ? [selected] : []}
          onSelectionChange={({ detail }) => setSelected(detail.selectedItems[0] ?? null)}
          ariaLabels={{
            tableLabel: pt ? 'Recursos pontuados' : 'Scored resources',
            selectionGroupLabel: pt ? 'Seleção' : 'Selection',
            itemSelectionLabel: (_data, item) => item.name,
          }}
          columnDefinitions={[
            {
              id: 'name', header: pt ? 'Nome' : 'Name',
              cell: item => <Button variant="inline-link" onClick={() => onOpenDetail(detailPath(item))}>{item.name}</Button>,
            },
            { id: 'kind', header: 'Kind', cell: item => item.kind },
            { id: 'namespace', header: 'Namespace', cell: item => item.namespace },
            { id: 'owner', header: 'Owner', cell: item => <OwnerLink owner={item.owner} teams={teams} pt={pt} /> },
            { id: 'level', header: pt ? 'Nível' : 'Level', cell: item => <ScorecardLevelCell card={item.scorecard} pt={pt} /> },
            {
              id: 'failing', header: pt ? 'Falhando' : 'Failing',
              cell: item => {
                const failing = item.scorecard.rules.filter(rule => !rule.passed);
                if (!failing.length) return <StatusIndicator type="success">{pt ? 'nenhuma' : 'none'}</StatusIndicator>;
                const byId = new Map(data.standards.rules.map(rule => [rule.id, rule] as const));
                return failing.map(rule => (pt ? byId.get(rule.id)?.titlePt : byId.get(rule.id)?.title) ?? rule.id).join(', ');
              },
            },
          ]}
          empty={<Box textAlign="center">{pt ? 'Nenhum recurso no escopo para pontuar.' : 'No resource in scope to score.'}</Box>}
        />

        {selected && (
          <ExpandableSection defaultExpanded variant="container"
            headerText={`${selected.name} · ${levelLabel(selected.scorecard.level, pt)}`}
            headerDescription={pt ? 'Regras que falharam primeiro.' : 'Failed rules first.'}
            headerActions={<Button onClick={() => onOpenDetail(detailPath(selected))}>{pt ? 'Abrir detalhe' : 'Open detail'}</Button>}>
            <ScorecardRulesTable card={selected.scorecard} standards={data.standards.rules} pt={pt} />
          </ExpandableSection>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
