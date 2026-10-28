// Large files (Git LFS): what the repository stores and the quota uploads must fit. Stock
// `git lfs` uses the repository's Git URL and token; uploads over the quota are refused
// with an LFS error naming it.
import { type FormEvent, useState } from 'react';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { sourceApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { formatBytes, type LfsUsage, parseQuota, quotaText, usedPercent } from './lfsQuota';

export function LfsSettings({ repo }: { repo: string }) {
  const usage = useSource<LfsUsage>(`/repos/${repo}/lfs`);
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const data = usage.data;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!data) return;
    const parsed = parseQuota(draft ?? quotaText(data.quota_bytes), data.max_quota_bytes);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await sourceApi(`/repos/${repo}/lfs`, { method: 'PUT', body: { quota_bytes: parsed.bytes } });
      setDraft(undefined);
      setSaved(true);
      usage.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="lfs-heading">
      <h2 id="lfs-heading">Large files (LFS)</h2>
      <p className="source-meta">
        Track large files with <code>git lfs track &apos;*.bin&apos;</code>; pushes and clones over
        this repository&apos;s Git URL move them with the same token. Uploads that would pass the
        quota are refused.
      </p>
      {usage.loading && !data && <Loading what="LFS usage" />}
      {usage.error && <Failure error={usage.error} onRetry={usage.reload} />}
      {data && (
        <>
          <dl className="settings-facts">
            <dt>Stored</dt>
            <dd>
              {formatBytes(data.stored_bytes)} in {data.objects}{' '}
              {data.objects === 1 ? 'object' : 'objects'}
            </dd>
            {data.pending_bytes > 0 && (
              <>
                <dt>Reserved by uploads in progress</dt>
                <dd>{formatBytes(data.pending_bytes)}</dd>
              </>
            )}
            <dt>Quota</dt>
            <dd>
              {formatBytes(data.quota_bytes)} ({usedPercent(data)}% used)
            </dd>
            <dt>Largest file</dt>
            <dd>{formatBytes(data.max_object_bytes)}</dd>
          </dl>
          <meter
            aria-label="LFS quota used"
            min={0}
            max={100}
            high={90}
            value={usedPercent(data)}
          />
          <form onSubmit={save} className="source-token-form" aria-label="LFS quota">
            <label htmlFor="lfs-quota" className="source-field">
              Quota (GiB)
              <input
                id="lfs-quota"
                inputMode="decimal"
                value={draft ?? quotaText(data.quota_bytes)}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSaved(false);
                }}
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save quota'}
            </button>
          </form>
          {saved && <p role="status">Quota saved.</p>}
        </>
      )}
      {error && <Failure error={error} />}
    </section>
  );
}
