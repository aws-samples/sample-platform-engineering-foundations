import { parseAllDocuments } from 'yaml';

export interface LintResult {
  errors: string[];
  warnings: string[];
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function deepEntries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.flatMap(deepEntries);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => [[key, child] as [string, unknown], ...deepEntries(child)]);
}

function valuesForKey(value: unknown, expected: string): unknown[] {
  return deepEntries(value).filter(([key]) => key.toLowerCase() === expected.toLowerCase()).map(([, child]) => child);
}

export function lintInfrastructureYaml(source: string): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const documents = parseAllDocuments(source);
  for (const document of documents) {
    for (const error of document.errors) errors.push(`YAML: ${error.message}`);
  }
  if (documents.length !== 1) errors.push('Provide exactly one YAML document per request.');
  if (errors.length) return { errors, warnings };

  const value: unknown = documents[0]?.toJS();
  if (!isRecord(value)) return { errors: ['The YAML root must be an object.'], warnings };
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const spec = isRecord(value.spec) ? value.spec : null;
  const apiVersion = text(value.apiVersion);
  const kind = text(value.kind);
  const name = text(metadata.name);

  if (!apiVersion) errors.push('apiVersion is required.');
  if (!kind) errors.push('kind is required.');
  if (!name) errors.push('metadata.name is required.');
  if (name && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) errors.push('metadata.name must be a lowercase DNS label.');
  if (!spec) errors.push('spec must be an object.');
  if (apiVersion && !apiVersion.includes('kro.run') && !apiVersion.endsWith('services.k8s.aws')) {
    warnings.push('This API is neither kro nor ACK. Confirm that it belongs in the infrastructure catalog.');
  }

  const serviceTypes = valuesForKey(value, 'type').map(text).map(item => item.toLowerCase());
  if (serviceTypes.some(item => item === 'loadbalancer' || item === 'nodeport')) errors.push('Public Service types LoadBalancer and NodePort are forbidden.');
  const images = valuesForKey(value, 'image').map(text);
  if (images.some(image => /:latest$/i.test(image))) errors.push('Container images must not use :latest.');
  if (/-----begin [^-]*private key-----/i.test(source)) errors.push('Private keys are forbidden in manifests.');
  const credentials = deepEntries(value).filter(([key, child]) => /^(password|secretaccesskey|api[_-]?key|token)$/i.test(key) && typeof child === 'string' && !child.startsWith('${'));
  if (credentials.length) errors.push('Possible inline credential. Use a Secret or Secrets Manager reference.');
  const deletionPolicies = valuesForKey(value, 'deletionPolicy').map(text).map(item => item.toLowerCase());
  if (deletionPolicies.includes('delete')) errors.push('Data capabilities must use deletionPolicy: Retain.');
  if (/database|bucket|queue|topic|cache/i.test(kind) && !deletionPolicies.includes('retain')) {
    errors.push('Data capability must declare deletionPolicy: Retain.');
  }
  if (apiVersion.includes('.services.k8s.aws/')) {
    const autoDeleteValues = valuesForKey(value, 'auto-delete').map(text).map(item => item.toLowerCase());
    if (!autoDeleteValues.includes('no')) errors.push('Raw ACK resources require the exact tag auto-delete: no. Prefer a kro capability.');
  }
  return { errors, warnings };
}

export function lintAgentJson(source: string): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return { errors: [`JSON: ${error instanceof Error ? error.message : 'invalid JSON'}`], warnings };
  }
  if (!isRecord(value)) return { errors: ['The JSON root must be an object.'], warnings };
  const runtime = isRecord(value.runtime) ? value.runtime : {};
  const observability = isRecord(value.observability) ? value.observability : {};
  const security = isRecord(value.security) ? value.security : {};
  const name = text(value.name);

  if (!name) errors.push('name is required.');
  if (name && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) errors.push('name must be lowercase kebab-case.');
  if (!text(value.description)) errors.push('description is required.');
  if (value.model !== 'claude-sonnet') errors.push('model must use the approved claude-sonnet alias.');
  if (!['scheduled', 'service', 'conversational', 'sandbox'].includes(text(runtime.type))) errors.push('runtime.type is invalid.');
  if (!Array.isArray(value.instructions) || value.instructions.length === 0) errors.push('instructions must be a non-empty array.');
  if (observability.traces !== true) errors.push('observability.traces must be true.');
  if (!text(security.dataClassification)) errors.push('security.dataClassification is required.');

  const credentials = deepEntries(value).filter(([key, child]) => /^(password|secret|api[_-]?key|token)$/i.test(key) && typeof child === 'string' && !child.startsWith('${'));
  if (credentials.length) errors.push('Possible inline credential. Store only a reference.');
  if (!Array.isArray(value.tools)) warnings.push('tools should be an explicit array, even when empty.');
  if (!Array.isArray(value.skills)) warnings.push('skills should be an explicit array, even when empty.');
  return { errors, warnings };
}
