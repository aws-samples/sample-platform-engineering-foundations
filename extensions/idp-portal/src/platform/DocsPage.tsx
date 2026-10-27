/*
 * Página Documentação (backlog docs-in-portal): o Markdown que já vive no repo, renderizado dentro do
 * portal. É o TechDocs que quem vem do Backstage procura, sem servidor extra: os arquivos entram no
 * bundle no build, as figuras de docs/architecture também, e o renderer (`docs/markdown.tsx`) só
 * produz elementos React. Link para outro `.md` do índice abre aqui; fora do índice, abre no GitLab.
 */
import { useEffect, useMemo, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useI18n } from './i18n';
import { DOCS, DocEntry, GITLAB_BLOB_BASE, docByPath, docBySlug, figureUrl, loadDoc, resolveRepoPath } from './docs/docsIndex';
import { headingsOf, renderMarkdown } from './docs/markdown';

export interface DocsPageProps {
  /** Slug inicial (Help e deep links); default: o tour. */
  initialSlug?: string | null;
}

type Load = { status: 'loading' } | { status: 'ready'; markdown: string } | { status: 'error'; message: string };

const GROUP_LABEL = { guias: { pt: 'Guias', en: 'Guides' }, referencia: { pt: 'Referência', en: 'Reference' }, autoria: { pt: 'Autoria', en: 'Authoring' } } as const;

export function DocsPage({ initialSlug = null }: DocsPageProps): JSX.Element {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const [doc, setDoc] = useState<DocEntry>(docBySlug(initialSlug) ?? DOCS[0]);
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    setLoad({ status: 'loading' });
    loadDoc(doc)
      .then((markdown) => { if (active) setLoad({ status: 'ready', markdown }); })
      .catch((cause: unknown) => { if (active) setLoad({ status: 'error', message: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { active = false; };
  }, [doc]);

  const resolvers = useMemo(() => ({
    image: (src: string) => figureUrl(doc.path, src),
    docLink: (href: string) => {
      const target = docByPath(resolveRepoPath(doc.path, href.split('#')[0]));
      return target ? { onClick: () => setDoc(target) } : null;
    },
    externalBase: `${GITLAB_BLOB_BASE}${doc.path.split('/').slice(0, -1).join('/')}/`,
  }), [doc]);

  const headings = load.status === 'ready' ? headingsOf(load.markdown).filter((h) => h.level === 2) : [];
  const navItems = (['guias', 'referencia', 'autoria'] as const).map((group) => ({
    type: 'section' as const, text: GROUP_LABEL[group][pt ? 'pt' : 'en'],
    items: DOCS.filter((d) => d.group === group).map((d) => ({ type: 'link' as const, text: d.title[pt ? 'pt' : 'en'], href: `#docs:${d.slug}` })),
  }));

  return (
    <ContentLayout header={
      <Header variant="h1"
        description={pt
          ? 'Os mesmos arquivos Markdown do repositório, renderizados aqui. Editar o arquivo em Git atualiza esta página no próximo deploy; o validador de docs continua sendo o gate de links e imagens.'
          : 'The same Markdown files of the repository, rendered here. Editing the file in Git updates this page on the next deploy; the docs validator stays the gate for links and images.'}
        actions={<Button href={`${GITLAB_BLOB_BASE}${doc.path}`} target="_blank" iconName="external">{pt ? 'Abrir no GitLab' : 'Open in GitLab'}</Button>}
      >{pt ? 'Documentação' : 'Documentation'}</Header>
    }>
      <Grid gridDefinition={[{ colspan: { default: 12, s: 3 } }, { colspan: { default: 12, s: 9 } }]}>
        <SpaceBetween size="m">
          <SideNavigation
            activeHref={`#docs:${doc.slug}`}
            items={navItems}
            onFollow={(event) => { event.preventDefault(); const target = docBySlug(event.detail.href.replace('#docs:', '')); if (target) setDoc(target); }}
          />
          {headings.length > 0 && (
            <Container header={<Header variant="h3">{pt ? 'Nesta página' : 'On this page'}</Header>}>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {headings.map((h) => <li key={h.id}><Link href={`#${h.id}`} onFollow={(e) => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ block: 'start' }); }}>{h.text}</Link></li>)}
              </ul>
            </Container>
          )}
        </SpaceBetween>
        <Container>
          <Box variant="small" color="text-body-secondary" margin={{ bottom: 's' }}><code>{doc.path}</code></Box>
          {load.status === 'loading' && <StatusIndicator type="loading">{pt ? 'Carregando o documento' : 'Loading the document'}</StatusIndicator>}
          {load.status === 'error' && <StatusIndicator type="error">{pt ? `Documento não carregado: ${load.message}` : `Document not loaded: ${load.message}`}</StatusIndicator>}
          {load.status === 'ready' && <article data-testid="doc-article" style={{ lineHeight: 1.55 }}>{renderMarkdown(load.markdown, resolvers)}</article>}
        </Container>
      </Grid>
    </ContentLayout>
  );
}
