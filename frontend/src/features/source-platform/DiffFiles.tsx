// The files of a diff (git_diff's `changes`) with numbered patch rows. Commit pages render it
// as is; change pages pass `lines` to put a comment button on each line and threads under it.
import { Fragment, type ReactNode, useState } from 'react';
import { type PatchRow, patchRows } from './patchRows';

export type DiffChange = {
  path: string;
  op: string;
  patch?: string;
  binary?: boolean;
  too_large?: boolean;
  additions?: number;
  deletions?: number;
};

export type LineRow = Extract<PatchRow, { kind: 'context' | 'add' | 'delete' }>;

/** Per-line hooks: a control in the line-number cell and content shown under the row. */
export type LineHooks = {
  control: (path: string, row: LineRow) => ReactNode;
  below: (path: string, row: LineRow) => ReactNode;
};

const NOISE = new Set(['docs', 'formatting', 'comment_only']);

export function DiffFiles({
  changes,
  classes = {},
  lines,
}: {
  changes: DiffChange[];
  classes?: Record<string, string>;
  lines?: LineHooks;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  if (changes.length === 0) return <p className="source-empty">No file changes.</p>;
  return (
    <div className="source-diff">
      {changes.map((change) => (
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
                    <Fragment key={i}>
                      <tr className={`source-patch-${row.kind}`}>
                        <td className="source-line">{row.old ?? ''}</td>
                        <td className="source-line">
                          {lines ? lines.control(change.path, row) : (row.new ?? '')}
                        </td>
                        <td>
                          <span aria-hidden>
                            {row.kind === 'add' ? '+' : row.kind === 'delete' ? '−' : ' '}
                          </span>
                          {row.text}
                        </td>
                      </tr>
                      {lines?.below(change.path, row)}
                    </Fragment>
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
