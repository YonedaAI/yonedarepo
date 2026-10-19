import { useState } from 'react';
import { patchRows } from './patchRows';
import { Failure, Loading } from './SourceStatus';
import { useSource } from './useSource';

type Change = {
  path: string;
  op: string;
  patch?: string;
  binary?: boolean;
  too_large?: boolean;
  additions?: number;
  deletions?: number;
};

const NOISE = new Set(['docs', 'formatting', 'comment_only']);

export function CommitDiff({
  repo,
  commit,
  classes = {},
}: {
  repo: string;
  commit: string;
  classes?: Record<string, string>;
}) {
  const diff = useSource<{ changes: Change[] }>(`/repos/${repo}/diff?head=${commit}&patch=1`);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  if (diff.error) return <Failure error={diff.error} onRetry={diff.reload} />;
  if (!diff.data) return <Loading what="changes" />;
  if (diff.data.changes.length === 0) return <p className="source-empty">No file changes.</p>;
  return (
    <div className="source-diff">
      {diff.data.changes.map((change) => (
        <section key={change.path} aria-label={`${change.op} ${change.path}`}>
          <header>
            <span className={`source-op source-op-${change.op}`}>{change.op}</span>
            <code>{change.path}</code>
            {classes[change.path] && (
              <span className={`source-class source-class-${classes[change.path]}`}>
                {classes[change.path].replace('_', ' ')}
              </span>
            )}
            {change.additions !== undefined && (
              <span className="source-stats">
                +{change.additions} −{change.deletions}
              </span>
            )}
          </header>
          {NOISE.has(classes[change.path]) && !expanded.has(change.path) ? (
            <p className="source-empty">
              Collapsed: no code changes here.{' '}
              <button
                type="button"
                className="quiet"
                onClick={() => setExpanded((current) => new Set(current).add(change.path))}
              >
                Show diff
              </button>
            </p>
          ) : null}
          {change.binary && <p className="source-empty">Binary file changed.</p>}
          {change.too_large && <p className="source-empty">File is too large to show a diff.</p>}
          {change.patch && (!NOISE.has(classes[change.path]) || expanded.has(change.path)) && (
            <table className="source-patch">
              <tbody>
                {patchRows(change.patch).map((row, i) =>
                  row.kind === 'hunk' || row.kind === 'note' ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: patch rows are positional and immutable.
                    <tr key={i} className={`source-patch-${row.kind}`}>
                      <td colSpan={3}>{row.text}</td>
                    </tr>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: patch rows are positional and immutable.
                    <tr key={i} className={`source-patch-${row.kind}`}>
                      <td className="source-line">{row.old ?? ''}</td>
                      <td className="source-line">{row.new ?? ''}</td>
                      <td>
                        <span aria-hidden>
                          {row.kind === 'add' ? '+' : row.kind === 'delete' ? '−' : ' '}
                        </span>
                        {row.text}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}
