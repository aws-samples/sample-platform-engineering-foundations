/**
 * docs-in-portal: Markdown do repo renderizado como elementos React, sem `innerHTML`.
 *
 * Subconjunto deliberado do que os docs de `docs/agent-platform` usam: títulos, parágrafos, listas
 * (com e sem número), código em bloco e inline, negrito, links, imagens (`![]()` e `<img>` com
 * `width`), tabelas, citação e separador. Qualquer outra marcação HTML sai como TEXTO. Isso mantém
 * a renderização fora da classe "XSS em conteúdo renderizado": nada vira HTML cru, e link e imagem
 * passam por resolvers que decidem o destino (doc interno, asset empacotado, URL https).
 */
import type { ReactNode } from 'react';
import { Fragment } from 'react';

export interface MarkdownResolvers {
  /** Caminho relativo de imagem -> URL do asset empacotado; null = imagem não empacotada (sai como texto). */
  image(src: string): string | null;
  /** Link relativo para outro `.md` -> ação interna; null = abre como link externo (GitLab). */
  docLink(href: string): { onClick: () => void } | null;
  /** Base para links relativos não resolvidos (blob do GitLab). */
  externalBase: string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*\d+\.\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const IMG_TAG = /^<img\b([^>]*)\/?>\s*$/i;
const ATTR = /(\w+)=["']([^"']*)["']/g;
const HTTPS = /^https?:\/\//i;

export function slugify(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Inline: `code`, **bold**, [text](href), ![alt](src). Tudo o mais é texto. */
function inline(text: string, resolvers: MarkdownResolvers, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0; let match: RegExpExecArray | null; let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const k = `${key}-${index++}`;
    if (token.startsWith('`')) out.push(<code key={k}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) out.push(<strong key={k}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('![')) {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token)!;
      out.push(image(m[2], m[1], undefined, resolvers, k));
    } else {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      out.push(link(m[2], m[1], resolvers, k));
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function link(href: string, label: string, resolvers: MarkdownResolvers, key: string): ReactNode {
  if (HTTPS.test(href)) return <a key={key} href={href} target="_blank" rel="noreferrer">{label}</a>;
  // Qualquer outro esquema (javascript:, data:, mailto:) sai como texto: só http(s) e caminho relativo.
  if (OTHER_SCHEME.test(href)) return <span key={key}>{label}</span>;
  const internal = resolvers.docLink(href);
  if (internal) return <a key={key} href="#" onClick={(event) => { event.preventDefault(); internal.onClick(); }}>{label}</a>;
  const target = `${resolvers.externalBase}${href.replace(/^\.\//, '')}`;
  return <a key={key} href={target} target="_blank" rel="noreferrer">{label}</a>;
}

function image(src: string, alt: string, width: string | undefined, resolvers: MarkdownResolvers, key: string): ReactNode {
  const url = HTTPS.test(src) || OTHER_SCHEME.test(src) ? null : resolvers.image(src);
  if (!url) return <span key={key} data-missing-image={src}>[imagem não empacotada: {src}]</span>;
  const w = width && /^\d{2,4}$/.test(width) ? Number(width) : undefined;
  return <img key={key} src={url} alt={alt} style={{ maxWidth: '100%', width: w ? `${w}px` : undefined, height: 'auto', border: '1px solid #e9ebed', borderRadius: 8 }} loading="lazy" />;
}

export interface Heading { level: number; text: string; id: string }

export function headingsOf(markdown: string): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = HEADING.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), id: slugify(m[2]) });
  }
  return out;
}

export function renderMarkdown(markdown: string, resolvers: MarkdownResolvers): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0; let key = 0;
  const next = () => `md-${key++}`;
  const flushParagraph = (buffer: string[]) => {
    if (!buffer.length) return;
    const text = buffer.join(' ').trim();
    if (text) out.push(<p key={next()}>{inline(text, resolvers, `p${key}`)}</p>);
    buffer.length = 0;
  };
  const paragraph: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flushParagraph(paragraph);
      const code: string[] = []; i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1;
      out.push(<pre key={next()} style={{ overflowX: 'auto', background: '#f4f4f4', padding: 12, borderRadius: 8 }}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const level = heading[1].length; const text = heading[2].trim();
      const Tag = (`h${Math.min(level, 6)}`) as 'h1';
      out.push(<Tag key={next()} id={slugify(text)}>{inline(text, resolvers, `h${key}`)}</Tag>);
      i += 1; continue;
    }
    const imgTag = IMG_TAG.exec(line.trim());
    if (imgTag) {
      flushParagraph(paragraph);
      const attrs: Record<string, string> = {};
      for (const m of imgTag[1].matchAll(ATTR)) attrs[m[1].toLowerCase()] = m[2];
      out.push(<p key={next()}>{image(attrs.src ?? '', attrs.alt ?? '', attrs.width, resolvers, `i${key}`)}</p>);
      i += 1; continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      flushParagraph(paragraph);
      const ordered = ORDERED.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? ORDERED : BULLET).test(lines[i])) {
        items.push((ordered ? ORDERED : BULLET).exec(lines[i])![1]);
        i += 1;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !BULLET.test(lines[i]) && !ORDERED.test(lines[i])) { items[items.length - 1] += ` ${lines[i].trim()}`; i += 1; }
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(<List key={next()}>{items.map((item, n) => <li key={n}>{inline(item, resolvers, `l${key}-${n}`)}</li>)}</List>);
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushParagraph(paragraph);
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      out.push(
        <div key={next()} style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr>{head.map((c, n) => <th key={n} style={{ textAlign: 'left', borderBottom: '2px solid #d1d5db', padding: '6px 8px' }}>{inline(c, resolvers, `th${key}-${n}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, rn) => <tr key={rn}>{r.map((c, n) => <td key={n} style={{ borderBottom: '1px solid #e9ebed', padding: '6px 8px', verticalAlign: 'top' }}>{inline(c, resolvers, `td${key}-${rn}-${n}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paragraph);
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      out.push(<blockquote key={next()} style={{ borderLeft: '4px solid #d1d5db', margin: 0, paddingLeft: 12, color: '#5f6b7a' }}>{inline(quote.join(' '), resolvers, `q${key}`)}</blockquote>);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flushParagraph(paragraph); out.push(<hr key={next()} />); i += 1; continue; }
    if (!line.trim()) { flushParagraph(paragraph); i += 1; continue; }
    paragraph.push(line);
    i += 1;
  }
  flushParagraph(paragraph);
  return [<Fragment key="root">{out}</Fragment>];
}
