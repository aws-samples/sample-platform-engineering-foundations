import type { EventRow, PodRow } from './clusterApi';

// The cluster-api workload rows carry no label selector, so pods are matched by the name the
// controller generates. These shapes are fixed by Kubernetes:
//   Deployment  <name>-<pod-template-hash>-<5 chars>
//   StatefulSet <name>-<ordinal>
//   DaemonSet   <name>-<5 chars>
const POD_NAME_SUFFIX: Record<string, string> = {
  deployment: '-[a-z0-9]{6,10}-[a-z0-9]{5}',
  statefulset: '-\\d+',
  daemonset: '-[a-z0-9]{5}',
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function supportsHealthDetail(kind: string): boolean {
  return kind in POD_NAME_SUFFIX;
}

export function podsOfWorkload(kind: string, name: string, namespace: string, pods: PodRow[]): PodRow[] {
  const pattern = podNamePattern(kind, name);
  if (!pattern) return [];
  return pods.filter(pod => pod.namespace === namespace && pattern.test(pod.name));
}

function podNamePattern(kind: string, name: string): RegExp | null {
  const suffix = POD_NAME_SUFFIX[kind];
  return suffix ? new RegExp(`^${escape(name)}${suffix}$`) : null;
}

/** Events of the workload, its ReplicaSets and its pods, including pods that were already replaced. */
export function eventsOfWorkload(kind: string, name: string, events: EventRow[]): EventRow[] {
  const pod = podNamePattern(kind, name);
  const owner = `${kind === 'deployment' ? 'Deployment' : kind === 'statefulset' ? 'StatefulSet' : 'DaemonSet'}/${name}`;
  const replicaSet = kind === 'deployment' ? new RegExp(`^${escape(name)}-[a-z0-9]{6,10}$`) : null;
  return events
    .filter(event => {
      if (event.object === owner) return true;
      const [objectKind, objectName = ''] = event.object.split('/');
      if (objectKind === 'Pod') return Boolean(pod?.test(objectName));
      if (objectKind === 'ReplicaSet') return Boolean(replicaSet?.test(objectName));
      return false;
    })
    .sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''));
}

/** 0 desired (scaled to zero, or a DaemonSet with no matching nodes) has nothing to explain. */
export function isFullyReady(ready?: string): boolean {
  if (!ready) return true;
  const [current, desired] = ready.split('/');
  return desired === '0' || current === desired;
}
