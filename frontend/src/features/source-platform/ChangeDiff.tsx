// The change's diff (merge base to head) with comment threads under the lines they anchor to.
import { useState } from 'react';
import { type CommentInput, Composer, LineThread } from './ChangeThread';
import { type Anchor, anchorKey, rowAnchor, type Thread } from './changeModel';
import { type DiffChange, DiffFiles, type LineRow } from './DiffFiles';

export function ChangeDiff({
  changes,
  head,
  threads,
  classes,
  submit,
  onPosted,
}: {
  changes: DiffChange[];
  /** The head commit new comments anchor to; null leaves the diff read-only. */
  head: string | null;
  threads: Map<string, Thread>;
  classes?: Record<string, string>;
  submit: (input: CommentInput) => Promise<unknown>;
  onPosted: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const anchorOf = (path: string, row: LineRow): Anchor | null =>
    head ? { commit: head, path, ...rowAnchor(row) } : null;
  return (
    <DiffFiles
      changes={changes}
      classes={classes}
      lines={{
        control: (path, row) => {
          const anchor = anchorOf(path, row);
          if (!anchor) return (row.kind === 'delete' ? row.old : row.new) ?? '';
          const where = `${path} line ${anchor.line}${anchor.side === 'old' ? ' (base)' : ''}`;
          return (
            <button
              type="button"
              className="source-line-comment"
              aria-label={`Comment on ${where}`}
              title={`Comment on ${where}`}
              onClick={() => setDraft(anchorKey(anchor))}
            >
              {anchor.line}
            </button>
          );
        },
        below: (path, row) => {
          const key = anchorKey({ path, ...rowAnchor(row) });
          const thread = threads.get(key);
          const anchor = anchorOf(path, row);
          const drafting = draft === key && anchor && !thread;
          if (!thread && !drafting) return null;
          return (
            <tr className="source-thread-row">
              <td colSpan={3}>
                {thread ? (
                  <LineThread thread={thread} submit={submit} onDone={onPosted} />
                ) : (
                  anchor && (
                    <Composer
                      label={`New comment on ${path} line ${anchor.line}`}
                      autoFocus
                      submit={(input) => submit({ ...anchor, ...input })}
                      onDone={() => {
                        setDraft(null);
                        onPosted();
                      }}
                      onCancel={() => setDraft(null)}
                    />
                  )
                )}
              </td>
            </tr>
          );
        },
      }}
    />
  );
}
