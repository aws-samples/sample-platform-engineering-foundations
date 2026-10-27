import { HUB_ROUTES, type HubRoute } from './platform/deployment';

type RouteConfig = HubRoute;

export const TEAM_ROUTES: RouteConfig[] = [
  {
    path: '/agent-platform/',
    name: 'Agent Platform',
    icon: 'wrench',
    reports: [
      { name: 'Agent Platform', path: '/agent-platform/', description: 'Provision infrastructure and AI agents through EKS Capabilities and GitOps', icon: 'wrench', badge: 'NEW' },
    ],
  },
  // Entradas internas do hub vêm do perfil de deployment (vazio no público; o export troca o arquivo interno).
  ...HUB_ROUTES,
];

export const TEAM_CATEGORIES = TEAM_ROUTES.filter(r => r.reports);
