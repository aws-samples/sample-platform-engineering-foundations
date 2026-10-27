# Model inference on ECS Fargate (preview)

Golden Path B, variante ECS. Mesmo contrato da variante EKS. Cluster ECS dedicado (Container Insights), TaskDefinition Fargate arm64 (non-root, rootfs read-only, tmpfs, logs CloudWatch 30d), Service em subnets privadas sem IP público, circuit breaker com rollback.

## Estado: PREVIEW bloqueada por ackGap medido
A task chegou a RUNNING no Fargate (arm64, IP privado, sem IP público), mas o controller ACK ECS da EKS Capability `46.137.1` re-registra o TaskDefinition a cada reconcile (934 revisões em ~25 min, reproduzido 2x) e empurra deployments em loop no Service. Ver `ackGap` no capability.yaml. Não habilitar até re-medição em versão nova da Capability.

Pré-requisitos por conta (one-time): service-linked role `AWSServiceRoleForECS`; role `AppModPlatformECSTaskExecutionRole`; `logs:TagResource`/`Describe*` na role da Capability.
