# Agent and Skill Authoring Standard

## Purpose

Generate maintainable JSON definitions for AI agents and concise Markdown definitions for reusable
skills. The generated artifact is a proposal for review, never an instruction to deploy directly.

## Agent JSON contract

```json
{
  "name": "example-agent",
  "description": "One sentence describing the outcome and user",
  "model": "claude-sonnet",
  "runtime": {
    "type": "scheduled",
    "schedule": "0 10 * * 1",
    "timeoutSeconds": 900,
    "retries": 2
  },
  "instructions": [
    "Read the declared inputs",
    "Use only the allowed tools",
    "Return the documented output contract"
  ],
  "tools": [],
  "skills": [],
  "observability": {
    "traces": true,
    "evaluations": true
  },
  "security": {
    "networkProfile": "restricted",
    "dataClassification": "internal-restricted"
  }
}
```

## Design rules

- Name describes the job, not a metaphor. Lowercase kebab-case.
- Description states outcome, consumer and boundary.
- Instructions are explicit, testable and ordered. Do not hide policy in prose.
- Tools use exact registered names. Unknown tools fail validation.
- Use Amazon Bedrock through model alias. Never reference an external provider API key.
- Separate runtime topology from framework. LangGraph is an optional orchestration engine inside a
  scheduled or service runtime, not a new deployment kind.
- Human approval is explicit for irreversible, shared or destructive actions.
- A read-only agent must not materialize write tools.
- Outputs have schemas or acceptance patterns. Free-form success claims are not evidence.
- Emit OpenTelemetry traces for steps, tool calls, retries, handoffs and model calls.
- Do not capture hidden chain-of-thought. Capture explicit decisions and outcomes.

## Skill rules

- A skill solves one repeatable task and has a clear trigger.
- Keep the main instruction concise; move examples and large references to progressive disclosure.
- Document exact tool names and parameters when a runtime cannot discover them safely.
- Include failure behavior and validation, not only the happy path.
- Avoid overlapping skills. Extend an existing owner when the domain and workflow are the same.

## Lint invariants

Reject an agent definition when:

1. JSON is invalid or the top-level value is not an object.
2. Name, description, model, runtime or instructions is absent.
3. Model is not an approved platform alias.
4. Runtime type is outside `scheduled`, `service`, `conversational` and `sandbox`.
5. Instructions are empty or non-testable placeholders.
6. A secret, token, password or external model endpoint appears inline.
7. A write tool is present while the security mode is read-only.
8. Observability or data classification is absent.

## Community patterns retained

- Small, composable agents with clear boundaries.
- Tools as explicit contracts rather than implied capabilities.
- Human-in-the-loop for high-impact decisions.
- Durable state only when the use case needs resume or long-running work.
- Evaluation datasets derived from failed real traces.

## Authoritative references

- Anthropic, Building effective agents: https://www.anthropic.com/research/building-effective-agents
- Agent Skills specification: https://agentskills.io/
- LangGraph: https://github.com/langchain-ai/langgraph
- Local platform contract: `docs/agent-platform/design.md`
