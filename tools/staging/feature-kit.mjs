// What the kit's feature items share: a repository of plain test data made with the kit's token
// and deleted with the kit's others (item 17), a clone of it, work pushed with stock Git through
// the yoneda remote, and a Landing opened on that work.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NO_SESSION } from './agent-hooks-flow.mjs';
import { b64, until } from './client.mjs';
import { repoPath } from './repo-urls.mjs';

export const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };

export const seedFiles = (files) => Object.entries(files).map(([path, text]) => ({ path, content_b64: b64(text) }));

/** A repository named `<prefix>-<ms>` whose `path(rest)` is its API path. `extra`: more of the
 * create's fields (`visibility`, `owner`). */
export async function kitRepo(kit, prefix, { approvals = 0, files = { 'README.md': `# ${prefix}\n` }, ...extra } = {}) {
  const name = `${prefix}-${Date.now()}`;
  const { id } = await kit.pat().post('/repos', { name, policy: { approvals, required_checks: [] }, files: seedFiles(files), author, ...extra });
  kit.repos.push({ id, name });
  return { id, name, path: (rest = '') => `/repos/${id}${rest}` };
}

/** A clone of `repo` at `kit.path(label)`. */
export async function cloneOf(kit, repo, label) {
  const dir = kit.path(label);
  await kit.ok('git', ['clone', '-q', kit.remote(repo.id), dir], { env: kit.env(NO_SESSION) });
  return dir;
}

export function writeInto(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** Commits `files` in `dir` and pushes `branch` (cut from `from` unless it is already checked
 * out at `from: null`); answers the commit. */
export async function pushWork(kit, dir, { branch, files, message, from = 'origin/main', env = kit.env(NO_SESSION) }) {
  if (from) {
    await kit.ok('git', ['fetch', '-q', 'origin'], { cwd: dir, env });
    await kit.gitOk(dir, 'switch', '-q', '-C', branch, from);
  }
  writeInto(dir, files);
  await kit.gitOk(dir, 'add', '-A');
  await kit.gitOk(dir, 'commit', '-qm', message);
  await kit.ok('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir, env });
  return kit.gitOk(dir, 'rev-parse', 'HEAD');
}

/** Work on `branch` with a Landing open on it; answers `{ number, head }`. */
export async function landingOn(kit, repo, dir, { branch, title, files, message = title }) {
  const head = await pushWork(kit, dir, { branch, files, message });
  const { number } = await kit.pat().post(repo.path('/changes'), { branch, title });
  return { number, head };
}

/** The repository's own page at `rest`. */
export async function openPage(page, { origin, account }, repo, rest = '') {
  await page.goto(`${origin}${await repoPath(account, repo.id)}${rest}`);
}

/** The body's error code of a refused call, with its status. */
export const refusal = (answer) => `${answer.status} ${answer.body?.error?.code ?? ''}`.trim();

/** `read` once it answers truthy: reads may come from a copy a moment old. */
export const settled = (read, what, timeoutMs = 15_000) => until(read, { timeoutMs, intervalMs: 500, what });

export function noLeak(answer, secret, what) {
  assert.ok(!JSON.stringify(answer.body ?? {}).includes(secret), `${what} leaks ${secret}`);
}
