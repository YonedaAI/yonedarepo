// Comments on a change: one comment, a composer, and a line thread with reply and resolve.
import { type FormEvent, useState } from 'react';
import type { Anchor, ChangeComment, Thread } from './changeModel';
import { who } from './changeModel';
import { useReadOnly } from './repoAccess';
import { Failure } from './SourceStatus';
import { shortSha, sourceApi, when } from './sourceApi';

/** The fields POST /changes/:n/comments takes besides the change number. */
export type CommentInput = Partial<Anchor> & { body?: string; resolve?: boolean };

export const postComment = (repo: string, number: number, input: CommentInput) =>
  sourceApi(`/repos/${repo}/changes/${number}/comments`, { body: input });

export function CommentItem({ comment }: { comment: ChangeComment }) {
  return (
    <article className="source-comment" aria-label={`Comment by ${who(comment.principal)}`}>
      <header className="source-meta">
        <strong>{who(comment.principal)}</strong> · {when(comment.at)}
        {comment.resolved_at !== null && ' · resolved'}
      </header>
      <p>{comment.body}</p>
    </article>
  );
}

export function Composer({
  label,
  submit,
  onDone,
  onCancel,
  resolvable = false,
  autoFocus = false,
}: {
  label: string;
  submit: (input: { body?: string; resolve?: boolean }) => Promise<unknown>;
  onDone: () => void;
  onCancel?: () => void;
  resolvable?: boolean;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A public reader reads the conversation but cannot join it.
  const readOnly = useReadOnly();
  async function send(resolve: boolean) {
    setBusy(true);
    setError('');
    try {
      await submit({ body: body.trim() || undefined, resolve: resolve || undefined });
      setBody('');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send(false);
  };
  if (readOnly) return null;
  return (
    <form className="source-composer" onSubmit={onSubmit} aria-label={label}>
      <textarea
        aria-label={label}
        value={body}
        maxLength={8000}
        // biome-ignore lint/a11y/noAutofocus: the composer opens because the user asked for it.
        autoFocus={autoFocus}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && onCancel) onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) void send(false);
        }}
        placeholder="Leave a comment"
      />
      <div className="source-actions">
        <button type="submit" disabled={busy || !body.trim()}>
          {busy ? 'Posting…' : 'Comment'}
        </button>
        {resolvable && (
          <button type="button" className="quiet" disabled={busy} onClick={() => send(true)}>
            {body.trim() ? 'Comment and resolve' : 'Resolve'}
          </button>
        )}
        {onCancel && (
          <button type="button" className="quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {error && <Failure error={error} />}
    </form>
  );
}

/** A thread on one line. Resolved threads start collapsed; outdated ones name their commit. */
export function LineThread({
  thread,
  outdated = false,
  submit,
  onDone,
}: {
  thread: Thread;
  outdated?: boolean;
  submit: (input: CommentInput) => Promise<unknown>;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(!thread.resolved);
  const { anchor } = thread;
  const place = `${anchor.path}:${anchor.line} (${anchor.side === 'old' ? 'base' : 'head'})`;
  const count = `${thread.comments.length} comment${thread.comments.length === 1 ? '' : 's'}`;
  return (
    <section
      className={`source-thread${thread.resolved ? ' source-thread-resolved' : ''}`}
      aria-label={`Thread on ${place}`}
    >
      {(outdated || thread.resolved) && (
        <header className="source-meta">
          {outdated && (
            <>
              <code>{place}</code> at <code>{shortSha(anchor.commit)}</code> (outdated){' · '}
            </>
          )}
          {thread.resolved && `Resolved · ${count} `}
          {thread.resolved && (
            <button
              type="button"
              className="quiet"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'Hide' : 'Show'}
            </button>
          )}
        </header>
      )}
      {open && (
        <>
          {thread.comments.map((c) => (
            <CommentItem key={c.id} comment={c} />
          ))}
          <Composer
            label={`Reply on ${place}`}
            resolvable={!thread.resolved}
            submit={(input) => submit({ ...anchor, ...input })}
            onDone={onDone}
          />
        </>
      )}
    </section>
  );
}
