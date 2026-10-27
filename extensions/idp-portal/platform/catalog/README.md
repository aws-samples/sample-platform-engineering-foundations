# Platform Catalog

Este diretório é o **Platform API Registry**: a fonte de verdade do que a plataforma oferece.
O portal renderiza o catálogo a partir daqui; nenhuma capability é hardcoded na UI.

## Contrato de capability

```text
platform/catalog/<domain>/<name>/v<major>/
  capability.yaml      identidade, owner, engine, lifecycle, relations
  schema.json          JSON Schema dos inputs (gera o formulário)
  rgd.yaml             ResourceGraphDefinition (a Platform API)
  examples/            instâncias de exemplo válidas
  docs.md              documentação da capability (TechDocs da entidade)
```

### `capability.yaml`

```yaml
apiVersion: platform.appmod/v1
kind: Capability
metadata:
  name: lambda
  domain: compute
  version: v1
spec:
  owner: platform-team
  description: Função Lambda governada com IAM mínimo e observabilidade.
  engine: ack            # ack | hybrid | crossplane (ADR-0005; hybrid/crossplane exigem ackGap)
  # ackGap: descrição do gap + link, obrigatório quando engine != ack
  lifecycle: available   # available | preview | planned | deprecated
  deletionPolicy: retain # default imposto; mudar exige justificativa no MR (ADR-0007)
  targetAccounts: ["111122223333"]   # ADR-0006; único valor aceito hoje
  relations:
    requires: []         # ex.: cluster/eks-basic para compute/container
    composes: []         # capabilities internas, ex. app/serverless-multi-tier
  status:
    argoApplication: agent-platform-instances
    readyCondition: "ACK.ResourceSynced"
```

## Regras

- Versionamento por diretório `v1`, `v2`: breaking change de schema é versão nova, instâncias
  antigas continuam válidas (padrão do catálogo do workshop `platform-engineering-foundations`).
- `schema.json` é a única fonte do formulário do portal e da validação do CI - produtor e
  consumidor validam contra o mesmo arquivo.
- Toda capability nova entra por MR com: os 5 arquivos do contrato, exemplo aplicável em dry-run e
  entrada em `golden-paths.md`.
- Agents são capabilities do domínio `agent/` com o mesmo contrato (ver `golden-paths.md`, GP-G*).

## Catálogo alvo

Domínios e paths definidos em [`../../docs/agent-platform/golden-paths.md`](../../docs/agent-platform/golden-paths.md).
A primeira capability materializada aqui é `agent/scheduled/v1` (o RGD `scheduled-agent` já ativo,
ganhando schema e docs) seguida de `compute/lambda/v1`.
