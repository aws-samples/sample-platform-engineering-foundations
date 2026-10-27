/**
 * Documentos que o flavor público (`oss`) embarca. Lista pura (sem import.meta) porque vite.config.ts
 * também a lê: no build oss, todo `.md?raw` fora desta lista vira string vazia e sai do índice. O que
 * fica de fora hoje descreve o deployment interno (the internal gateway, the corporate SSO, the internal allowlist, the account console, PhoneTool); o
 * guia da extension é o README dela (backstage-killer passo 5). O gate do bundle oss confirma.
 */
export const PUBLIC_DOC_PATHS: readonly string[] = [
  'docs/agent-platform/golden-paths.md',
  'docs/agent-platform/maturity-model.md',
  'docs/agent-platform/kb/infra-authoring.md',
  'docs/agent-platform/kb/agent-authoring.md',
];
