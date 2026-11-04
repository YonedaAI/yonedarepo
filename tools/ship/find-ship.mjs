#!/usr/bin/env node
// Deploy prod's first step: is the commit on main a merged ship PR, and what was its head? Any
// other push deploys nothing. xtask then requires the head's successful release CI (xtask/src/deploy_ship.rs),
// so a wrong answer here can only stop a deploy, never allow one.
// Writes `ship` and `pr_head` to $GITHUB_OUTPUT.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOOKUPS = 3;

/** The merged dev-to-main PR of this repository that made `sha`, if any. */
export const shipPull = (pulls, { repo, sha }) =>
  pulls.find((p) => p.merged_at && p.merge_commit_sha === sha && p.base?.ref === 'main' && p.head?.ref === 'dev' && p.head?.repo?.full_name === repo);

/** `{ ship: false }` or `{ ship: true, pr_head }`. */
export async function findShip({ fetch, sleep, token, repo, sha }) {
  for (let attempt = 1; attempt <= LOOKUPS; attempt++) {
    // The commit-to-PR index can lag the push by a moment.
    if (attempt > 1) await sleep(10_000);
    const answer = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/pulls?per_page=20`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    });
    if (!answer.ok) throw new Error(`GitHub answered ${answer.status} for the commit's pull requests`);
    const pull = shipPull(await answer.json(), { repo, sha });
    if (pull) return { ship: true, pr_head: pull.head.sha };
  }
  return { ship: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { GH_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output } = process.env;
  try {
    const found = await findShip({ fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), token, repo, sha });
    appendFileSync(output, Object.entries(found).map(([k, v]) => `${k}=${v}\n`).join(''));
    if (!found.ship && event === 'workflow_dispatch') throw new Error(`${sha.slice(0, 12)} is not a merged ship PR.`);
    console.log(found.ship ? `Ship PR head ${found.pr_head.slice(0, 12)}.` : '::notice::Not a merged ship PR: nothing deploys.');
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exit(1);
  }
}
