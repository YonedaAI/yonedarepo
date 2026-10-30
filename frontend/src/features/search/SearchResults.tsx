// What a search found. All repositories: a line of progress, then a group per repository in the
// order they answered, so nothing shown moves; a repository that failed is a notice beside
// them. One repository: its answer alone, as on its own Search tab.
import { linkTo, type Navigate } from '../shell/useRoute';
import { SearchAnswerView } from '../source-platform/SearchAnswerView';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { capNote, matched, type Outcome } from './searchAllModel';
import { searchRoute } from './searchRoute';

function OneRepository({
  query,
  outcome,
  navigate,
  onRetry,
}: {
  query: string;
  outcome: Outcome | undefined;
  navigate: Navigate;
  onRetry: () => void;
}) {
  if (!outcome) return <Loading what="results" />;
  switch (outcome.kind) {
    case 'found':
      return <SearchAnswerView repo={outcome.repo} answer={outcome.answer} onNavigate={navigate} />;
    case 'failed':
      return <Failure error={outcome.error} what="results" onRetry={onRetry} />;
    case 'unreadable':
      return (
        <p className="source-empty">
          This repository has nothing to search yet, or you cannot read it.
        </p>
      );
    case 'none':
      return <p className="source-empty">No matches for “{query}”.</p>;
  }
}

export function SearchResults({
  query,
  within,
  targets,
  capped,
  outcomes,
  names,
  navigate,
  onRetry,
}: {
  query: string;
  /** The one repository searched; otherwise `targets` are all those asked. */
  within?: string;
  targets: string[];
  capped: boolean;
  outcomes: Outcome[];
  names: Map<string, string>;
  navigate: Navigate;
  onRetry: () => void;
}) {
  if (within)
    return (
      <OneRepository query={query} outcome={outcomes[0]} navigate={navigate} onRetry={onRetry} />
    );
  const finished = outcomes.length === targets.length;
  const found = matched(outcomes);
  const failed = outcomes.filter((o) => o.kind === 'failed');
  const name = (repo: string) => names.get(repo) ?? repo;
  const note = finished ? capNote({ capped }) : undefined;
  return (
    <>
      <p className="source-meta search-status" role="status">
        {!finished
          ? `Searching… ${outcomes.length} of ${targets.length} repositories`
          : found.length
            ? `Found in ${found.length} of ${targets.length} repositories.`
            : `No matches for “${query}”.`}
        {note && ` ${note}`}
      </p>
      {failed.length > 0 && (
        <p className="search-failed">
          Couldn’t search{' '}
          {failed.map((o, i) => (
            <span key={o.repo}>
              {i > 0 && ', '}
              <a {...linkTo(searchRoute(query, o.repo), navigate)}>{name(o.repo)}</a>
            </span>
          ))}
          . Open one to try it again.
        </p>
      )}
      {found.map((o) => (
        <section key={o.repo} className="search-repo" aria-label={name(o.repo)}>
          <h2 className="search-repo-name">
            <a {...linkTo(searchRoute(query, o.repo), navigate)}>{name(o.repo)}</a>
          </h2>
          <SearchAnswerView repo={o.repo} answer={o.answer} onNavigate={navigate} />
        </section>
      ))}
    </>
  );
}
