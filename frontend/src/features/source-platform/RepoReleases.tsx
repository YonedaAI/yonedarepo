// The Releases tab: releases (a title, notes and assets attached to a tag), newest first, and
// for the owner a form that publishes one for an existing tag.
import { type FormEvent, useState } from 'react';
import { usePeople } from './people';
import { publishRelease, type Release, releasesPath, tagNames } from './releaseModel';
import { Failure, Loading } from './SourceStatus';
import { shortSha, when } from './sourceApi';
import { type Loaded, useSource } from './useSource';

export function ReleaseTable({
  releases,
  hrefOf,
  onOpen,
}: {
  releases: Loaded<{ releases: Release[] }>;
  hrefOf: (tag: string) => string;
  onOpen: (tag: string) => void;
}) {
  const people = usePeople();
  if (releases.loading && !releases.data) return <Loading what="releases" />;
  if (releases.error) return <Failure error={releases.error} onRetry={releases.reload} />;
  const rows = releases.data?.releases ?? [];
  if (rows.length === 0)
    return (
      <p className="source-empty">
        No releases yet. Push a tag (git tag -a v1 -m … then git push origin v1) and publish a
        release for it.
      </p>
    );
  return (
    <ul className="source-changes" aria-label="Releases" aria-busy={releases.loading}>
      {rows.map((r) => (
        <li key={r.tag}>
          <span className="source-change-status">{r.tag}</span>
          <a
            href={hrefOf(r.tag)}
            onClick={(e) => {
              e.preventDefault();
              onOpen(r.tag);
            }}
          >
            <strong>{r.title}</strong>
          </a>
          <span className="source-meta">
            {r.commit_id && (
              <>
                <code>{shortSha(r.commit_id)}</code> ·{' '}
              </>
            )}
            {people.principal(r.created_by)} · {when(r.created_at)}
            {r.asset_count > 0 && ` · ${r.asset_count} asset${r.asset_count === 1 ? '' : 's'}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The owner's form: an existing tag, a title and notes (POST /releases). */
export function NewReleaseForm({
  repo,
  tags,
  onCreated,
}: {
  repo: string;
  tags: string[];
  onCreated: (release: Release) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const release = await publishRelease(repo, { tag, title, notes });
      setOpen(false);
      onCreated(release);
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
          setTag((t) => t || (tags.at(-1) ?? ''));
          setTitle((t) => t || (tags.at(-1) ?? ''));
          setOpen(true);
        }}
      >
        New release
      </button>
    );
  return (
    <form
      className="source-token-form"
      onSubmit={create}
      aria-label="Publish a release"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      {tags.length === 0 && (
        <p className="source-meta">No tags yet: push one first (git push origin v1).</p>
      )}
      <label className="source-field">
        Tag
        <select value={tag} required onChange={(e) => setTag(e.target.value)}>
          <option value="" disabled>
            Choose a tag
          </option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="source-field">
        Title
        <input value={title} maxLength={200} required onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="source-field">
        Notes
        <textarea value={notes} maxLength={16000} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="source-actions">
        <button type="submit" disabled={busy || !tag || !title.trim()}>
          {busy ? 'Publishing…' : 'Publish release'}
        </button>
        <button type="button" className="quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <Failure error={error} />}
    </form>
  );
}

export function RepoReleases({
  repo,
  owner,
  onOpen,
  hrefOf = () => '#',
}: {
  repo: string;
  /** The owner (or an admin) publishes releases. */
  owner: boolean;
  onOpen: (tag: string) => void;
  hrefOf?: (tag: string) => string;
}) {
  const releases = useSource<{ releases: Release[] }>(releasesPath(repo));
  const refs = useSource<{ refs: Record<string, string> }>(owner ? `/repos/${repo}/refs` : null);
  return (
    <section aria-labelledby="releases-heading">
      <div className="source-changes-head">
        <h2 id="releases-heading">Releases</h2>
        {owner && (
          <NewReleaseForm
            repo={repo}
            tags={tagNames(refs.data?.refs)}
            onCreated={(r) => onOpen(r.tag)}
          />
        )}
      </div>
      <ReleaseTable releases={releases} hrefOf={hrefOf} onOpen={onOpen} />
    </section>
  );
}
