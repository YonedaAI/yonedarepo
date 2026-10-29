// One search across the repository: matching files and lines, memories, and the commits,
// session records and change requests whose text holds the query's words (searchModel).
import { type FormEvent, useState } from 'react';
import { Failure, Loading } from './SourceStatus';
import { foundNothing, recordSections, type SearchAnswer, searchPath } from './searchModel';
import { formatSourceRoute, type SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

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
  const found = useSource<SearchAnswer>(query.length >= 2 ? searchPath(repo, query) : null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onNavigate({ view: 'search', repo, query: draft.trim() });
  };
  return (
    <section aria-label="Search">
      <form onSubmit={submit} className="source-toolbar" aria-label="Search the repository">
        <label htmlFor="source-search" className="source-version">
          Search code, commits, sessions and changes
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
      {found.data && foundNothing(found.data) && (
        <p className="source-empty">No matches for “{query}”.</p>
      )}
      {found.data &&
        recordSections(repo, found.data).map((section) => (
          <section
            key={section.key}
            aria-labelledby={`search-${section.key}-heading`}
            className="search-records"
          >
            <h3 id={`search-${section.key}-heading`}>
              {section.title} <span className="source-meta">({section.count})</span>
            </h3>
            <ul className="agent-list">
              {section.rows.map((row) => (
                <li key={row.key}>
                  <a
                    href={formatSourceRoute(row.route)}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate(row.route);
                    }}
                  >
                    {row.label}
                  </a>
                  <p className="source-meta">{row.detail}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      {found.data?.memories?.length ? (
        <section aria-labelledby="search-memories-heading" className="search-memories">
          <h3 id="search-memories-heading">Memories</h3>
          <ul className="agent-list">
            {found.data.memories.map((m) => (
              <li key={m.id}>
                <span>
                  <span className="chip">{m.memory.kind}</span>{' '}
                  {m.stale && <span className="chip memory-stale">stale</span>}{' '}
                  <a
                    href={`/source/${repo}/agents/memories`}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate({ view: 'agents', repo, section: 'memories' });
                    }}
                  >
                    #{m.id}
                  </a>
                </span>
                <p className="memory-text">{m.text}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
      {found.data?.results.length ? <h3>Code</h3> : null}
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
