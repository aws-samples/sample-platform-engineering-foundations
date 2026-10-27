/*
 * O namespace pedido tem que chegar ao BACKEND, e o único campo que o backend lê é o manifest.
 *
 * O contrato de `POST /platform/provision-requests` é `{kind, name, capability, manifest}` - não
 * existe campo de namespace nele. Então um `?ns=team-a` que só preenchesse o input do wizard
 * terminaria num manifest gravado em `namespace: appmod`, que é o default do exemplo. Este módulo
 * é o que fecha essa lacuna: a função escreve o namespace DENTRO do metadata do manifest, que é
 * o que a CI commita e o Argo CD aplica.
 *
 * É manipulação de texto de propósito. Reserializar com `yaml.stringify` reformataria o documento
 * inteiro e apagaria os comentários dos exemplos, e o diff do MR é lido por humano.
 */

/** Indentação de uma linha, em espaços. Tab conta como um nível, que é o que o YAML aceita aqui. */
function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].replace(/\t/g, ' ').length : 0;
}

/**
 * O mesmo manifest com `metadata.namespace` igual a `namespace`.
 *
 * Regras, todas verificáveis:
 *  - namespace vazio devolve o manifest intacto (nada a afirmar, nada a mexer);
 *  - existindo `namespace:` dentro do bloco `metadata`, a linha é substituída preservando a
 *    indentação original;
 *  - não existindo, a linha é inserida como PRIMEIRA do bloco metadata, nunca no fim do documento
 *    (no fim ela cairia dentro de `spec` e mudaria o significado);
 *  - sem bloco `metadata` no nível zero, devolve intacto: inventar um metadata num documento que
 *    não é um objeto Kubernetes seria corromper o artefato do usuário;
 *  - idempotente: aplicar duas vezes com o mesmo namespace dá o mesmo texto.
 *
 * Só o PRIMEIRO documento é tocado. Manifest multi-documento (`---`) sai intacto, porque escolher
 * em qual documento escrever seria um palpite.
 */
export function withNamespace(manifest: string, namespace: string): string {
  const ns = String(namespace ?? '').trim();
  if (!ns) return manifest;
  const lines = manifest.split('\n');
  const separator = lines.findIndex(line => /^---\s*$/.test(line) && line !== lines[0]);
  if (separator > 0) return manifest;

  const metadataIndex = lines.findIndex(line => /^metadata:\s*$/.test(line));
  if (metadataIndex === -1) return manifest;

  // Fim do bloco: a primeira linha não vazia que volta ao nível de `metadata:` ou abaixo.
  let end = lines.length;
  for (let index = metadataIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (indentOf(line) <= indentOf(lines[metadataIndex])) { end = index; break; }
  }

  const block = lines.slice(metadataIndex + 1, end);
  const nsOffset = block.findIndex(line => /^[ \t]+namespace:\s*/.test(line));
  if (nsOffset !== -1) {
    const indent = /^[ \t]+/.exec(block[nsOffset])?.[0] ?? '  ';
    lines[metadataIndex + 1 + nsOffset] = `${indent}namespace: ${ns}`;
    return lines.join('\n');
  }

  // Indentação do bloco: copia a do primeiro campo existente, ou dois espaços quando vazio.
  const firstField = block.find(line => line.trim());
  const indent = firstField ? (/^[ \t]+/.exec(firstField)?.[0] ?? '  ') : '  ';
  lines.splice(metadataIndex + 1, 0, `${indent}namespace: ${ns}`);
  return lines.join('\n');
}

/** O namespace declarado no manifest, ou '' quando não há. Usado para avisar sobre divergência. */
export function namespaceOf(manifest: string): string {
  const lines = manifest.split('\n');
  const metadataIndex = lines.findIndex(line => /^metadata:\s*$/.test(line));
  if (metadataIndex === -1) return '';
  for (let index = metadataIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (indentOf(line) <= indentOf(lines[metadataIndex])) return '';
    const match = /^[ \t]+namespace:\s*["']?([^"'\s#]+)/.exec(line);
    if (match) return match[1];
  }
  return '';
}

export const OWNER_LABEL = 'platform.appmod/owner';
const LABEL_VALUE = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;

/**
 * O mesmo manifest com `metadata.labels[platform.appmod/owner]` igual a `owner` (ownership-model).
 *
 * Mesmas regras do namespace: owner vazio ou fora da forma de label devolve intacto; label existente
 * é substituído; sem bloco `labels` ele é criado como PRIMEIRO filho de `metadata`; sem `metadata`
 * no nível zero, ou multi-documento, intacto. O backend lê o label de qualquer kind, então o owner
 * vale igual para kro, ACK e kagent.
 */
export function withOwnerLabel(manifest: string, owner: string): string {
  const value = String(owner ?? '').trim();
  if (!value || !LABEL_VALUE.test(value)) return manifest;
  const lines = manifest.split('\n');
  const separator = lines.findIndex(line => /^---\s*$/.test(line) && line !== lines[0]);
  if (separator > 0) return manifest;
  const metadataIndex = lines.findIndex(line => /^metadata:\s*$/.test(line));
  if (metadataIndex === -1) return manifest;

  let end = lines.length;
  for (let index = metadataIndex + 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    if (indentOf(lines[index]) <= indentOf(lines[metadataIndex])) { end = index; break; }
  }
  const block = lines.slice(metadataIndex + 1, end);
  const firstField = block.find(line => line.trim());
  const indent = firstField ? (/^[ \t]+/.exec(firstField)?.[0] ?? '  ') : '  ';
  const labelsOffset = block.findIndex(line => /^[ \t]+labels:\s*$/.test(line));
  const escaped = OWNER_LABEL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const ownerLine = new RegExp(`^[ \\t]+(?:"${escaped}"|${escaped}):`);
  if (labelsOffset === -1) {
    lines.splice(metadataIndex + 1, 0, `${indent}labels:`, `${indent}${indent}${OWNER_LABEL}: ${value}`);
    return lines.join('\n');
  }
  const labelsIndex = metadataIndex + 1 + labelsOffset;
  let labelsEnd = end;
  for (let index = labelsIndex + 1; index < end; index += 1) {
    if (!lines[index].trim()) continue;
    if (indentOf(lines[index]) <= indentOf(lines[labelsIndex])) { labelsEnd = index; break; }
  }
  for (let index = labelsIndex + 1; index < labelsEnd; index += 1) {
    if (ownerLine.test(lines[index])) {
      const lead = /^[ \t]+/.exec(lines[index])?.[0] ?? `${indent}${indent}`;
      lines[index] = `${lead}${OWNER_LABEL}: ${value}`;
      return lines.join('\n');
    }
  }
  const childIndent = lines[labelsIndex + 1] && labelsIndex + 1 < labelsEnd ? (/^[ \t]+/.exec(lines[labelsIndex + 1])?.[0] ?? `${indent}${indent}`) : `${indent}${indent}`;
  lines.splice(labelsIndex + 1, 0, `${childIndent}${OWNER_LABEL}: ${value}`);
  return lines.join('\n');
}
