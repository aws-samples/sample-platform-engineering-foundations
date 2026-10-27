import { describe, expect, it } from 'vitest';
import { tourTrail, EXPECTED_SECONDS } from './tourTrail';
import type { ProvisionRequest } from './platformApi';

const req = (status: ProvisionRequest['status']): ProvisionRequest =>
  ({ requestId: 'a'.repeat(32), status, path: 'platform/instances/tour-alice.yaml', createdAt: 1000 });
const states = (t: ReturnType<typeof tourTrail>) => t.steps.map(s => `${s.id}:${s.state}`).join(' ');

describe('tourTrail', () => {
  it('shows nothing started without a request', () => {
    expect(states(tourTrail({ request: null, instance: null, published: false, now: 0, activeSince: null })))
      .toBe('request:pending mr:pending merge:pending gitops:pending cloudfront:pending page:pending');
  });

  it('walks the steps as the request and the instance progress', () => {
    const at = (request: ProvisionRequest | null, instance: { state: string; outputs?: Record<string, string> } | null, published = false) =>
      states(tourTrail({ request, instance, published, now: 1010, activeSince: 1000 }));
    expect(at(req('pending'), null)).toMatch(/^request:active mr:pending/);
    expect(at(req('mr_open'), null)).toMatch(/mr:done merge:waiting-human gitops:pending/);
    expect(at(req('merged'), null)).toMatch(/merge:done gitops:active cloudfront:pending/);
    expect(at(req('mr_open'), { state: 'IN_PROGRESS' })).toMatch(/merge:done gitops:done cloudfront:active/);
    expect(at(req('merged'), { state: 'ACTIVE', outputs: { distributionStatus: 'Deployed', url: 'https://d1.cloudfront.net' } }))
      .toMatch(/cloudfront:done page:active$/);
    expect(at(req('merged'), { state: 'ACTIVE', outputs: { distributionStatus: 'Deployed', url: 'https://d1.cloudfront.net' } }, true))
      .toBe('request:done mr:done merge:done gitops:done cloudfront:done page:done');
  });

  it('exposes the url only once CloudFront is Deployed, and the expiry from createdAt', () => {
    const base = { request: req('merged'), published: false, now: 1010, activeSince: 1000 };
    expect(tourTrail({ ...base, instance: { state: 'ACTIVE', outputs: { distributionStatus: 'InProgress', url: 'https://d1' } } }).url).toBe('');
    const done = tourTrail({ ...base, instance: { state: 'ACTIVE', outputs: { distributionStatus: 'Deployed', url: 'https://d1' } } });
    expect(done.url).toBe('https://d1');
    expect(done.expiresAt).toBe(1000 + 86400);
  });

  it('marks a failed or closed request as an error, never a spinner', () => {
    expect(states(tourTrail({ request: req('failed'), instance: null, published: false, now: 0, activeSince: null }))).toMatch(/request:error/);
    expect(states(tourTrail({ request: req('closed'), instance: null, published: false, now: 0, activeSince: null }))).toMatch(/merge:error/);
  });

  it('flags a step that takes more than twice the measured time', () => {
    const since = 1000;
    const slowAt = since + 2 * EXPECTED_SECONDS.gitops + 1;
    expect(states(tourTrail({ request: req('merged'), instance: null, published: false, now: slowAt, activeSince: since }))).toMatch(/gitops:slow/);
    expect(states(tourTrail({ request: req('merged'), instance: null, published: false, now: slowAt - 2, activeSince: since }))).toMatch(/gitops:active/);
  });

  it('never flags the human merge as slow', () => {
    expect(states(tourTrail({ request: req('mr_open'), instance: null, published: false, now: 999999, activeSince: 0 }))).toMatch(/merge:waiting-human/);
  });
});
