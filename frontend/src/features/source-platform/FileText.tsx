// A file's text. With `line` (a search result's link) that line is marked and scrolled to; a
// line past the end of the file, which has changed since the link was made, marks nothing.
import { useEffect, useRef } from 'react';

/** `content` around line `line` (1-based), or null when it has no such line. */
export function aroundLine(content: string, line: number) {
  const lines = content.split('\n');
  const target = lines[line - 1];
  if (target === undefined) return null;
  return {
    before: lines.slice(0, line - 1).map((text) => `${text}\n`),
    target,
    after: lines.slice(line).map((text) => `\n${text}`),
  };
}

export function FileText({ content, line }: { content: string; line?: number }) {
  const marked = useRef<HTMLSpanElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new line or text moves the mark.
  useEffect(() => {
    marked.current?.scrollIntoView({ block: 'center' });
  }, [line, content]);
  const parts = line ? aroundLine(content, line) : null;
  if (!parts) return <pre>{content}</pre>;
  return (
    <pre>
      {parts.before.join('')}
      <span className="file-line-target" ref={marked}>
        {parts.target}
      </span>
      {parts.after.join('')}
    </pre>
  );
}
