#!/usr/bin/env node
// Deploy prod's first step: is the commit on main a merged ship PR, and which Ship run tested
// it? Fork pull requests run in this repository too and can upload an artifact of any name, so
// evidence counts only from a successful Ship run of this repository's dev at the PR's head.
// Writes `ship`, `pr_head` and `run_id` to $GITHUB_OUTPUT.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKFLOW = '.github/workflows/ship.yml';
const LOOKUPS = 3;

/** The merged dev-to-main PR of this repository that made `sha`, if any. */
export const shipPull = (pulls, { repo, sha }) =>
  pulls.find((p) => p.merged_at && p.merge_commit_sha === sha && p.base?.ref === 'main' && p.head?.ref === 'dev' && p.head?.repo?.full_name === repo);

/** The newest successful Ship run of this repository's dev at `head`, if any. */
export const shipRun = (runs, { repo, head }) =>
  runs
    .filter(
      (r) =>
        r.event === 'pull_request' &&
        r.conclusion === 'success' &&
        r.head_sha === head &&
        r.head_branch === 'dev' &&
        r.head_repository?.full_name === repo &&
        (r.path === WORKFLOW || r.path?.startsWith(`${WORKFLOW}@`)),
    )
    .sort((a, b) => b.run_number - a.run_number)[0];

/** `{ ship: false }`, `{ ship: true, pr_head, run_id }`, or throws why a ship has no run. */
export async function findShip({ fetch, sleep, token, repo, sha }) {
  const api = async (path) => {
    const answer = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    });
    if (!answer.ok) throw new Error(`GitHub answered ${answer.status} for ${path.split('?')[0]}`);
    return answer.json();
  };
  let pull;
  // The commit-to-PR index can lag the push by a moment.
  for (let attempt = 1; attempt <= LOOKUPS && !pull; attempt++) {
    if (attempt > 1) await sleep(10_000);
    pull = shipPull(await api(`commits/${sha}/pulls?per_page=20`), { repo, sha });
  }
  if (!pull) return { ship: false };
  const head = pull.head.sha;
  const { workflow_runs: runs } = await api(`actions/workflows/ship.yml/runs?head_sha=${head}&event=pull_request&status=success&per_page=20`);
  const run = shipRun(runs, { repo, head });
  if (!run) throw new Error(`No successful Ship run at ${head.slice(0, 12)}: run the ship, or re-run this once it passes.`);
  return { ship: true, pr_head: head, run_id: run.id };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { GH_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output } = process.env;
  try {
    const found = await findShip({ fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), token, repo, sha });
    appendFileSync(output, Object.entries(found).map(([k, v]) => `${k}=${v}\n`).join(''));
    if (!found.ship && event === 'workflow_dispatch') throw new Error(`${sha.slice(0, 12)} is not a merged ship PR.`);
    console.log(found.ship ? `Ship PR head ${found.pr_head.slice(0, 12)}, run ${found.run_id}.` : '::notice::Not a merged ship PR: nothing deploys.');
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exit(1);
  }
}
