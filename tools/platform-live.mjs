#!/usr/bin/env node
// Live source-platform check against a deployed Worker backed by real Artifacts. It is an
// explicit, separate command (never part of local gates): it creates one repository,
// commits on the server (receive-pack to refs/yoneda/c/<commit> plus readback), diffs,
// approves and lands, then `git clone`s the Artifacts repository once the branch ref is
// projected and checks it holds exactly the landed commit. Credentials come from
// YONEDA_USERNAME / YONEDA_PASSWORD; the clone token travels in Git's environment config.
// Usage: node tools/platform-live.mjs --url https://<deployment>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' } } });
assert.ok(values.url, 'Pass --url of the deployed platform');
const url = values.url.replace(/\/$/, '');
const login = await fetch(`${url}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.YONEDA_USERNAME, password: process.env.YONEDA_PASSWORD }),
});
assert.equal(login.status, 200, 'Login failed; set YONEDA_USERNAME and YONEDA_PASSWORD');
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
async function call(path, body, method) {
  const started = Date.now();
  const response = await fetch(`${url}/api/v1${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  console.log(`${response.status} ${method ?? (body ? 'POST' : 'GET')} ${path} ${Date.now() - started}ms`);
  if (!response.ok) throw new Error(`${path}: ${value.error?.code} ${value.error?.message}`);
  return value;
}
const b64 = (text) => Buffer.from(text).toString('base64');
const author = { name: 'Live check', email: 'live@yonedarepo.invalid' };
const repo = await call('/repos', {
  name: `live-${Date.now()}`,
  policy: { required_checks: [], approvals: 0 },
  files: [{ path: 'README.md', content_b64: b64('# live\n') }],
  author,
});
assert.match((await call(`/repos/${repo.id}`)).object_store, /^artifacts:/);
const commit = await call(`/repos/${repo.id}/commits`, {
  ref: 'main',
  changes: [{ path: 'src/a.txt', content_b64: b64('a\n') }],
  message: 'Live server-side commit',
  author,
});
const diff = await call(`/repos/${repo.id}/diff?head=${commit.commit}&patch=1`);
assert.equal(diff.changes[0].patch, '@@ -0,0 +1 @@\n+a\n');
const landed = await call(`/repos/${repo.id}/land`, { ref: 'main', commit: commit.commit });
assert.equal(landed.version, 2);
// Read-your-writes: a reader passes the version its landing reported.
assert.equal((await call(`/repos/${repo.id}/blob?path=src/a.txt&min_version=${landed.version}`)).content, 'a\n');

// A second commit, landed without being read first: a batched landing, whose Git commit
// the platform builds (an executable file and a nested path exercise modes and trees).
const second = await call(`/repos/${repo.id}/commits`, {
  ref: 'main',
  changes: [
    { path: 'bin/run.sh', content_b64: b64('#!/bin/sh\necho ok\n'), type: 'exec' },
    { path: 'docs/ünïcode.md', content_b64: b64('u\n') },
  ],
  message: 'Live batched commit',
  author,
});
const landedSecond = await call(`/repos/${repo.id}/land`, { ref: 'main', commit: second.commit });
assert.equal(
  (await call(`/repos/${repo.id}/blob?path=bin/run.sh&min_version=${landedSecond.version}`)).executable,
  true,
);

// Any Git client sees the platform's ids: main is projected to the head the API reports
// (the landed commit itself, or the Git commit built for a changeset).
const head = (await call(`/repos/${repo.id}/refs`)).refs['refs/heads/main'];
const access = await call(`/repos/${repo.id}/clone`, {});
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${access.token}`,
};
const git = (args, cwd) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const projectedAt = Date.now();
let remoteMain = '';
while (Date.now() - projectedAt < 120_000) {
  remoteMain = git(['ls-remote', access.remote, 'refs/heads/main']).split(/\s/)[0] ?? '';
  if (remoteMain === head) break;
  await new Promise((r) => setTimeout(r, 2000));
}
assert.equal(remoteMain, head, 'main was not projected to the landed head');
const dir = mkdtempSync(join(tmpdir(), 'yoneda-live-'));
try {
  const started = Date.now();
  git(['clone', '--quiet', access.remote, dir]);
  console.log(`git clone ${Date.now() - started}ms; projection visible after ${started - projectedAt}ms`);
  assert.equal(git(['rev-parse', 'HEAD'], dir), head);
  assert.equal(readFileSync(join(dir, 'src/a.txt'), 'utf8'), 'a\n');
  assert.equal(readFileSync(join(dir, 'docs/ünïcode.md'), 'utf8'), 'u\n');
  assert.equal(git(['ls-files', '-s', 'bin/run.sh'], dir).split(' ')[0], '100755');
  git(['fsck', '--strict'], dir);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true, repo: repo.id, commit: commit.commit, head, cloned: true }));
