// One release: its notes, the tagged commit (and tag message when annotated) and its assets,
// each a download with its size and sha256. The owner attaches assets and deletes the
// release (the tag stays: tags never move or disappear).
import { type FormEvent, useState } from 'react';
import { who } from './changeModel';
import {
  assetHref,
  assetName,
  byteSize,
  type ReleaseAsset,
  type ReleaseDetail,
  releasePath,
  uploadAsset,
} from './releaseModel';
import { Failure, Loading } from './SourceStatus';
import { shortSha, sourceApi, when } from './sourceApi';
import { type Loaded, useSource } from './useSource';

export function AssetList({
  repo,
  tag,
  assets,
}: {
  repo: string;
  tag: string;
  assets: ReleaseAsset[];
}) {
  if (assets.length === 0) return <p className="source-empty">No assets.</p>;
  return (
    <ul className="source-changes" aria-label="Assets">
      {assets.map((a) => (
        <li key={a.name}>
          <a href={assetHref(repo, tag, a.name)} download={a.name}>
            <strong>{a.name}</strong>
          </a>
          <span className="source-meta">
            {byteSize(a.size)} · sha256 <code title={a.sha256}>{a.sha256}</code>
          </span>
        </li>
      ))}
    </ul>
  );
}

function UploadAsset({
  repo,
  tag,
  onUploaded,
}: {
  repo: string;
  tag: string;
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      await uploadAsset(repo, tag, assetName(file.name), file);
      setFile(null);
      onUploaded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="source-token-form" onSubmit={upload} aria-label="Attach an asset">
      <label className="source-field">
        Asset (up to 25 MiB)
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <div className="source-actions">
        <button type="submit" disabled={busy || !file}>
          {busy ? 'Uploading…' : 'Upload asset'}
        </button>
      </div>
      {error && <Failure error={error} />}
    </form>
  );
}

function DeleteRelease({
  repo,
  tag,
  onDeleted,
}: {
  repo: string;
  tag: string;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    setError('');
    try {
      await sourceApi(releasePath(repo, tag), { method: 'DELETE' });
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="source-actions">
      {confirming ? (
        <>
          <span>Delete this release and its assets? The tag stays.</span>
          <button type="button" className="danger" onClick={remove}>
            Delete release
          </button>
          <button type="button" className="quiet" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="quiet" onClick={() => setConfirming(true)}>
          Delete release…
        </button>
      )}
      {error && <Failure error={error} />}
    </div>
  );
}

export function ReleaseBody({
  repo,
  release,
  owner,
  onCommit,
  onChanged,
  onDeleted,
}: {
  repo: string;
  release: Loaded<ReleaseDetail>;
  owner: boolean;
  onCommit: (commit: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  if (release.loading && !release.data) return <Loading what="release" />;
  if (release.error) return <Failure error={release.error} onRetry={release.reload} />;
  const r = release.data;
  if (!r) return null;
  return (
    <article aria-labelledby="release-heading">
      <h2 id="release-heading">{r.title}</h2>
      <p className="source-meta">
        <span className="source-change-status">{r.tag}</span> · {who(r.created_by)} ·{' '}
        {when(r.created_at)}
        {r.commit_id && (
          <>
            {' '}
            ·{' '}
            <a
              href={`#${r.commit_id}`}
              onClick={(e) => {
                e.preventDefault();
                if (r.commit_id) onCommit(r.commit_id);
              }}
            >
              <code>{shortSha(r.commit_id)}</code>
            </a>
          </>
        )}
      </p>
      {r.notes && <p className="source-release-notes">{r.notes}</p>}
      {r.annotated && (
        <section aria-label="Tag message">
          <h3>Tag message</h3>
          <pre>{r.annotated.message}</pre>
          {r.annotated.tagger && (
            <p className="source-meta">
              Tagged by {r.annotated.tagger.name} · tag object{' '}
              <code>{shortSha(r.annotated.id)}</code>
            </p>
          )}
        </section>
      )}
      <h3>Assets</h3>
      <AssetList repo={repo} tag={r.tag} assets={r.assets} />
      {owner && (
        <>
          <UploadAsset repo={repo} tag={r.tag} onUploaded={onChanged} />
          <DeleteRelease repo={repo} tag={r.tag} onDeleted={onDeleted} />
        </>
      )}
    </article>
  );
}

export function ReleaseView({
  repo,
  tag,
  owner,
  onBack,
  onCommit,
}: {
  repo: string;
  tag: string;
  owner: boolean;
  onBack: () => void;
  onCommit: (commit: string) => void;
}) {
  const release = useSource<ReleaseDetail>(releasePath(repo, tag));
  return (
    <section className="source-release">
      <button type="button" className="quiet" onClick={onBack}>
        ← All releases
      </button>
      <ReleaseBody
        repo={repo}
        release={release}
        owner={owner}
        onCommit={onCommit}
        onChanged={release.reload}
        onDeleted={onBack}
      />
    </section>
  );
}
