import { describe, expect, it } from 'vitest';
import { TEAM_ROUTES } from './routes';
import { HUB_ROUTES, INTERNAL } from './platform/deployment';

describe('AppMod Report Pipeline portal entry', () => {
  it('always lists the portal and appends exactly the hub routes of the deployment profile', () => {
    expect(TEAM_ROUTES[0]?.path).toBe('/agent-platform/');
    expect(TEAM_ROUTES.slice(1)).toEqual([...HUB_ROUTES]);
    expect(HUB_ROUTES.length === 0).toBe(!INTERNAL);
  });
  it.runIf(INTERNAL)('links the Pipeline card to the restricted Quick App (internal profile)', () => {
    const pipeline = TEAM_ROUTES.find((route) => route.path === '/pipeline/');
    const report = pipeline?.reports?.find((item) => item.name === 'AppMod Report Pipeline');

    expect(report?.path).toContain('quicksight.aws.amazon.com');
    expect(report?.description).toContain('LATAM AppMod Pipeline Hygiene');
    expect(report?.description).toContain('live SFDC validation');
    expect(report?.badge).toBe('NEW');
  });
});
