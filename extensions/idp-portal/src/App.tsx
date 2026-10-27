import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Box from '@cloudscape-design/components/box';
import Cards from '@cloudscape-design/components/cards';
import ContentLayout from '@cloudscape-design/components/content-layout';
import CsHeader from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { Header } from './components/Header';
import { UserInfoBar } from './components/UserInfoBar';
import { MaintenancePage } from './components/MaintenancePage';
import { RenderIcon } from './components/IconMap';
import { isExternal, useRouterFollow } from './components/routerFollow';
import { TEAM_ROUTES, TEAM_CATEGORIES } from './routes';
import { INTERNAL } from './platform/deployment';

const AgentPlatformPage = lazy(() => import('./platform/AgentPlatformPage'));

// No auth configuration needed - the internal gateway handles the corporate SSO authentication natively.
// Every user with access to the the internal allowlist can see the app. No Cognito, no Federate,
// no token refresh headaches.

function Launcher(): JSX.Element {
  const apps = TEAM_CATEGORIES.flatMap(c => (c.reports || []).map(r => r));
  const follow = useRouterFollow();
  return (
    <ContentLayout
      defaultPadding
      maxContentWidth={1100}
      header={<CsHeader variant="h1" description={INTERNAL ? "Acesso autenticado via the corporate SSO. Selecione um app." : "Selecione um app."}>AppMod LATAM - Portal</CsHeader>}
    >
      <Cards
        items={apps}
        trackBy="path"
        cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 2 }, { minWidth: 900, cards: 3 }]}
        cardDefinition={{
          header: app => (
            <SpaceBetween direction="horizontal" size="s" alignItems="center">
              <RenderIcon name={app.icon || 'file-text'} size={28} />
              <Link href={app.path} external={isExternal(app.path)} fontSize="heading-m" onFollow={follow(app.path)}>{app.name}</Link>
            </SpaceBetween>
          ),
          sections: [{ id: 'description', content: app => <Box color="text-body-secondary">{app.description || ''}</Box> }],
        }}
      />
    </ContentLayout>
  );
}

function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<><Header appName="AppMod LATAM" showBack={true} /><UserInfoBar /><Launcher /></>} />
        <Route path="/agent-platform/*" element={<Suspense fallback={<Box padding="xxl"><StatusIndicator type="loading">Loading Agent Platform...</StatusIndicator></Box>}><AgentPlatformPage /></Suspense>} />
        {TEAM_ROUTES.filter(r => r.maintenance).map((route) => (
          <Route key={route.path} path={route.path} element={<MaintenancePage appName={route.name} />} />
        ))}
      </Routes>
    </BrowserRouter>
  );
}

export default App;
