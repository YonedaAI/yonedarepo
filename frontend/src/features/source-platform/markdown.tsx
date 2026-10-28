// A small Markdown reader for READMEs: headings, paragraphs, lists, quotes, fenced code,
// rules, and inline code, emphasis and links. It builds React elements (never HTML strings),
// so repository content cannot inject markup; only http(s) and mailto links are live.
import type { ReactNode } from 'react';

const SAFE_LINK = /^(https?:|mailto:)/i;
const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|!?\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g;

export function inline(text: string, key = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}${at}`;
    if (m[1]) out.push(<code key={k}>{m[2]}</code>);
    else if (m[3] ?? m[4]) out.push(<strong key={k}>{inline(m[3] ?? m[4], `${k}.`)}</strong>);
    else if (m[5] ?? m[6]) out.push(<em key={k}>{inline(m[5] ?? m[6], `${k}.`)}</em>);
    else if (m[0].startsWith('!')) out.push(m[7]);
    else if (SAFE_LINK.test(m[8]))
      out.push(
        <a key={k} href={m[8]} target="_blank" rel="noreferrer noopener">
          {inline(m[7], `${k}.`)}
        </a>,
      );
    else out.push(...inline(m[7], `${k}.`));
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'paragraph'; text: string };

const LIST = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;

export function blocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s{0,3}(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++)
        body.push(lines[i]);
      out.push({ kind: 'code', text: body.join('\n') });
      i++;
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

export function Markdown({ source }: { source: string }) {
  return (
    <>
      {blocks(source).map((block, n) => {
        // Blocks are positional parts of one immutable document.
        const key = `b${n}`;
        if (block.kind === 'heading') {
          const Tag = `h${Math.min(block.level + 1, 6)}` as 'h2';
          return <Tag key={key}>{inline(block.text, key)}</Tag>;
        }
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
                <li key={`${key}.${j}`}>{inline(item, `${key}.${j}.`)}</li>
              ))}
            </List>
          );
        }
        if (block.kind === 'quote')
          return <blockquote key={key}>{inline(block.text, key)}</blockquote>;
        if (block.kind === 'rule') return <hr key={key} />;
        return <p key={key}>{inline(block.text, key)}</p>;
      })}
    </>
  );
}
