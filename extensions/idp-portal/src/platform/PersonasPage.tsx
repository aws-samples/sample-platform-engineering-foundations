import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Tabs from '@cloudscape-design/components/tabs';
import Textarea from '@cloudscape-design/components/textarea';
import { chatWithGateway } from './gatewayApi';
import { listPlatformResources, PlatformResource } from './platformApi';
import { useI18n } from './i18n';
import { errorMessage } from './errors';

interface Persona {
  id: string;
  name: string;
  namePt: string;
  scope: string;
  scopePt: string;
  kb: string;
  runtime: string;
  status: 'online' | 'planned';
  systemPrompt: string;
}

const PERSONAS: Persona[] = [
  {
    id: 'platform-engineer', name: 'Platform Engineer Agent', namePt: 'Platform Engineer Agent',
    scope: 'Operates the platform: diagnoses Argo/kro/ACK, evolves golden paths, drafts capability packages.',
    scopePt: 'Opera a plataforma: diagnostica Argo/kro/ACK, evolui golden paths, gera capability packages.',
    kb: 'docs/agent-platform/**, platform/catalog/**, ADRs', runtime: 'AI Gateway (Bedrock claude-sonnet)', status: 'online',
    systemPrompt: 'You are the Platform Engineer Agent of the AppMod Agent Platform (EKS + Argo CD + kro + ACK, GitOps-only writes, deletion gated by admin approval). Available kro APIs: ScheduledAgent, LambdaFunction, DynamoDBTable, WebAPI, StaticSite, ServerlessMultiTier. Answer operationally and concretely. Question: ',
  },
  {
    id: 'techwriter', name: 'TechWriter Agent', namePt: 'TechWriter Agent',
    scope: 'Maintains capability docs, Help content and catalog release notes.',
    scopePt: 'Mantém docs de capabilities, conteúdo do Help e release notes do catálogo.',
    kb: 'docs.md por capability, style guides', runtime: 'AI Gateway (Bedrock claude-sonnet)', status: 'online',
    systemPrompt: 'You are the TechWriter Agent of the AppMod Agent Platform. You write concise capability documentation, onboarding guides and release notes in pt-BR or en-US. Request: ',
  },
  {
    id: 'catalog', name: 'Catalog Agent', namePt: 'Catalog Agent',
    scope: 'The scaffolder: turns intent into capability packages and opens the MR.',
    scopePt: 'O scaffolder: transforma intenção em capability package e abre o MR.',
    kb: 'platform/catalog contract, exemplos', runtime: 'Argo Workflows (em implantação)', status: 'planned',
    systemPrompt: '',
  },
  {
    id: 'secops', name: 'SecOps Agent', namePt: 'SecOps Agent',
    scope: 'Runs the adversarial playbook, reviews policies and deletion findings.',
    scopePt: 'Roda o playbook adversarial, revisa policies e findings de deleção.',
    kb: 'tests/README, playbook, ADR-0007', runtime: 'scheduled (planejado)', status: 'planned',
    systemPrompt: '',
  },
];

