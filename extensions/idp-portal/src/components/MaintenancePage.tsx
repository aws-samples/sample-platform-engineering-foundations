import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import CsHeader from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { Header } from './Header';
import { useRouterFollow } from './routerFollow';

interface MaintenancePageProps {
  appName: string;
}

// Takedown page: the route stays so old links and the Hub card land here instead of a 404.
// The report HTML itself is excluded from the the internal gateway bundle (.gitlab-ci.yml s3 sync --exclude).
export function MaintenancePage({ appName }: MaintenancePageProps): JSX.Element {
  const follow = useRouterFollow();
  return (
    <>
      <Header appName="AppMod LATAM" showBack={true} />
      <div style={{ maxWidth: '720px', margin: '0 auto' }}>
        <Box padding={{ vertical: 'xxl', horizontal: 'l' }}>
          <div role="status">
            <Container header={<CsHeader variant="h1" description="Em manutenção">{appName}: under maintenance</CsHeader>}>
              <SpaceBetween size="l">
                <SpaceBetween size="xs">
                  <Box variant="h2">What changed</Box>
                  <Box variant="p">This page is offline. The HTML report keeps being delivered in the AppMod Slack channel
                    <strong> #platform-team</strong>. Please validate the report there.</Box>
                  <Box variant="p">A Quick App will replace this page. The link will appear here when it is ready.</Box>
                </SpaceBetween>
                <SpaceBetween size="xs">
                  <Box variant="h2">O que mudou</Box>
                  <Box variant="p">Esta página está fora do ar. O report HTML continua sendo enviado no canal de Slack
                    <strong> #platform-team</strong>. Valide o report por lá.</Box>
                  <Box variant="p">Um Quick App vai substituir esta página. O link aparece aqui quando estiver pronto.</Box>
                </SpaceBetween>
                <Link href="/" variant="primary" onFollow={follow('/')}>Back to Hub / Voltar ao Hub</Link>
              </SpaceBetween>
            </Container>
          </div>
        </Box>
      </div>
    </>
  );
}
