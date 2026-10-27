# Maturity Model da Plataforma (CNCF TAG App Delivery)

Autoavaliação honesta contra o
[Platform Engineering Maturity Model](https://tag-app-delivery.cncf.io/whitepapers/platform-eng-maturity-model/)
do CNCF, lida em 17/09/2026. Níveis: 1 Provisional, 2 Operationalized, 3 Scalable, 4 Optimizing.

| Aspecto | Hoje | Evidência | Alvo | O que nos leva lá |
|---|---|---|---|---|
| **Investment** | 2 (Operationalized) | Time/dono dedicados (Bruno como platform owner), backlog e roadmap públicos em `tasks.md`; sem product metrics ainda | 3 (As product) | Usage metrics por capability no Inventory; roadmap publicado no portal; decisões por dados |
| **Adoption** | 1-2 | Tenant único (AppMod), uso dirigido pelo builder; catálogo agora descobrível no portal | 3 (Intrinsic pull) | Golden paths E2E com experiência "database fácil -> quero a queue daqui também" (cenário literal do whitepaper) |
| **Interfaces** | 2 -> 3 em curso | Golden paths documentados e wizard self-service; catálogo file-driven; ainda exige suporte do mantenedor para MR | 3 (Self-service) -> 4 (Integrated) | Catalog Agent fechando o loop de MR; nível 4 = observabilidade/identity injetadas por default nas compositions (já é o desenho dos RGDs) |
| **Operations** | 2 | GitOps com reconcile contínuo, upgrades das capabilities gerenciados pela AWS; Day 2 (edit/delete governado) em implantação | 3 | Edit por MR com revisions visíveis; deleção via Admin Console (ADR-0007) |
| **Measurement** | 1 | Sem métricas de plataforma além de usage do AI Gateway | 3 | KPIs por capability: instâncias por versão (pergunta do Product Owner do PSP), lead time provision->Ready, custo por capability |

## Como o desenho já aponta para o nível 4

- **Integrated services (Interfaces N4)**: os RGDs injetam identidade (ServiceAccount/Pod
  Identity), tags, observabilidade e deletion policy sem o consumidor pedir - é exatamente o
  exemplo do whitepaper de "observability agents injected into every workload".
- **Enabled ecosystem (Investment N4)**: o Catalog Agent permite especialistas (Security, DBA)
  contribuírem capabilities sem depender do backlog central - Nível 4 de Adoption (participatory).
- **Building blocks decomponíveis**: capabilities compostas (app/serverless-multi-tier) expõem as
  peças (`relations.composes`), atendendo o requisito N4 de decompor ofertas de alto nível.

## Regra de revisão

Reavaliar este mapa a cada fase concluída de `tasks.md`; a promoção de nível exige evidência
citável, nunca aspiração.
