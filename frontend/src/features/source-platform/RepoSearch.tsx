// One search across the repository: matching files and lines, memories, and the commits,
// session records and change requests whose text holds the query's words (searchModel).
import { type FormEvent, useState } from 'react';
import { SearchAnswerView } from './SearchAnswerView';
import { Failure, Loading } from './SourceStatus';
import { foundNothing, type SearchAnswer, searchPath } from './searchModel';
import type { SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

export function RepoSearch({
  repo,
  query,
  word = false,
  onNavigate,
}: {
  repo: string;
  query: string;
  word?: boolean;
  onNavigate: (r: SourceRoute) => void;
}) {
  const [draft, setDraft] = useState(query);
  const found = useSource<SearchAnswer>(query.length >= 2 ? searchPath(repo, query, word) : null);
  const go = (q: string, w: boolean) =>
    onNavigate(
      w ? { view: 'search', repo, query: q, word: true } : { view: 'search', repo, query: q },
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    go(draft.trim(), word);
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
        <label className="search-word">
          <input
            type="checkbox"
            checked={word}
            onChange={(e) => go(draft.trim() || query, e.target.checked)}
          />
          Whole words
        </label>
      </form>
      {query.length >= 2 && found.loading && <Loading what="results" />}
      {found.error && <Failure error={found.error} onRetry={found.reload} />}
      {found.data && foundNothing(found.data) && (
        <p className="source-empty">No matches for “{query}”.</p>
      )}
      {found.data && <SearchAnswerView repo={repo} answer={found.data} onNavigate={onNavigate} />}
    </section>
  );
}
