import { useCallback, useEffect, useState } from 'react';
import { api, short } from '../../lib/api';
export function SiteLink({
  repo,
  evaluation,
  publishedCommit,
}: {
  repo: string;
  evaluation?: string;
  publishedCommit?: string;
}) {
  const [link, setLink] = useState<{ url: string; commit?: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setLink(
        await api(
          `repos/${repo}/${evaluation ? `site_preview?evaluation=${encodeURIComponent(evaluation)}` : 'site'}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [repo, evaluation]);
  useEffect(() => {
    setLink(null);
    if (publishedCommit) void load();
  }, [load, publishedCommit]);
  return (
    <div className="site-link">
      {link ? (
        <a href={link.url} target="_blank" rel="noopener noreferrer">
          {evaluation
            ? 'Open checked preview (valid for 1 hour)'
            : `Open published website · ${short(link.commit ?? '')}`}
        </a>
      ) : evaluation ? (
        <button type="button" className="quiet" disabled={busy} onClick={() => void load()}>
          {busy ? 'Preparing preview…' : 'Preview website'}
        </button>
      ) : null}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
