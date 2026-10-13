import { useMemo, useState } from 'react';
import { patchFiles } from './diffModel';

const PAGE_LINES = 2000;
export function SourceDiff({ diff }: { diff: string }) {
  const files = useMemo(() => patchFiles(diff), [diff]);
  const [selection, setSelection] = useState({ diff, index: 0, limit: PAGE_LINES });
  const [wrap, setWrap] = useState(true);
  const index = selection.diff === diff ? Math.min(selection.index, files.length - 1) : 0;
  const file = files[index];
  const limit = selection.diff === diff ? selection.limit : PAGE_LINES;
  const select = (next: number) => setSelection({ diff, index: next, limit: PAGE_LINES });
  if (!file) return <pre className="source-diff">{diff || 'No source changes'}</pre>;
  return (
    <section className="patch-review" aria-label="Review captured changes by file">
      <p className="patch-summary">
        {files.length} changed {files.length === 1 ? 'file' : 'files'} ·{' '}
        <span className="patch-added">+{files.reduce((sum, item) => sum + item.additions, 0)}</span>{' '}
        <span className="patch-removed">
          −{files.reduce((sum, item) => sum + item.deletions, 0)}
        </span>{' '}
        text lines. Each patch is against the frozen base.
      </p>
      <div className="patch-layout">
        <nav className="patch-files" aria-label="Changed files">
          <strong>Changed files</strong>
          {files.map((item, position) => (
            <button
              type="button"
              key={item.path}
              aria-current={position === index ? 'true' : undefined}
              onClick={() => select(position)}
            >
              <span className="patch-path">{item.path}</span>
              <small>
                {item.status} · <span className="patch-added">+{item.additions}</span>{' '}
                <span className="patch-removed">−{item.deletions}</span>
              </small>
            </button>
          ))}
        </nav>
        <div className="patch-file">
          <div className="patch-toolbar">
            <strong>{file.path}</strong>
            <label>
              <input
                type="checkbox"
                checked={wrap}
                onChange={(event) => setWrap(event.target.checked)}
              />{' '}
              Wrap long lines
            </label>
          </div>
          {file.previousPath && (
            <p>
              Renamed from <code>{file.previousPath}</code>.
            </p>
          )}
          <p className="patch-legend">Old line → new line · − removed · + added</p>
          <section aria-label={`Changes in ${file.path}`}>
            <pre className={`source-diff ${wrap ? 'diff-wrap' : ''}`}>
              {file.lines.slice(0, limit).map((line, position) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Patch lines are immutable per captured diff and may repeat.
                <span className={`diff-line diff-${line.kind}`} key={`${position}:${line.kind}`}>
                  <span className="diff-number">
                    {line.old !== undefined && <span className="sr-only">Old line {line.old}</span>}
                    <span aria-hidden="true">{line.old ?? ''}</span>
                  </span>
                  <span className="diff-number">
                    {line.next !== undefined && (
                      <span className="sr-only">New line {line.next}</span>
                    )}
                    <span aria-hidden="true">{line.next ?? ''}</span>
                  </span>
                  <span className="diff-sign" aria-hidden="true">
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                  </span>
                  <span className="diff-text">{line.text || ' '}</span>
                </span>
              ))}
            </pre>
          </section>
          {file.lines.length > limit && (
            <p role="status">
              Showing {limit} of {file.lines.length} patch lines.{' '}
              <button
                type="button"
                className="text-button"
                onClick={() => setSelection({ diff, index, limit: limit + PAGE_LINES })}
              >
                Show more lines
              </button>
            </p>
          )}
          {!file.lines.length && <p>This file has metadata changes only.</p>}
          <div className="patch-pagination">
            <button
              type="button"
              className="quiet"
              disabled={index === 0}
              onClick={() => select(index - 1)}
            >
              Previous file
            </button>
            <span>
              File {index + 1} of {files.length}
            </span>
            <button
              type="button"
              className="quiet"
              disabled={index === files.length - 1}
              onClick={() => select(index + 1)}
            >
              Next file
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
