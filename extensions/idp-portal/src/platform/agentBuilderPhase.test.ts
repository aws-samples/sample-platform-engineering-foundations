import { describe, expect, it } from 'vitest';
import phaseCasesRaw from '../../tests/fixtures/agent-builder/phase-cases.json?raw';
import {
  AgentOp, AgentPhase, agentBuilderPhase, CONVERGENCE_BUDGET_SECONDS, PhaseA2A, PhaseAgent, PhaseRequest,
  pollPlan, presentPhase, timelineFor,
} from './agentBuilderPhase';

interface PhaseCase {
  id: string; op: AgentOp; request: PhaseRequest | null; agent: PhaseAgent | null; a2a: PhaseA2A | null; now: number; expected: AgentPhase;
}
const fixture = JSON.parse(phaseCasesRaw) as { budgetSeconds: number; cases: PhaseCase[] };

describe('agentBuilderPhase (golden do contrato, seção 6.2)', () => {
  it('usa o mesmo orçamento de convergência da fixture', () => {
    expect(CONVERGENCE_BUDGET_SECONDS).toBe(fixture.budgetSeconds);
  });

  it('cobre os 30 casos da fixture', () => {
    expect(fixture.cases).toHaveLength(30);
  });

  for (const c of fixture.cases) {
    it(`${c.id} -> ${c.expected}`, () => {
      expect(agentBuilderPhase(c.op, c.request, c.agent, c.a2a, c.now)).toBe(c.expected);
    });
  }

  it('a primeira regra que casa vence', () => {
    // Pedido failed com agent Ready: a regra 1 vence a regra 10.
    const agent: PhaseAgent = { createdAt: 0, accepted: 'True', ready: 'True', generation: 1, observedGeneration: 1, replicas: null };
    expect(agentBuilderPhase('create', { status: 'failed', mergedAt: null }, agent, null, 10)).toBe('FAILED');
    expect(agentBuilderPhase('create', null, agent, null, 10)).toBe('READY');
  });
});

describe('pollPlan (seção 6.3)', () => {
  it('lê o pedido a cada 5 s por até 2 min enquanto abre o MR', () => {
    expect(pollPlan('REQUESTED', 0)).toEqual({ source: 'request', intervalMs: 5_000 });
    expect(pollPlan('REQUESTED', 119_999)).not.toBeNull();
    expect(pollPlan('REQUESTED', 120_000)).toBeNull();
  });
  it('lê o pedido a cada 30 s em review e o cluster a cada 10 s depois do merge', () => {
    expect(pollPlan('IN_REVIEW', 10 * 60_000)).toEqual({ source: 'request', intervalMs: 30_000 });
    expect(pollPlan('SYNCING', 0)).toEqual({ source: 'agent', intervalMs: 10_000 });
    expect(pollPlan('STARTING', 0)).toEqual({ source: 'agent', intervalMs: 10_000 });
  });
  it('para em toda fase terminal', () => {
    for (const phase of ['FAILED', 'CLOSED', 'NOT_FOUND', 'SYNC_STALLED', 'REJECTED', 'DISABLED', 'STALLED', 'READY', 'VERIFIED', 'TEST_FAILED'] as AgentPhase[]) {
      expect(pollPlan(phase, 0), phase).toBeNull();
    }
  });
});

describe('apresentação da fase', () => {
  const phases = [...new Set(fixture.cases.map(c => c.expected))];

  it('toda fase tem rótulo e frase nos dois idiomas, sem travessão', () => {
    for (const phase of phases) {
      for (const pt of [true, false]) {
        const p = presentPhase(phase, pt);
        expect(p.label.length, phase).toBeGreaterThan(3);
        expect(p.detail.length, phase).toBeGreaterThan(10);
        expect(`${p.label}${p.detail}`).not.toMatch(/\u2014/);
      }
    }
  });

  it('fases de alerta dizem o estado em palavras, não só pela cor', () => {
    expect(presentPhase('SYNC_STALLED', true).label).toMatch(/^Atenção/);
    expect(presentPhase('STALLED', true).label).toMatch(/^Atenção/);
    expect(presentPhase('FAILED', true).label).toMatch(/^Falhou/);
  });

  it('a trilha marca o passo certo para cada fase', () => {
    const states = (op: AgentOp, phase: AgentPhase) => timelineFor(op, phase, true).map(s => s.state);
    expect(states('create', 'REQUESTED')).toEqual(['current', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(states('create', 'IN_REVIEW')).toEqual(['done', 'current', 'pending', 'pending', 'pending', 'pending']);
    expect(states('create', 'REJECTED')).toEqual(['done', 'done', 'done', 'error', 'pending', 'pending']);
    expect(states('create', 'READY')).toEqual(['done', 'done', 'done', 'done', 'done', 'current']);
    expect(states('create', 'VERIFIED')).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(states('disable', 'SYNCING')).toEqual(['done', 'done', 'current', 'pending']);
    expect(states('create', 'DISABLED')).toEqual(['done', 'done', 'done', 'done']);
  });
});
