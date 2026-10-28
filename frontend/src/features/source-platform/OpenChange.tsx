// "Open change" for a branch: propose landing it on main (POST /changes). Main and release
// branches cannot be proposed, and a branch has at most one open change; the server says so.
// On a fork the change may target the parent's main instead (the fork's main too).
import { type FormEvent, useState } from 'react';
import type { Change } from './changeModel';
import { type ChangeTarget, changeRequest } from './forks';
import { Failure } from './SourceStatus';
import { sourceApi } from './sourceApi';

/** A short branch name from a ref, or null when the branch cannot be proposed. */
export function proposable(ref: string): string | null {
  const branch = ref.replace(/^refs\/heads\//, '');
  return branch === 'main' || branch.startsWith('release/') || /^[0-9a-f]{40}$/.test(branch)
    ? null
    : branch;
}

export function OpenChangeButton({
  repo,
  branch: ref,
  parent,
  onOpened,
}: {
  repo: string;
  /** Branch name or `refs/heads/...`; nothing renders for main or a release branch. */
  branch: string;
  /** The parent repository, when `repo` is a fork. */
  parent?: string;
  /** The change and the repository it was opened on. */
  onOpened: (change: Change, repo: string) => void;
}) {
  const local = proposable(ref);
  const branch = local ?? (parent && /^(refs\/heads\/)?main$/.test(ref) ? 'main' : null);
  const [target, setTarget] = useState<ChangeTarget>(local ? 'here' : 'parent');
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!branch) return null;
  const proposed = branch;
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const request = changeRequest(repo, parent, target, { branch: proposed, title, body });
      const change = await sourceApi<Change>(request.path, { body: request.body });
      setOpen(false);
      onOpened(change, request.repo);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <button
        type="button"
        className="quiet"
        onClick={() => {
          setTitle((t) => t || branch.replace(/[-_/]+/g, ' '));
          setOpen(true);
        }}
      >
        Open change
      </button>
    );
  return (
    <form
      className="source-token-form source-open-change"
      onSubmit={create}
      aria-label={`Open a change for ${branch}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <p className="source-meta">
        Propose landing <code>{branch}</code> on <code>main</code>
        {target === 'parent' ? (
          <>
            {' '}
            of the parent <code>{parent}</code>
          </>
        ) : null}
        .
      </p>
      {parent && local && (
        <fieldset className="segmented">
          <legend className="sr-only">Land on</legend>
          {(['here', 'parent'] as const).map((t) => (
            <button key={t} type="button" aria-pressed={target === t} onClick={() => setTarget(t)}>
              {t === 'here' ? 'This repository' : `Parent ${parent}`}
            </button>
          ))}
        </fieldset>
      )}
      <label className="source-field">
        Title
        <input
          value={title}
          maxLength={200}
          required
          // biome-ignore lint/a11y/noAutofocus: the form opens because the user asked for it.
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="source-field">
        Description
        <textarea value={body} maxLength={8000} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="source-actions">
        <button type="submit" disabled={busy || !title.trim()}>
          {busy ? 'Opening…' : 'Open change'}
        </button>
        <button type="button" className="quiet" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <Failure error={error} />}
    </form>
  );
}
