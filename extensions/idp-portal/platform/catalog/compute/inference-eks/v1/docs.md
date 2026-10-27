# Model inference on EKS

Golden Path B, variante EKS. Um `InferenceEKS` entrega Deployment + Service + HPA + PDB + NetworkPolicy com hardening aplicado (medido no pod: `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation=false`, `capabilities.drop=[ALL]`, seccomp RuntimeDefault, `automountServiceAccountToken=false`).

Exposição: `ClusterIP` (default) ou `LoadBalancer` interno. Público não é oferecido por design. GPU: `nodePool: gpu` + `gpu: "1"` (exige nodegroup com acelerador).

## Prova E2E (2026-09-21)
Instância `hello-inference` ACTIVE em ~40s, 1/1 ready no pool spot, HTTP 200 no endpoint interno `http://hello-inference.appmod.svc.cluster.local:8080`.
