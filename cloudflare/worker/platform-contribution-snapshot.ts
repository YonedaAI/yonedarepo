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
  if (repos.some((repo) => !summaries.get(repo.id)?.snapshot)) return null;
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([account, rows])),
  );
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
