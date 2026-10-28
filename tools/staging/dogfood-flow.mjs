// Kit item 30 (`--dogfood`): the product used the way its owner uses it, on dev.yonedarepo.com,
// signed in as the owner's own account (DEV_OWNER_USERNAME / DEV_OWNER_PASSWORD from the
// environment only; never a signup, never a credential file), against the owner's repository
// holding this codebase (`--dogfood-repo`, default yonedarepo). Steps: 30.1 clones (Git half,
// dogfood-git.mjs), 30.2 everyday Git, 30.3 the change loop, 30.4 reads (dogfood-product.mjs),
// 30.5 sandboxed agents (dogfood-agents.mjs, opt-in). Every write goes to a `dogfood/<ts>-*`
// scratch branch; repository tokens are minted per step and deleted after it. Cleanup always
// runs: changes closed, scratch branches deleted, tokens and the SSH key removed, the session
// signed out; then main and dev of the owner's repository and the host checkouts and remotes
// (`git ls-remote origin`) must be what they were before. Evidence:
// .local/staging/dogfood-<ts>.json (and dogfood-<ts>/ for agent logs), scrubbed of secrets.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostDrift } from './agent-sandbox.mjs';
import { hostState } from './agent-sandbox-host.mjs';
import { Recorder, Session } from './client.mjs';
import { dogfoodAgents } from './dogfood-agents.mjs';
import { dogfoodClones, dogfoodEveryday, Workspace } from './dogfood-git.mjs';
import { leftovers, pickRepo, scratch, scrubber } from './dogfood-plan.mjs';
import { dogfoodChange, dogfoodReads } from './dogfood-product.mjs';

const PROTECTED = ['refs/heads/main', 'refs/heads/dev'];

/** Signs the owner in (never signs up); returns the cookie. */
async function ownerLogin(origin, username, password) {
  const login = await new Session(origin).raw('POST', '/api/auth/login', { username, password });
  assert.equal(login.status, 200, `owner sign-in failed: ${login.body?.error?.code ?? login.status}`);
  return (login.headers.get('set-cookie') ?? '').split(';')[0];
}

/** Runs the dogfood flow; returns the process exit code. `values`: the kit's parsed options. */
export async function dogfood(values, root) {
  const { DEV_OWNER_USERNAME: username, DEV_OWNER_PASSWORD: password } = process.env;
  assert.ok(username && password, 'set DEV_OWNER_USERNAME and DEV_OWNER_PASSWORD (set -a; . ~/.config/yonedarepo/dev-owner.env; set +a)');
  const ts = String(Date.now());
  const secrets = new Set([password]);
  const scrub = scrubber(secrets);
  const cookie = await ownerLogin(values.origin, username, password);
  secrets.add(cookie.split('=').slice(1).join('='));
  const owner = new Session(`${values.origin}/api/v1`, { cookie });
  const rec = new Recorder();
  const evidence = resolve(root, `.local/staging/dogfood-${ts}`);
  mkdirSync(evidence, { recursive: true });
  const ws = new Workspace({ api: values.api, bin: values['cli-bin'] ?? resolve(root, 'target/release'), scrub });
  const tokens = [];
  const ctx = { ws, ts, owner, secrets, evidence, root, changes: [], tag: values['dogfood-tag'] };
  ctx.tokenSession = (token) => new Session(`${ws.api}/api/v1`, { bearer: token });
  ctx.mint = async (step, scopes) => {
    const name = `dogfood-${ts}-${step}`;
    const minted = await owner.post(`/repos/${ctx.repo}/tokens`, { name, scopes });
    secrets.add(minted.token);
    tokens.push(name);
    return minted.token;
  };
  const revoke = async () => {
    // A token leaves the list only once deleted, so cleanup retries what an item could not.
    while (tokens.length) {
      const name = tokens.at(-1);
      const done = await owner.raw('DELETE', `/repos/${ctx.repo}/tokens/${name}`);
      if (!done.ok && done.status !== 404) throw new Error(`token ${name} not deleted: ${done.status}`);
      tokens.pop();
    }
  };
  /** A recorder item whose tokens are deleted when it ends and whose errors are scrubbed. */
  const item = (id, title, run) =>
    rec.step(id, title, async (m) => {
      try {
        return await run(m);
      } catch (e) {
        throw new Error(scrub(e?.message ?? e));
      } finally {
        await revoke().catch((e) => console.error(`Deleting ${id}'s tokens failed (cleanup retries): ${e.message}`));
      }
    });
  let before;
  let protectedBefore;
  try {
    await item('30.0', 'Owner sign-in, repository lookup, host and main/dev snapshot', async (m) => {
      const repo = pickRepo((await owner.get('/repos')).repos, values['dogfood-repo']);
      Object.assign(ctx, { repo: repo.id, platformHealth: await new Session(values.platform).get('/health') });
      Object.assign(m, { repo: repo.id, name: repo.name, front: (await new Session(values.origin).get('/health')).revision, platform: ctx.platformHealth.revision });
      before = await hostState([root, process.cwd(), process.env.PWD]);
      m.host_checkouts = Object.keys(before.checkouts).length;
      m.host_remotes = Object.keys(before.remotes).length;
      const refs = (await owner.get(`/repos/${ctx.repo}/refs`)).refs;
      protectedBefore = Object.fromEntries(PROTECTED.map((r) => [r, refs[r] ?? null]));
      Object.assign(m, { main: protectedBefore['refs/heads/main'], dev: protectedBefore['refs/heads/dev'] });
    });
    if (ctx.repo) {
      await item('30.1', 'Clones: HTTPS full, partial + checkout, shallow + deepen, yoneda::, SSH; fsck', (m) => dogfoodClones(ctx, m));
      await item('30.2', 'Everyday Git: branch, commit, push, pull --rebase over a server commit, cherry-pick, revert, tag, delete', (m) => dogfoodEveryday(ctx, m));
      await item('30.3', 'Change loop: session, open, comment, approval, page data, land on scratch base, server rebase', (m) => dogfoodChange(ctx, m));
      await item('30.4', 'Reads: search, blame, history, Overview, file --at, compare (latency)', (m) => dogfoodReads(ctx, m));
      const agents = Number(values['dogfood-agents'] ?? 0);
      await item('30.5', `Agents: ${agents} sandboxed opencode agents on scratch branches, sessions on their changes`, (m) =>
        dogfoodAgents(ctx, { agents, model: values['agent-model'], timeoutS: Number(values['agent-timeout']), budgetUsd: Number(values['agent-budget']) }, m),
      );
    }
  } finally {
    await rec.step('30.9', 'Cleanup: changes closed, scratch branches deleted, main/dev and host unchanged', (m) => cleanup(ctx, { before, protectedBefore, revoke, root }, m));
    ws.dispose();
    await new Session(values.origin, { cookie }).raw('POST', '/api/auth/logout').catch(() => {});
  }
  const file = resolve(root, `.local/staging/dogfood-${ts}.json`);
  const record = { schema: 1, origin: values.origin, api: values.api, repo: ctx.repo, scratch: `dogfood/${ts}-*`, recorded_at: new Date().toISOString(), items: rec.items };
  writeFileSync(file, `${scrub(JSON.stringify(record, null, 2))}\n`);
  console.log(`\n${scrub(rec.table())}\n\nEvidence: ${file}`);
  return rec.items.some((i) => i.status === 'fail') ? 1 : 0;
}

