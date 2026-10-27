# agent/scheduled v1

Agent batch executado por Argo CronWorkflow, com ServiceAccount própria, retry (2x, backoff),
timeout de 30 min, `concurrencyPolicy: Forbid` e histórico de 24h. Nasce suspenso
(`suspend: true`) até revisão.

## Uso

```yaml
apiVersion: kro.run/v1alpha1
kind: ScheduledAgent
metadata:
  name: meu-agent
  namespace: appmod
spec:
  agentName: meu-agent
  schedule: "0 10 * * 1"
```

Fluxo: MR em `platform/instances/` -> CI -> mirror CodeCommit -> Argo CD -> kro cria
ServiceAccount + CronWorkflow. Instância viva de referência: `hello-agent`.

## Status

`serviceAccount` e `cronWorkflow` no status da instância; execuções no Argo Workflows.
