// Kit item 30's imports (`--import <name>=<source>`, `--import-defaults`): a test repository is
// a public or local Git repository's default branch, pushed with its history as main of a new
// repository of the owner's. The source is cloned bare into the run's private workspace
// (`--no-local` for a path: no hard links, nothing written to the source checkout or its
// remotes); only that clone pushes, with a repository token minted for the push and deleted
// after it. The repository is created empty with no required approvals so the first push can
// create main, and then requires one approval. An existing repository of that name is reused
// as it is. The yonedarepo codebase is never imported (realuser-plan.mjs `importRefusal`).
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { importRefusal } from './realuser-plan.mjs';

/** The source's Git top level when it is a local path, else null. */
async function localTop(ws, source) {
  if (/^https:\/\//.test(source)) return null;
  const path = resolve(source.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  assert.ok(existsSync(path), `${source} does not exist`);
  return realpathSync((await ws.ok('git', ['-C', path, 'rev-parse', '--show-toplevel'])).stdout);
}

/** Imports `{ name, source }` unless the owner has it; returns what it did, with timings. */
export async function importRepo({ ws, owner, root, repos, secrets }, { name, source }) {
  const existing = repos.find((r) => r.name === name);
  if (existing) return { name, id: existing.id, imported: false };
  const top = await localTop(ws, source);
  const refused = importRefusal({ source, sourceTop: top, root: realpathSync(root) });
  assert.ok(!refused, `--import ${name}=${source}: ${refused}`);
  const dir = ws.path(`import-${name}.git`);
  const started = performance.now();
  await ws.ok('git', ['clone', '-q', '--bare', '--single-branch', ...(top ? ['--no-local', top] : [source]), dir]);
  const clone_ms = Math.round(performance.now() - started);
  const branch = (await ws.ok('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir })).stdout;
  const head = (await ws.ok('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout;
  const commits = Number((await ws.ok('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })).stdout);
  const created = await owner.post('/repos', { name, policy: { required_checks: [], approvals: 0 } });
  const tokenName = `realuser-import-${Date.now()}`;
  const minted = await owner.post(`/repos/${created.id}/tokens`, { name: tokenName, scopes: ['read', 'write', 'land'] });
  secrets.add(minted.token);
  let push_ms;
  try {
    const pushed = await ws.ok('git', ['push', '-q', `${ws.api}/git/${created.id}.git`, `refs/heads/${branch}:refs/heads/main`], { cwd: dir, token: minted.token });
    push_ms = pushed.ms;
  } finally {
    await owner.call('DELETE', `/repos/${created.id}/tokens/${tokenName}`);
  }
  assert.equal((await owner.get(`/repos/${created.id}/refs`)).refs['refs/heads/main'], head, `${name}: main is not the pushed ${branch}`);
  await owner.call('PUT', `/repos/${created.id}/policy`, { policy: { required_checks: [], approvals: 1 } });
  return { name, id: created.id, imported: true, source, branch, commits, clone_ms, push_ms };
}
