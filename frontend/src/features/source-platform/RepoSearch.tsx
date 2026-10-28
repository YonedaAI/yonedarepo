import { type FormEvent, useState } from 'react';
import { Failure, Loading } from './SourceStatus';
import type { SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

type Result = { path: string; lines: { line: number; text: string }[] };
type Skipped = { path: string; reason: string };
/** Files not content-searched named in the note; the rest are counted. */
const NAMED = 5;

export function RepoSearch({
  repo,
  query,
  onNavigate,
}: {
  repo: string;
  query: string;
  onNavigate: (r: SourceRoute) => void;
}) {
  const [draft, setDraft] = useState(query);
  const found = useSource<{ results: Result[]; skipped_files: Skipped[]; skipped_count: number }>(
    query.length >= 2
      ? `/repos/${repo}/search?query=${encodeURIComponent(query)}&ignore_case=true`
      : null,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onNavigate({ view: 'search', repo, query: draft.trim() });
  };
  return (
    <section aria-label="Search">
      <form onSubmit={submit} className="source-toolbar" aria-label="Search code">
        <label htmlFor="source-search" className="source-version">
          Search code
          <input
            id="source-search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            minLength={2}
            required
          />
        </label>
        <button type="submit">Search</button>
      </form>
      {query.length >= 2 && found.loading && <Loading what="results" />}
      {found.error && <Failure error={found.error} onRetry={found.reload} />}
      {found.data && found.data.results.length === 0 && (
        <p className="source-empty">No matches for “{query}”.</p>
      )}
      {found.data?.skipped_count ? (
        <p className="source-note">
          Content not searched (matched by path only) for {found.data.skipped_count}{' '}
          {found.data.skipped_count === 1 ? 'file' : 'files'}:{' '}
          {found.data.skipped_files
            .slice(0, NAMED)
            .map((f) => `${f.path} (${f.reason})`)
            .join(', ')}
          {found.data.skipped_count > NAMED ? `, and ${found.data.skipped_count - NAMED} more` : ''}
        </p>
      ) : null}
      {found.data?.results.map((r) => (
        <article key={r.path} className="source-file">
          <header>
            <a
              href={`/source/${repo}/files/${r.path}`}
              onClick={(e) => {
                e.preventDefault();
                onNavigate({ view: 'files', repo, path: r.path, ref: 'main' });
              }}
            >
              <code>{r.path}</code>
            </a>
          </header>
          {r.lines.length > 0 && (
            <pre>{r.lines.map((l) => `${String(l.line).padStart(5)}  ${l.text}`).join('\n')}</pre>
          )}
        </article>
      ))}
    </section>
  );
}
