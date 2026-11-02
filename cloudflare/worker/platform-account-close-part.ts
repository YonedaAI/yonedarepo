// What deleting an account takes in one cell: its repositories there, their forks, and what
// refuses. The account's own steps are platform-account-close.ts.

import { holdSwitch } from './platform-legal-hold';
import { inBatches } from './repo-git-objects';
import { askedFor, importRunning } from './repo-import-start';
import { caller } from './repo-ops';
import type { Env } from './types';
import { workspace } from './workspace';

const WIDTH = 6;

export type Row = { id: string; name: string };

/** Why this account can't be deleted now, and what to do. */
export type Refusal = { reason: 'hold' | 'org' | 'import' | 'forks'; message: string };

const ownedRepos = async (env: Env, account: string) =>
  (
    await env.INDEX.prepare('SELECT id,name FROM platform_repos WHERE workspace=?')
      .bind(account)
      .all<Row>()
  ).results;

/** Each repository's live forks. */
const forksOf = async (env: Env, repos: Row[]) =>
  new Map(
    await inBatches(repos, WIDTH, async ({ id }) => {
      const { forks } = await caller(env, id, { _system: 'fork' })({ op: 'repo_fork_list' });
      return [id, forks as string[]] as const;
    }),
  );

async function holdRefusal(env: Env, account: string, repos: Row[]): Promise<Refusal[]> {
  if ('_hold' in holdSwitch(env)) return [];
  const asked = [undefined, ...repos.map((r) => r.id)];
  const answers = await inBatches(asked, WIDTH, (repo) =>
    workspace(env, account, { op: 'hold_check', ...(repo && { repo }) }),
  );
  if (!answers.some((a) => a.held !== false)) return [];
  return [{ reason: 'hold', message: 'A legal hold applies to this account. Contact support.' }];
}

async function importRefusals(env: Env, repos: Row[]): Promise<Refusal[]> {
  const running = await inBatches(repos, WIDTH, async (repo) => {
    const asked = await askedFor(env, repo.id);
    return asked && (await importRunning(env, repo.id, asked)) ? repo : null;
  });
  return running.flatMap((repo) =>
    repo
      ? [{ reason: 'import', message: `${repo.name} is still importing. Wait for it to finish.` }]
      : [],
  ) as Refusal[];
}

function forkRefusals(repos: Row[], forks: Map<string, string[]>): Refusal[] {
  const own = new Set(repos.map((r) => r.id));
  return repos
    .filter((repo) => (forks.get(repo.id) ?? []).some((fork) => !own.has(fork)))
    .map((repo) => ({
      reason: 'forks',
      message: `${repo.name} has forks by other people. They read it, so ask them to delete them.`,
    }));
}

/** What deleting `account` takes in this cell. */
export async function closurePart(env: Env, account: string) {
  const repos = await ownedRepos(env, account);
  const forks = await forksOf(env, repos);
  const refusals = [
    ...(await holdRefusal(env, account, repos)),
    ...(await importRefusals(env, repos)),
    ...forkRefusals(repos, forks),
  ];
  return { repos, forks, refusals };
}
