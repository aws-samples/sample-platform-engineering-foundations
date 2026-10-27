import { describe, expect, it } from 'vitest';
import type { EventRow, PodRow } from './clusterApi';
import { eventsOfWorkload, isFullyReady, podsOfWorkload, supportsHealthDetail } from './workloadHealth';

const pod = (name: string, namespace = 'opentelemetry-operator-system'): PodRow =>
  ({ name, namespace, phase: 'Running', ready: '1/1', restarts: 0, node: 'n', containers: ['manager'], ip: '10.0.0.1', created: '' });
const event = (object: string, last: string): EventRow =>
  ({ namespace: 'opentelemetry-operator-system', reason: 'r', type: 'Normal', object, message: '', count: 1, last });

describe('podsOfWorkload', () => {
  it('matches deployment pods by controller-generated name, not by prefix', () => {
    const pods = [
      pod('opentelemetry-operator-7d7c4b5959-4wn24'),
      pod('opentelemetry-operator-7d7c4b5959-8djjt'),
      pod('opentelemetry-operator-webhook-6b9c8d7f5-abcde'),
      pod('opentelemetry-operator-7d7c4b5959-zzzzz', 'other-ns'),
    ];
    expect(podsOfWorkload('deployment', 'opentelemetry-operator', 'opentelemetry-operator-system', pods).map(p => p.name))
      .toEqual(['opentelemetry-operator-7d7c4b5959-4wn24', 'opentelemetry-operator-7d7c4b5959-8djjt']);
  });

  it('matches statefulset ordinals and daemonset suffixes', () => {
    expect(podsOfWorkload('statefulset', 'keycloak-db', 'ns', [pod('keycloak-db-0', 'ns'), pod('keycloak-db-x', 'ns')]).length).toBe(1);
    expect(podsOfWorkload('daemonset', 'node-exporter', 'ns', [pod('node-exporter-k2x9p', 'ns'), pod('node-exporter-k2x9p-1', 'ns')]).length).toBe(1);
  });

  it('returns nothing for kinds without a name contract', () => {
    expect(supportsHealthDetail('job')).toBe(false);
    expect(podsOfWorkload('job', 'x', 'ns', [pod('x-abcde', 'ns')])).toEqual([]);
  });
});

describe('eventsOfWorkload', () => {
  it('keeps deployment, replicaset and pod events, including replaced pods, newest first', () => {
    const events = [
      event('Deployment/opentelemetry-operator', '2026-09-25T20:32:07Z'),
      event('ReplicaSet/opentelemetry-operator-7d7c4b5959', '2026-09-25T20:38:19Z'),
      event('Pod/opentelemetry-operator-7d7c4b5959-nn27h', '2026-09-25T20:38:19Z'),
      event('Pod/opentelemetry-operator-webhook-6b9c8d7f5-abcde', '2026-09-25T20:40:00Z'),
      event('Node/ip-192-168-161-31', '2026-09-25T20:39:18Z'),
    ];
    const kept = eventsOfWorkload('deployment', 'opentelemetry-operator', events).map(e => e.object);
    expect(kept).toEqual([
      'ReplicaSet/opentelemetry-operator-7d7c4b5959',
      'Pod/opentelemetry-operator-7d7c4b5959-nn27h',
      'Deployment/opentelemetry-operator',
    ]);
  });
});

describe('isFullyReady', () => {
  it('flags only partial counts; 0/0 (ebs-csi-node-windows without Windows nodes) is not a fault', () => {
    expect(isFullyReady('2/2')).toBe(true);
    expect(isFullyReady('1/2')).toBe(false);
    expect(isFullyReady('0/1')).toBe(false);
    expect(isFullyReady('0/0')).toBe(true);
  });
});