export function PersonasPage(): JSX.Element {
  const { locale, t } = useI18n();
  const pt = locale === 'pt-BR';
  const [active, setActive] = useState<Persona>(PERSONAS[0]);
  const [question, setQuestion] = useState(pt ? 'Quais capabilities estão disponíveis e como crio uma tabela DynamoDB?' : 'Which capabilities are available and how do I create a DynamoDB table?');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [events, setEvents] = useState<PlatformResource[]>([]);

  useEffect(() => {
    listPlatformResources().then(r => setEvents(r.resources)).catch(() => setEvents([]));
  }, []);

  const ask = async () => {
    setAsking(true); setError(''); setAnswer('');
    try {
      setAnswer(await chatWithGateway(active.systemPrompt + question.trim()));
    } catch (cause) {
      setError(errorMessage(cause, 'chat failed'));
    } finally { setAsking(false); }
  };

  return (
    <ContentLayout header={<Header variant="h1" description={pt ? 'Agents com responsabilidade, escopo e KB própria operando a plataforma. Converse com um agent online ou acompanhe o trabalho no inbox.' : 'Agents with responsibility, scope and dedicated KB operating the platform. Chat with an online agent or follow work in the inbox.'}>{t('Personas')}</Header>}>
      <SpaceBetween size="l">
        <Cards
          items={PERSONAS}
          selectionType="single"
          selectedItems={[active]}
          onSelectionChange={({ detail }) => { const p = detail.selectedItems[0]; if (p) { setActive(p); setAnswer(''); } }}
          trackBy="id"
          cardDefinition={{
            header: item => <SpaceBetween direction="horizontal" size="xs"><span>{pt ? item.namePt : item.name}</span><Badge color={item.status === 'online' ? 'green' : 'grey'}>{item.status === 'online' ? 'online' : pt ? 'planejado' : 'planned'}</Badge></SpaceBetween>,
            sections: [
              { id: 'scope', content: item => pt ? item.scopePt : item.scope },
              { id: 'kb', header: 'Knowledge Base', content: item => item.kb },
              { id: 'runtime', header: 'Runtime', content: item => item.runtime },
            ],
          }}
          cardsPerRow={[{ cards: 1 }, { minWidth: 700, cards: 2 }]}
        />
        <Container header={<Header variant="h2" description={pt ? `Conversando com: ${pt ? active.namePt : active.name}. As respostas passam pelo AI Gateway privado (Bedrock-only).` : `Chatting with: ${active.name}. Answers go through the private, Bedrock-only AI Gateway.`}>{pt ? 'Chat com a persona' : 'Persona chat'}</Header>}>
          {active.status !== 'online'
            ? <Alert type="info">{pt ? 'Esta persona ainda não está online. Runtime em implantação.' : 'This persona is not online yet. Runtime being deployed.'}</Alert>
            : <SpaceBetween size="m">
                {!!error && <Alert type="error">{error}</Alert>}
                <FormField label={pt ? 'Pergunta ou pedido' : 'Question or request'}>
                  <Textarea value={question} onChange={({ detail }) => setQuestion(detail.value)} rows={3} />
                </FormField>
                <Button variant="primary" onClick={ask} loading={asking} disabled={!question.trim()}>{pt ? 'Perguntar' : 'Ask'}</Button>
                {!!answer && <Container><Box variant="p">{answer}</Box></Container>}
              </SpaceBetween>}
        </Container>
        <Container header={<Header variant="h2" description={pt ? 'Padrão PizzaBot: trabalho concluído em Unread, decisões pendentes em Action.' : 'PizzaBot pattern: finished work in Unread, pending decisions in Action.'}>{pt ? 'Inbox de long-running agents' : 'Long-running agents inbox'}</Header>}>
          <Tabs tabs={[
            {
              id: 'unread', label: `Unread (${events.length})`,
              content: events.length === 0
                ? <Box textAlign="center">{pt ? 'Nada não lido.' : 'Nothing unread.'}</Box>
                : <SpaceBetween size="s">{events.map(e => (
                    <Container key={e.arn}><SpaceBetween direction="horizontal" size="s">
                      <StatusIndicator type="success">{pt ? 'Provisionado' : 'Provisioned'}</StatusIndicator>
                      <span>{e.service} · <strong>{e.name}</strong> ({e.environment || 'lab'}){e.revisions && e.revisions > 1 ? ` · ${e.revisions} ${pt ? 'revisões' : 'revisions'}` : ''}</span>
                    </SpaceBetween></Container>
                  ))}</SpaceBetween>,
            },
            {
              id: 'action', label: 'Action (0)',
              content: <SpaceBetween size="s">
                <Box textAlign="center">{pt ? 'Nenhuma decisão pendente.' : 'No pending decisions.'}</Box>
                <Box variant="small" textAlign="center">{pt ? 'Aprovações de deleção (ADR-0007) aparecerão aqui quando a integração GitLab do inbox entrar; hoje vivem no Admin Console.' : 'Deletion approvals (ADR-0007) will land here once the inbox GitLab integration ships; today they live in the Admin Console.'}</Box>
              </SpaceBetween>,
            },
          ]} />
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
