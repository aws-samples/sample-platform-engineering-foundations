// Hooks do Agent Builder. O polling segue a seção 6.3 do design: o intervalo depende da fase, e
// toda fase terminal para o loop. Nenhum hook escreve no cluster.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  A2AResult, AgentProvisionRequest, ApiError, ArgoState, BuilderAgentDetail, BuilderAgentList,
  getA2ATest, getAgentBuilderMe, getAgentRequest, getBuilderAgent, listBuilderAgents, startA2ATest,
} from './agentBuilderApi';
import { AgentPhase, agentBuilderPhase, isA2ATerminal, PhaseA2A, pollPlan } from './agentBuilderPhase';
import { ActionableError, agentForTarget, describeApiError, toPhaseAgent, TrackedTarget } from './agentBuilderModel';

// ---------------------------------------------------------------- gate da feature (I13)

export type GateState =
  | { status: 'loading' }
  | { status: 'enabled'; alias: string; isAdmin: boolean }
  | { status: 'disabled' }
  | { status: 'error'; error: ActionableError };

export function useAgentBuilderGate(pt: boolean, preset?: boolean): { gate: GateState; retry: () => void } {
  const [gate, setGate] = useState<GateState>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setGate({ status: 'loading' });
    getAgentBuilderMe()
      .then(me => {
        if (cancelled) return;
        const enabled = preset ?? me.features?.agentBuilder === true;
        setGate(enabled ? { status: 'enabled', alias: me.alias, isAdmin: me.isAdmin } : { status: 'disabled' });
      })
      .catch(cause => { if (!cancelled) setGate({ status: 'error', error: describeApiError(cause, 'gate', pt) }); });
    return () => { cancelled = true; };
  }, [nonce, preset, pt]);
  return { gate, retry: () => setNonce(n => n + 1) };
}

// ---------------------------------------------------------------- ciclo de vida

export interface LifecycleSnapshot {
  request: AgentProvisionRequest | null;
  agent: BuilderAgentDetail | null;
  argo: ArgoState | null;
  phase: AgentPhase | null;
  now: number;
  updatedAt: number | null;
  /** O pedido não existe ou é de outra pessoa (o 5.4 responde igual nos dois casos). */
  requestMissing: boolean;
  requestError: ActionableError | null;
  clusterError: ActionableError | null;
  polling: boolean;
}

const EMPTY: LifecycleSnapshot = {
  request: null, agent: null, argo: null, phase: null, now: 0, updatedAt: null,
  requestMissing: false, requestError: null, clusterError: null, polling: false,
};

const RETRY_ON_ERROR_MS = 10_000;

