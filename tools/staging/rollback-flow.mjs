#!/usr/bin/env node
// A deploy rollback with Landing jobs in the queue, on dev: run by hand beside `cargo xtask
// rollback --env dev`, one step at a time, because the steps around it (pausing the queue, rolling
// back, rolling forward) are the lead's. Reuses the login web-agents-flow.mjs saved.
//
//   node tools/staging/rollback-flow.mjs prepare [--landings 6]   a repository with open Landings
//   node tools/staging/rollback-flow.mjs post 0-2                 passing checks: one job each
//   node tools/staging/rollback-flow.mjs verify                   each landed once, or waits
//   node tools/staging/rollback-flow.mjs cleanup                  deletes the repository
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { b64, Session } from './client.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    landings: { type: 'string', default: '6' },
  },
});
const origin = values.origin.replace(/\/$/, '');
const CHECK = 'rollback-ci';
const author = { name: 'Rollback test', email: 'rollback@yonedarepo.invalid' };
const root = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
const local = join(root, '.local/agents-live');
const stateFile = join(local, 'rollback-state.json');
const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const save = (state) => writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });

/** The owner's API, from the saved login: one session, whatever step this is. */
function owner() {
  const saved = JSON.parse(readFileSync(join(local, 'session.json'), 'utf8'));
  const cookie = saved.cookies.filter((c) => origin.endsWith(c.domain.replace(/^\./, ''))).map((c) => `${c.name}=${c.value}`).join('; ');
  assert.ok(cookie, 'no saved login: run web-agents-flow.mjs first');
  const api = new Session(`${origin}/api/v1`, { cookie });
  const headers = api.headers.bind(api);
  api.headers = (extra = {}) => headers({ origin, ...extra });
  return api;
}

async function prepare(api) {
  assert.ok(!existsSync(stateFile), `${stateFile} exists: cleanup first`);
  const name = `rollback-${Date.now()}`;
  const { id } = await api.post('/repos', { name, policy: { approvals: 0, required_checks: [CHECK] }, files: [{ path: 'README.md', content_b64: b64('# Rollback test\n') }], author });
  const repo = `/repos/${id}`;
  await api.call('PUT', `${repo}/auto-landings`, { create: true, land_when_cleared: true });
  const { token } = await api.post(`${repo}/tokens`, { name: 'rollback-ci', scopes: ['read', 'check', `check:${CHECK}`] });
  const landings = [];
  for (let i = 0; i < Number(values.landings); i++) {
    const { commit } = await api.post(`${repo}/commits`, { ref: 'main', message: `Rollback test ${i}`, author, changes: [{ path: `src/f${i}.js`, content_b64: b64(`export const v${i} = ${i};\n`) }] });
    const moved = await api.post(`${repo}/branches`, { ref: `roll-${i}`, commit, expected: null });
    assert.ok(moved.change, `no Landing opened for roll-${i}`);
    landings.push({ i, number: moved.change, head: commit });
  }
  save({ id, name, token, landings, posted: {} });
  return { repo: id, name, landings: landings.length };
}

/** `2`, or `0-2`. */
function chosen(state, range) {
  const [from, to = from] = String(range).split('-').map(Number);
  return state.landings.filter((l) => l.i >= from && l.i <= to);
}

async function post(range) {
  const state = readState();
  const ci = new Session(`${origin}/api/v1`, { bearer: state.token });
  for (const l of chosen(state, range)) {
    await ci.post(`/repos/${state.id}/commits/${l.head}/checks`, { name: CHECK, status: 'pass' });
    state.posted[l.i] = [...(state.posted[l.i] ?? []), Date.now()];
  }
  save(state);
  return { posted: chosen(state, range).map((l) => l.i) };
}

async function verify(api) {
  const state = readState();
  const repo = `/repos/${state.id}`;
  const status = await api.get(repo);
  const log = (await api.get(`${repo}/txlog?after=0&limit=1000`)).entries;
  const onMain = log.filter((e) => e.refname === 'refs/heads/main');
  const rows = [];
  for (const l of state.landings) {
    const c = await api.get(`${repo}/changes/${l.number}`);
    const landed = (c.clearances ?? []).filter((d) => d.landed_version != null);
    rows.push({
      i: l.i,
      number: l.number,
      posted: state.posted[l.i]?.length ?? 0,
      status: c.status,
      main_entries: onMain.filter((e) => e.new === c.landed_commit || e.new === l.head).length,
      landed_decisions: landed.length,
      last: c.clearances?.[0] ? `${c.clearances[0].decision}: ${(c.clearances[0].reasons ?? []).map((r) => r.code).join(',')}` : 'no decision',
    });
  }
  const landed = rows.filter((r) => r.status === 'landed');
  const twice = rows.filter((r) => r.main_entries > 1 || r.landed_decisions > 1);
  const lost = rows.filter((r) => r.posted && r.status !== 'landed');
  console.table(rows);
  const answer = { landed: landed.length, of: rows.length, landed_twice: twice.length, posted_but_open: lost.length, repo_version: status.version, main_entries: onMain.length };
  writeFileSync(join(local, `rollback-verify-${Date.now()}.json`), JSON.stringify({ answer, rows, tail: log.slice(-30) }, null, 2));
  return answer;
}

async function cleanup(api) {
  const { id, name } = readState();
  await api.call('DELETE', `/repos/${id}?confirm=${encodeURIComponent(name)}`);
  execFileSync('rm', [stateFile]);
  return { deleted: id };
}

const [command, range] = positionals;
const steps = { prepare: () => prepare(owner()), post: () => post(range), verify: () => verify(owner()), cleanup: () => cleanup(owner()) };
assert.ok(steps[command], `steps: ${Object.keys(steps).join(', ')}`);
console.log(JSON.stringify(await steps[command]()));
