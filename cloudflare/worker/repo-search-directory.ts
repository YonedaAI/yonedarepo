// The search directory's adapter (`search:<owner>`, accounts/search_directory.rs), behind
// ACCOUNT_SEARCH. A directory only narrows a search across repositories, so nothing here ever
// fails what called it: a change that can't reach it logs and moves on, and a row it left
// behind is void at worst, or unreachable once the repository is unlisted.
import { caller } from './repo-ops';
import type { Env } from './types';
import { searchDirectory } from './workspace';

export const accountSearchOn = (env: Env) => env.ACCOUNT_SEARCH === 'on';

const warned = (e: any) => console.warn(`search directory: ${e?.message ?? e}`);

/** Who owns `repo`: the account its directory belongs to. A tombstone still says. */
export async function ownerOf(env: Env, repo: string) {
  const { owner } = await caller(env, repo, { _system: 'purge' })({ op: 'repo_hold_owner' });
  return String(owner);
}

/** Summaries of `repo` read before now are forgotten: its readers or its readable content
 * changed. Its next derive writes a new one. */
export async function voidSummary(env: Env, repo: string) {
  if (!accountSearchOn(env)) return;
  await ownerOf(env, repo)
    .then((owner) => searchDirectory(env, owner, { op: 'search_void', repo }))
    .catch(warned);
}

/** `repo` is gone; `owner` when the caller already knows it. */
export async function dropSummary(env: Env, repo: string, owner?: string) {
  if (!accountSearchOn(env)) return;
  await Promise.resolve(owner ?? ownerOf(env, repo))
    .then((account) => searchDirectory(env, account, { op: 'search_drop', repo }))
    .catch(warned);
}

/** A new fork of `owner`'s holds what its parent does, until it has activity of its own. */
export async function markFork(env: Env, owner: string, repo: string) {
  if (!accountSearchOn(env)) return;
  await searchDirectory(env, owner, { op: 'search_fork', repo, at: Date.now() }).catch(warned);
}
