// Bind drill-down to the server-held chart summaries, never caller-supplied cutoffs.
import type { ListedRepo, RepoActivity } from './platform-account-activity';

export async function contributionSnapshot(
  account: string,
  repos: ListedRepo[],
  summaries: Map<string, RepoActivity>,
) {
  const rows = [...repos]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((repo) => {
      const summary = summaries.get(repo.id);
      return [repo.id, summary?.since, summary?.snapshot, summary?.commits];
    });
  // Only summaries that supply chart counts need authority cutoffs. Unread or
  // empty legacy summaries remain part of the hash, so their later refresh still
  // invalidates the clicked chart without blocking unrelated known contributions.
  if (
    repos.some((repo) => {
      const summary = summaries.get(repo.id);
      return summary?.commits.some(([, count]) => count > 0) && !summary.snapshot;
    })
  )
    return null;
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([account, rows])),
  );
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
