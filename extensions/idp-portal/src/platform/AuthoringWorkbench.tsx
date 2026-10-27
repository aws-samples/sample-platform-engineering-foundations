import { useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import { parse } from 'yaml';
import { generateArtifact } from './gatewayApi';
import { useI18n } from './i18n';
import { lintAgentJson, lintInfrastructureYaml, LintResult } from './manifestLint';
import { errorMessage } from './errors';
import { gitNewFileUrl } from './deployment';

const INFRA_EXAMPLE = `apiVersion: kro.run/v1alpha1
kind: Bucket
metadata:
  name: reports
  namespace: appmod
spec:
  owner: platform-team
  environment: internal
  deletionPolicy: Retain
`;

const AGENT_EXAMPLE = JSON.stringify({
  name: 'customer-insights-agent',
  description: 'Analyzes customer signals and returns governed findings.',
  model: 'claude-sonnet',
  runtime: { type: 'scheduled', schedule: '0 10 * * 1', timeoutSeconds: 900, retries: 2 },
  instructions: ['Read the declared inputs', 'Use only allowed tools', 'Return structured findings'],
  tools: [],
  skills: [],
  observability: { traces: true, evaluations: true },
  security: { networkProfile: 'restricted', dataClassification: 'internal-restricted' },
}, null, 2);

export function AuthoringWorkbench({ kind }: { kind: 'infra' | 'agent' }): JSX.Element {
  const { locale, t } = useI18n();
  const pt = locale === 'pt-BR';
  const isInfra = kind === 'infra';
  const [prompt, setPrompt] = useState(isInfra
    ? (pt ? 'Crie uma capability de bucket S3 privado e criptografado para relatórios, retido na exclusão.' : 'Create a private encrypted S3 bucket capability for reports, retained on deletion.')
    : (pt ? 'Crie um agent read-only agendado que resume a saúde do EKS em dias úteis usando Bedrock.' : 'Create a scheduled read-only agent that summarizes EKS health every weekday using Bedrock.'));
  const [artifact, setArtifact] = useState(isInfra ? INFRA_EXAMPLE : AGENT_EXAMPLE);
  const [lint, setLint] = useState<LintResult | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [gitLabUrl, setGitLabUrl] = useState('');
  const language = isInfra ? 'YAML' : 'JSON';

  const runLint = (value = artifact) => {
    const result = isInfra ? lintInfrastructureYaml(value) : lintAgentJson(value);
    setLint(result);
    return result;
  };

  const generate = async () => {
    setGenerating(true);
    setError('');
    try {
      const result = await generateArtifact(kind, prompt, artifact);
      const cleaned = result.artifact.replace(/^```(?:yaml|json)?\s*/i, '').replace(/\s*```$/, '');
      setArtifact(cleaned);
      setSources(result.sources);
      runLint(cleaned);
    } catch (cause) {
      setError(errorMessage(cause, (pt ? 'Falha na geração do artefato.' : 'Artifact generation failed.')));
    } finally {
      setGenerating(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(artifact);
    } catch {
      setError(pt ? 'Falha ao acessar o clipboard. Selecione e copie o artefato manualmente.' : 'Clipboard access failed. Select and copy the artifact manually.');
    }
  };

  const prepareGitLabProposal = async () => {
    // Agents implantáveis nascem no Agent Builder (ADR-0008); este workbench só propõe infraestrutura.
    if (!isInfra) {
      setError(pt ? 'Agents agora são criados no Agent Builder, que valida, compila e abre o MR.' : 'Agents are now created in the Agent Builder, which validates, compiles and opens the MR.');
      return;
    }
    const result = runLint();
    if (result.errors.length) {
      setError(pt ? 'Corrija os erros de lint antes de propor o artefato.' : 'Fix lint errors before proposing this artifact.');
      return;
    }
    try {
      await navigator.clipboard.writeText(artifact);
      const name = isInfra
        ? ((parse(artifact) as { metadata?: { name?: string } })?.metadata?.name)
        : (JSON.parse(artifact) as { name?: string }).name;
      const filename = encodeURIComponent(`platform/instances/${name || 'new-artifact'}.yaml`);
      setGitLabUrl(gitNewFileUrl(filename));
      setError('');
    } catch {
      setError(pt ? 'Não foi possível preparar a proposta no GitLab. Copie o artefato manualmente.' : 'Could not prepare the GitLab proposal. Copy the artifact manually.');
    }
  };

  const status = useMemo(() => {
    if (!lint) return null;
    if (lint.errors.length) return <Alert type="error" header={`${lint.errors.length} ${pt ? 'erro(s) de lint' : 'lint error(s)'}`}>{lint.errors.map(t).join(' ')}</Alert>;
    if (lint.warnings.length) return <Alert type="warning" header={t('Valid with warnings')}>{lint.warnings.map(t).join(' ')}</Alert>;
    return <Alert type="success" header={t('Lint passed')}>{pt ? `O ${language} atende ao contrato atual da plataforma.` : `The ${language} satisfies the current platform contract.`}</Alert>;
  }, [language, lint, pt, t]);

  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2" description={pt ? `Escreva ${language} manualmente ou peça ao Bedrock um draft grounded.` : `Write ${language} manually or ask Bedrock to generate a grounded draft.`}>{t(isInfra ? 'Infrastructure manifest workbench' : 'Agent definition workbench')}</Header>}>
        <SpaceBetween size="m">
          {!isInfra && <Alert type="info" header={t('Definition contract, not a deployment artifact')} action={<Button href="#agent-builder">{pt ? 'Abrir o Agent Builder' : 'Open the Agent Builder'}</Button>}>{pt ? 'Este JSON é só um contrato de definição. Agents implantáveis são criados no Agent Builder, que valida, compila e abre o MR.' : 'This JSON is a definition contract only. Deployable agents are created in the Agent Builder, which validates, compiles and opens the MR.'}</Alert>}
          {!!error && <Alert type="error">{error}</Alert>}
          <FormField label={t('Describe the desired outcome')} description={pt ? `O retrieval usa a Knowledge Base de ${isInfra ? 'ACK e kro' : 'agents e skills'}.` : `Retrieval uses the ${isInfra ? 'ACK and kro' : 'agent and skill'} Bedrock Knowledge Base.`}>
            <Textarea value={prompt} onChange={({ detail }) => setPrompt(detail.value)} rows={4} />
          </FormField>
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="primary" onClick={generate} loading={generating} disabled={!prompt.trim()}>{t('Generate with Bedrock')}</Button>
            <Button onClick={() => runLint()}>Lint {language}</Button>
            <Button onClick={copy}>{t('Copy draft')}</Button>
            <Button onClick={prepareGitLabProposal}>{t('Prepare GitLab proposal')}</Button>
          </SpaceBetween>
          <FormField label={`${language} editor`} description={pt ? 'A geração nunca aplica nem commita. Revise e execute lint antes de propor um MR.' : 'Generation never applies or commits. Review and lint before proposing a Merge Request.'}>
            <Textarea value={artifact} onChange={({ detail }) => { setArtifact(detail.value); setLint(null); }} rows={18} />
          </FormField>
          {status}
          {!!gitLabUrl && <Alert type="success" header={t('Proposal prepared')}>{pt ? 'Artefato copiado. ' : 'Artifact copied. '}<Link href={gitLabUrl} external>{t('Open GitLab new file')}</Link>{pt ? ' e cole o conteúdo.' : ' and paste it.'}</Alert>}
          {sources.length > 0 && <Alert type="info" header={t('Knowledge Base grounding')}>{pt ? `${sources.length} documento(s) curado(s) recuperado(s).` : `${sources.length} curated source document(s) retrieved.`}</Alert>}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
