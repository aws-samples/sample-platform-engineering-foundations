# Static web app (CloudFront + S3)

Golden Path A. Entrega um site estático no padrão AWS, sem bucket público e sem website hosting.

## O que é provisionado

| Recurso | Configuração |
|---|---|
| S3 bucket | Block Public Access total, BucketOwnerEnforced, SSE-S3 com bucket key, versionamento |
| Origin Access Control | SigV4, `always`, tipo s3 |
| Bucket policy | `s3:GetObject` apenas para `cloudfront.amazonaws.com` com `AWS:SourceArn` da distribution |
| Response headers policy | HSTS 2 anos + preload, X-Content-Type-Options, X-Frame-Options DENY, Referrer-Policy, CSP configurável |
| Distribution | redirect-to-https, HTTP/2+3, IPv6, CachingOptimized, SPA fallback 403/404 -> index |

Tudo com `services.k8s.aws/deletion-policy: retain` e tag `auto-delete: no`.

## Publicar conteúdo

```bash
aws s3 sync ./build s3://<name>/ --delete
aws cloudfront create-invalidation --distribution-id <status.distributionId> --paths '/*'
```

A URL fica em `status.url`. A publicação via portal (upload + invalidation) é o próximo incremento do golden path.

## Limitações medidas

- Com o certificado default do CloudFront o TLS mínimo negociado fica em `TLSv1`; `minimumProtocolVersion` só é honrado com certificado ACM em domínio próprio (próximo incremento: `aliases` + `acm.services.k8s.aws`).
- A origem usa o endpoint regional `sa-east-1` do bucket.

## Prova E2E (2026-09-21)

Instância `hello-webapp`: distribution `Deployed`, acesso direto ao S3 `403`, via CloudFront `200`, HTTP `301` para HTTPS, todos os security headers presentes na resposta.

## Modo efêmero

`lifecycle: ephemeral` existe para o tour de primeiros passos
([`design-first-run.md`](../../../../../docs/agent-platform/design-first-run.md)). Exige nome no
espaço reservado (`metadata.name` `tour-*`, `spec.name` `appmod-tour-*-111122223333`),
`deletionPolicy: delete` e `expiresAt`. O prefixo é proibido para qualquer instância persistente,
e `lifecycle` e `deletionPolicy` não podem mudar depois da criação.
