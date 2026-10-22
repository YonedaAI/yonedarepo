import { PersonalTokens } from './PersonalTokens';
import { RepoTokens } from './RepoTokens';
import { Failure, Loading } from './SourceStatus';
import type { RepoSummary } from './TokenParts';
import { useSource } from './useSource';

/** Tokens: personal access tokens and per-repository tokens, for the signed-in owner. */
export function TokensPage() {
  const repos = useSource<{ repos: RepoSummary[] }>('/repos');
  return (
    <div className="source-tokens">
      <h1>Tokens</h1>
      {repos.loading && !repos.data && <Loading what="your account" />}
      {repos.error && <Failure error={repos.error} onRetry={repos.reload} />}
      {repos.data && (
        <>
          <PersonalTokens repos={repos.data.repos} />
          <RepoTokens repos={repos.data.repos} />
        </>
      )}
    </div>
  );
}
