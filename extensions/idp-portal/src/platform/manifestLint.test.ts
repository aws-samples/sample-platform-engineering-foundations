import { describe, expect, it } from 'vitest';
import { lintAgentJson, lintInfrastructureYaml } from './manifestLint';

describe('infrastructure manifest lint', () => {
  it('accepts a governed kro data capability', () => {
    const result = lintInfrastructureYaml(`apiVersion: kro.run/v1alpha1
kind: Bucket
metadata:
  name: reports
spec:
  deletionPolicy: Retain
`);
    expect(result.errors).toEqual([]);
  });

  it('rejects public service, latest image and inline credentials', () => {
    const result = lintInfrastructureYaml(`apiVersion: v1
kind: Service
metadata:
  name: Bad_Name
spec:
  type: LoadBalancer
  image: example:latest
  password: plaintext
`);
    expect(result.errors.join(' ')).toMatch(/DNS label/);
    expect(result.errors.join(' ')).toMatch(/LoadBalancer/);
    expect(result.errors.join(' ')).toMatch(/:latest/);
    expect(result.errors.join(' ')).toMatch(/credential/);
  });

  it('rejects quoted and folded security values through the parsed AST', () => {
    const result = lintInfrastructureYaml(`apiVersion: s3.services.k8s.aws/v1alpha1
kind: Bucket
metadata:
  name: unsafe
spec:
  type: "LoadBalancer"
  deletionPolicy: "Delete"
  tags:
    auto-delete: yes
`);
    const errors = result.errors.join(' ');
    expect(errors).toMatch(/LoadBalancer/);
    expect(errors).toMatch(/deletionPolicy: Retain/);
    expect(errors).toMatch(/auto-delete: no/);
  });

  it('treats a missing ACK auto-delete tag as an error', () => {
    const result = lintInfrastructureYaml(`apiVersion: s3.services.k8s.aws/v1alpha1
kind: Bucket
metadata:
  name: reports
spec:
  deletionPolicy: Retain
`);
    expect(result.errors.join(' ')).toMatch(/auto-delete: no/);
  });

  it('rejects malformed YAML', () => {
    expect(lintInfrastructureYaml('spec: [').errors[0]).toMatch(/YAML/);
  });
});

describe('agent definition lint', () => {
  const valid = {
    name: 'eks-health-agent',
    description: 'Summarizes EKS health.',
    model: 'claude-sonnet',
    runtime: { type: 'scheduled' },
    instructions: ['Read EKS health', 'Return a summary'],
    tools: [],
    skills: [],
    observability: { traces: true },
    security: { dataClassification: 'internal-restricted' },
  };

  it('accepts a Bedrock-only observable agent', () => {
    expect(lintAgentJson(JSON.stringify(valid)).errors).toEqual([]);
  });

  it('rejects external providers and missing observability', () => {
    const invalid = { ...valid, model: 'openai-gpt', observability: { traces: false } };
    const errors = lintAgentJson(JSON.stringify(invalid)).errors.join(' ');
    expect(errors).toMatch(/claude-sonnet/);
    expect(errors).toMatch(/traces/);
  });

  it('rejects invalid JSON', () => {
    expect(lintAgentJson('{').errors[0]).toMatch(/JSON/);
  });
});
