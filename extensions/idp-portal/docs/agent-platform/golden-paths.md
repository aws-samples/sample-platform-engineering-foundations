# Golden Paths da Agent Platform

Todos os golden paths são definidos de uma vez, com o mesmo contrato e o mesmo write path
(portal -> MR -> CI -> mirror -> Argo -> kro -> ACK). O que varia é a ordem de implementação,
não o desenho. Engine por capability segue o ADR-0005; deleção segue o ADR-0007.

## Domínio 1 - Infraestrutura

Portados do catálogo do workshop `platform-engineering-foundations` para kro + ACK:

| Golden path | Capability | Engine | Origem no workshop |
|---|---|---|---|
| GP-I1 | `compute/lambda` | ACK (Lambda controller) ou hybrid se faltar feature | `compute/lambda` |
| GP-I2 | `database/dynamodb` | ACK | `database/dynamodb` |
| GP-I3 | `database/postgresql` | ACK (RDS) | `database/postgresql` |
| GP-I4 | `bucket/webhost` e `bucket/logging` | ACK (S3) | `bucket/*` |
| GP-I5 | `network/basic` | ACK (VPC/subnets/SG) | `network/basic` |
| GP-I6 | `queue/standard` | ACK (SQS) | derivado do lab ACK |
| GP-I7 | `entrypoint/api-gateway-rest` | ACK (APIGWv2) | `entrypoint/api-gateway/rest` |

## Domínio 2 - Clusters e serviços

| Golden path | Capability | Engine | Observação |
|---|---|---|---|
| GP-C1 | `cluster/eks-basic` | ACK (EKS) | Cluster como recurso; base para fleet futuro |
| GP-C2 | `cluster/eks-addon/*` | ACK/Helm via Argo | Add-ons ligados a um cluster existente (parent-child) |
| GP-C3 | `compute/container` | kro (Deployment+Service+NetworkPolicy) | Serviço dentro de um cluster selecionado |
| GP-C4 | `fleet/eks-cluster-mgmt` | kro + ACK (hub/spoke) | Portado de `fleet-management-on-amazon-eks-workshop`, pattern `kro-eks-cluster-mgmt`: management cluster provisiona/registra workload clusters no Argo; ativa junto com o split de contas do ADR-0006 |
| GP-C5 | `policy/gatekeeper` | Helm via Argo (+ constraints kro) | Guardrails OPA/Gatekeeper por cluster, inspirado em `awslabs/crossplane-on-eks/examples/gatekeeper`; as constraints valem para instâncias de qualquer engine |

## Estratégia de compute: Auto Mode + Spot por default

Baseada em `aws-samples/karpenter-blueprints`. EKS Auto Mode opera o Karpenter; nós declaramos
NodePools custom além dos default:

| NodePool | Capacity | Uso |
|---|---|---|
| `platform-spot` | `spot` com fallback `on-demand` (weight) | Default da plataforma: agents, workflows, workloads stateless - a maioria roda aqui |
| `platform-stable` | `on-demand` | Somente o que não tolera interrupção (controllers com leader election sensível, stateful sem PDB adequado) |

Regras dos blueprints aplicadas: diversificação ampla de instance types/sizes por NodePool;
`consolidationPolicy: WhenEmptyOrUnderutilized`; PDBs e `terminationGracePeriod` corretos nos
workloads antes de movê-los para Spot; workload escolhe pool por `nodeSelector` no RGD, não o
consumidor. Capabilities expõem no máximo `availabilityProfile: default|stable`, mantendo a
abstração.

## Fontes adicionais de capabilities

- `kro.run/examples/aws` - exemplos oficiais kro+ACK para acelerar RGDs (EKS cluster, DynamoDB,
  S3, networking): usar como ponto de partida dos GP-I*/GP-C*.
- `awslabs/crossplane-on-eks/examples` - referência para eventuais Hybrid Compositions e para o
  GP-C5; portar para kro+ACK quando a cobertura existir (ADR-0005).

## Domínio 3 - Aplicações compostas

| Golden path | Capability | Composição |
|---|---|---|
| GP-A1 | `app/serverless-multi-tier` | Lambda + API Gateway + DynamoDB + S3 frontend + IAM, padrão Hybrid do `sample-kro-serverless-app-stack` quando necessário |
| GP-A2 | `app/fullstack` | `compute/container` + `database/*` + `entrypoint/*` no cluster |
| GP-A3 | `frontend/spa` | Bucket webhost + distribuição compartilhada |

## Domínio 4 - Agents (primeira classe, não anexo)

Os agents padronizados que já existem no ambiente são a spec destes paths:

| Golden path | Capability | Baseado em | Estado atual |
|---|---|---|---|
| GP-G1 | `agent/scheduled` | RGD `scheduled-agent` (ServiceAccount + CronWorkflow + NetworkPolicy) | **RGD já Active; `hello-agent` Ready** |
| GP-G2 | `agent/conversational` | kagent `Agent` + `ModelConfig` apontando ao AI Gateway (`k8s-agent`) | Instância manual via bootstrap; falta capability |
| GP-G3 | `agent/sandbox` | agent-sandbox `Sandbox` (`smoke-sandbox`) | Instância manual; falta capability |
| GP-G4 | `agent/service` | Deployment long-running com health probes | Planejado |
| GP-G5 | `agent/pipeline` | O padrão AppMod real: orchestrator + N stage agents (prospect/techval/bizval/committed) com fan-out paralelo, DB compartilhado e synthesis | Roda no AgentCore hoje; é o tenant de migração |

Contrato comum de agent (todo GP-G): identidade própria (ServiceAccount + Pod Identity),
`modelAlias` fixo no AI Gateway privado, `networkProfile` restrito por default, traces ADOT/Langfuse
habilitados, schedule/timeout/retries quando batch, e `tools`/`skills` declarados. O JSON de
definição do portal compila para instância destes RGDs (compiler = Fase 1 dos agents).

## Ordem de implementação

1. **GP-G1 endurecido** (já existe; ganha schema/catalog contract) + **GP-I1 Lambda E2E** - prova
   infra e agent no mesmo release.
2. GP-I2/I4/I6 (DynamoDB, buckets, queue) - baixo risco, mesmos padrões.
3. GP-A1 serverless multi-tier - primeira composição multi-recurso.
4. GP-G2/G3 (conversational, sandbox) - remove os bootstraps manuais.
5. GP-C1/C2/C3 - cluster, add-ons, serviço no cluster.
6. GP-G5 - migração do pipeline AppMod (dual-run conforme Fase 9 do tasks.md).

## Aceite por golden path (invariável)

Criar pelo portal -> MR -> recurso real Ready no Inventory; editar um campo -> nova revision
reconciliada; deletar -> gate do ADR-0007; status visível vindo de Argo/kro/ACK, não de fixture.
