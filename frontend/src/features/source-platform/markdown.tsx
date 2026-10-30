// A small Markdown reader for READMEs and the site's own pages: headings, paragraphs, lists,
// quotes, fenced code, pipe tables, rules, and inline code, emphasis and links. It builds
// React elements (never HTML strings), so repository content cannot inject markup; only
// http(s) and mailto links are live, plus same-site `/` paths when the caller resolves them.
import type { MouseEvent, ReactNode } from 'react';

/** Props for a same-site link (`/docs/cli`), or nothing to leave it as text. */
export type LinkResolver = (
  path: string,
) => { href: string; onClick: (event: MouseEvent) => void } | undefined;

const SAFE_LINK = /^(https?:|mailto:)/i;
const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|!?\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g;

export function inline(text: string, key = '', link?: LinkResolver): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}${at}`;
    if (m[1]) out.push(<code key={k}>{m[2]}</code>);
    else if (m[3] ?? m[4]) out.push(<strong key={k}>{inline(m[3] ?? m[4], `${k}.`, link)}</strong>);
    else if (m[5] ?? m[6]) out.push(<em key={k}>{inline(m[5] ?? m[6], `${k}.`, link)}</em>);
    else if (m[0].startsWith('!')) out.push(m[7]);
    else if (SAFE_LINK.test(m[8]))
      out.push(
        <a key={k} href={m[8]} target="_blank" rel="noreferrer noopener">
          {inline(m[7], `${k}.`, link)}
        </a>,
      );
    else {
      const local = /^\/(?!\/)/.test(m[8]) ? link?.(m[8]) : undefined;
      if (local)
        out.push(
          <a key={k} {...local}>
            {inline(m[7], `${k}.`, link)}
          </a>,
        );
      else out.push(...inline(m[7], `${k}.`, link));
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; text: string; lang: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'rule' }
  | { kind: 'paragraph'; text: string };

const LIST = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_ROW = /^\s{0,3}\|.*\|\s*$/;
const TABLE_RULE = /^\s{0,3}\|(\s*:?-+:?\s*\|)+\s*$/;
// A row's cells; `\|` stays a literal bar inside a cell.
const cells = (row: string) =>
  row
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll('\\|', '|'));

export function blocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // The fence's info string names the code's language (```sh).
    const fence = /^\s{0,3}(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++)
        body.push(lines[i]);
      out.push({ kind: 'code', text: body.join('\n'), lang: fence[2].toLowerCase() });
      i++;
    } else if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) rows.push(cells(lines[i]));
      out.push({ kind: 'table', head, rows });
    } else if (/^\s{0,3}#{1,6}\s/.test(line)) {
      const [, hashes, text] = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) ?? ['', '#', line];
      out.push({ kind: 'heading', level: hashes.length, text });
      i++;
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: 'rule' });
      i++;
    } else if (LIST.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && LIST.test(lines[i]); i++)
        items.push((LIST.exec(lines[i]) as RegExpExecArray)[2]);
      out.push({ kind: 'list', ordered, items });
    } else if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++)
        body.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
      out.push({ kind: 'quote', text: body.join(' ') });
    } else if (!line.trim()) i++;
    else {
      const body: string[] = [];
      for (
        ;
        i < lines.length &&
        lines[i].trim() &&
        !/^\s{0,3}(#{1,6}\s|```|~~~|>)/.test(lines[i]) &&
        !LIST.test(lines[i]);
        i++
      )
        body.push(lines[i].trim());
      out.push({ kind: 'paragraph', text: body.join(' ') });
    }
  }
  return out;
}

/** A heading's anchor id: lower case, words joined by hyphens. */
export const anchorId = (text: string) =>
  text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * `shift` moves heading levels down (a README's `#` sits under its page's own h1); `link`
 * resolves same-site paths; `anchors` gives each heading an id for `#` links.
 */
export function Markdown({
  source,
  shift = 1,
  link,
  anchors = false,
}: {
  source: string;
  shift?: number;
  link?: LinkResolver;
  anchors?: boolean;
}) {
  // Blocks are positional parts of one immutable document.
  return (
    <>{blocks(source).map((block, n) => renderBlock(block, `b${n}`, { shift, link, anchors }))}</>
  );
}

/** One block as React elements; a page renderer can draw some blocks itself and pass the rest here. */
export function renderBlock(
  block: Block,
  key: string,
  { shift = 1, link, anchors = false }: { shift?: number; link?: LinkResolver; anchors?: boolean },
): ReactNode {
  const text = (value: string, k: string) => inline(value, k, link);
  if (block.kind === 'heading') {
    const Tag = `h${Math.min(block.level + shift, 6)}` as 'h2';
    return (
      <Tag key={key} id={anchors ? anchorId(block.text) : undefined}>
        {text(block.text, key)}
      </Tag>
    );
  }
  if (block.kind === 'table')
    return (
      <div key={key} className="markdown-table">
        <table>
          <thead>
            <tr>
              {block.head.map((cell, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional cells of one row.
                <th key={j} scope="col">
                  {text(cell, `${key}.h${j}.`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional rows of one table.
              <tr key={r}>
                {row.map((cell, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional cells of one row.
                  <td key={j}>{text(cell, `${key}.${r}.${j}.`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  if (block.kind === 'code')
    return (
      <pre key={key}>
        <code>{block.text}</code>
      </pre>
    );
  if (block.kind === 'list') {
    const List = block.ordered ? 'ol' : 'ul';
    return (
      <List key={key}>
        {block.items.map((item, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional items of one list.
          <li key={`${key}.${j}`}>{text(item, `${key}.${j}.`)}</li>
        ))}
      </List>
    );
  }
  if (block.kind === 'quote') return <blockquote key={key}>{text(block.text, key)}</blockquote>;
  if (block.kind === 'rule') return <hr key={key} />;
  return <p key={key}>{text(block.text, key)}</p>;
}