export function useAgentLifecycle(target: TrackedTarget | null, a2a: PhaseA2A | null, pt: boolean): LifecycleSnapshot & { refresh: () => void } {
  const [snapshot, setSnapshot] = useState<LifecycleSnapshot>(EMPTY);
  const [nonce, setNonce] = useState(0);
  const a2aRef = useRef(a2a);
  a2aRef.current = a2a;

  // O resultado do teste A2A muda a fase sem nova leitura de rede.
  useEffect(() => {
    setSnapshot(s => (s.phase && target
      ? { ...s, phase: agentBuilderPhase(target.op, s.request ? { status: s.request.status, mergedAt: s.request.mergedAt ?? null } : null, toPhaseAgent(s.agent), a2a, s.now) }
      : s));
  }, [a2a?.state, a2a?.hasText, target?.op]);

  useEffect(() => {
    if (!target) { setSnapshot(EMPTY); return; }
    let cancelled = false;
    let timer: number | undefined;
    let lastPhase: AgentPhase | null = null;
    let phaseSince = Date.now();
    let previous: LifecycleSnapshot = EMPTY;

    const tick = async () => {
      let request = previous.request;
      let requestMissing = false;
      let requestError: ActionableError | null = null;
      if (target.requestId) {
        try { request = await getAgentRequest(target.requestId); }
        catch (cause) {
          if (cause instanceof ApiError && cause.status === 404 && !String(cause.message).includes('disabled')) { request = null; requestMissing = true; }
          else requestError = describeApiError(cause, 'request', pt);
        }
      }

      // O cluster só interessa depois do merge, ou quando não há pedido (agent aberto pela lista).
      let agent = previous.agent;
      let argo = previous.argo;
      let clusterError: ActionableError | null = null;
      const readCluster = !target.requestId || requestMissing || request?.status === 'merged';
      if (readCluster) {
        try {
          agent = agentForTarget(await getBuilderAgent(target.name), target);
          if (!agent) argo = (await listBuilderAgents()).argo ?? null;
        } catch (cause) { clusterError = describeApiError(cause, 'cluster', pt); }
      }
      if (cancelled) return;

      const now = Date.now() / 1000;
      const phaseRequest = request && !requestMissing ? { status: request.status, mergedAt: request.mergedAt ?? null } : null;
      const phase = requestError && !request ? null : agentBuilderPhase(target.op, phaseRequest, toPhaseAgent(agent), a2aRef.current, now);
      if (phase !== lastPhase) { lastPhase = phase; phaseSince = Date.now(); }
      const plan = phase ? pollPlan(phase, Date.now() - phaseSince) : null;
      const failing = Boolean(requestError || clusterError);
      const next = failing ? RETRY_ON_ERROR_MS : plan?.intervalMs;

      previous = { request, agent, argo, phase, now, updatedAt: Date.now(), requestMissing, requestError, clusterError, polling: next !== undefined };
      setSnapshot(previous);
      if (next !== undefined) timer = window.setTimeout(tick, next);
    };

    setSnapshot({ ...EMPTY, polling: true });
    void tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [target?.name, target?.op, target?.requestId, nonce, pt]);

  return { ...snapshot, refresh: useCallback(() => setNonce(n => n + 1), []) };
}

// ---------------------------------------------------------------- teste A2A

export interface ChatMessage { id: number; role: 'user' | 'agent' | 'system'; text: string; state?: string }

const A2A_POLL_MS = 2_000;
const A2A_DEADLINE_MS = 60_000;

export function useA2ATest(name: string | null, pt: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<A2AResult | null>(null);
  const [error, setError] = useState<ActionableError | null>(null);
  const counter = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setMessages([]); setLast(null); setError(null); }, [name]);

  const push = (message: Omit<ChatMessage, 'id'>) => {
    counter.current += 1;
    const id = counter.current;
    setMessages(list => [...list, { ...message, id }]);
  };

  const send = useCallback(async (text: string) => {
    if (!name || running) return;
    setRunning(true); setError(null);
    push({ role: 'user', text: text.trim() || (pt ? '(pergunta padrão do idioma do agent)' : "(default question in the agent's language)") });
    try {
      const task = await startA2ATest(name, text);
      const startedAt = Date.now();
      let result: A2AResult = { state: task.state, hasText: false };
      while (alive.current && !isA2ATerminal(result.state) && Date.now() - startedAt < A2A_DEADLINE_MS) {
        await new Promise(resolve => window.setTimeout(resolve, A2A_POLL_MS));
        result = await getA2ATest(name, task.taskId);
      }
      if (!alive.current) return;
      if (!isA2ATerminal(result.state)) {
        push({ role: 'system', text: pt ? 'Sem resposta final em 60 s. O teste foi interrompido no portal; o agent pode ainda estar processando.' : 'No final answer within 60 s. The portal stopped waiting; the agent may still be working.', state: result.state });
        setLast({ state: 'failed', hasText: false });
      } else {
        push(result.hasText && result.text
          ? { role: 'agent', text: result.text, state: result.state }
          : { role: 'system', text: pt ? `O agent terminou em "${result.state}" sem texto.` : `The agent ended in "${result.state}" without text.`, state: result.state });
        setLast(result);
      }
    } catch (cause) {
      if (!alive.current) return;
      const described = describeApiError(cause, 'a2a', pt);
      setError(described);
      push({ role: 'system', text: `${described.header}. ${described.action}` });
    } finally {
      if (alive.current) setRunning(false);
    }
  }, [name, pt, running]);

  return { messages, running, last, error, send };
}

// ---------------------------------------------------------------- lista de agents do builder

export function useBuilderAgents(pt: boolean, active: boolean) {
  const [data, setData] = useState<BuilderAgentList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ActionableError | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true); setError(null);
    listBuilderAgents()
      .then(list => { if (!cancelled) setData(list); })
      .catch(cause => { if (!cancelled) setError(describeApiError(cause, 'cluster', pt)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active, nonce, pt]);
  return { data, loading, error, reload: () => setNonce(n => n + 1) };
}