async function cleanup(ctx, { before, protectedBefore, revoke, root }, m) {
  const { owner, ts } = ctx;
  const problems = [];
  const attempt = async (what, run) => {
    try {
      await run();
    } catch (e) {
      problems.push(`${what}: ${ctx.ws.scrub(e?.message ?? e)}`);
    }
  };
  if (ctx.repo) {
    const path = `/repos/${ctx.repo}`;
    for (const number of ctx.changes)
      await attempt(`close change #${number}`, async () => {
        const done = await owner.raw('POST', `${path}/changes/${number}/close`);
        if (!done.ok && !/is (closed|landed)/.test(done.body?.error?.message ?? '')) throw new Error(`${done.status} ${done.body?.error?.message ?? ''}`);
      });
    m.changes_closed = ctx.changes.join(',') || 'none';
    await attempt('delete scratch branches', async () => {
      const left = leftovers((await owner.get(`${path}/refs`)).refs, ts).filter((l) => l.ref.startsWith('refs/heads/'));
      for (const { ref } of left) scratch(ref, ts);
      if (left.length) await owner.post(`${path}/refs/batch`, { updates: left.map(({ ref, commit }) => ({ ref, commit: null, expected: commit })) });
      m.branches_deleted = left.length;
    });
    await attempt('delete tokens', revoke);
    await attempt('check the platform', async () => {
      const refs = (await owner.get(`${path}/refs`)).refs;
      const left = leftovers(refs, ts);
      m.permanent_tags = left.filter((l) => l.ref.startsWith('refs/tags/')).map((l) => l.ref).join(',') || 'none';
      const branches = left.filter((l) => l.ref.startsWith('refs/heads/'));
      if (branches.length) problems.push(`scratch branches left: ${branches.map((l) => l.ref).join(', ')}`);
      for (const r of PROTECTED)
        if (protectedBefore && refs[r] !== protectedBefore[r]) problems.push(`${r} moved during the run: ${protectedBefore[r]} -> ${refs[r]}`);
      m.main_dev_unchanged = problems.every((p) => !p.includes('moved during the run'));
    });
  }
  if (before)
    await attempt('host recheck', async () => {
      const drift = hostDrift(before, await hostState([root, process.cwd(), process.env.PWD]));
      m.host_unchanged = drift.length === 0;
      if (drift.length) console.error(`\n!!! HOST CHANGED DURING THE DOGFOOD RUN !!!\n${drift.map((d) => `  - ${d}`).join('\n')}\n`);
      problems.push(...drift.map((d) => `HOST CHANGED: ${d}`));
    });
  assert.ok(problems.length === 0, problems.join('; '));
}
