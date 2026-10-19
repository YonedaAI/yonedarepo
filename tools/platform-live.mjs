#!/usr/bin/env node
// Live source-platform check against a deployed Worker backed by real Artifacts. It is an
// explicit, separate command (never part of local gates): it creates one repository,
// commits on the server (receive-pack to refs/yoneda/c/<commit> plus readback), diffs,
// approves and lands. Credentials come from YONEDA_USERNAME / YONEDA_PASSWORD.
// Usage: node tools/platform-live.mjs --url https://<deployment>
import assert from 'node:assert/strict';
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
assert.equal((await call(`/repos/${repo.id}/blob?path=src/a.txt`)).content, 'a\n');
console.log(JSON.stringify({ ok: true, repo: repo.id, commit: commit.commit }));
