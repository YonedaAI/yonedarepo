// Kit item 30, the real-user flow (`--realuser`, alias `--dogfood`): the product used the way a
// person uses it, on dev.yonedarepo.com, signed in as the owner's own account
// (DEV_OWNER_USERNAME / DEV_OWNER_PASSWORD from the environment only; never a signup, never a
// credential file), on "pure" test repositories: open-source histories, never the yonedarepo
// codebase. `--realuser-repo` (default claude-code) gets 30.1 clones (realuser-git.mjs), 30.2
// everyday Git, 30.3 the change loop and 30.4 reads (realuser-product.mjs); 30.5 runs
// sandboxed agents on several repositories at once (realuser-agents.mjs, opt-in); 30.6 the
// agent tools (contracts, pins, bisect; MCP, REST and the browser) on `--agent-tools-repo`
// (realuser-agent-tools.mjs), also alone with `--agent-tools`. `--import
// name=source` and `--import-defaults` first make test repositories (realuser-import.mjs).
// Every write goes to a `realuser/<ts>-*` scratch branch; repository tokens are minted per step
// and deleted after it. Cleanup always runs: changes closed, scratch branches deleted, tokens
// and the SSH key removed, the session signed out; then main and dev of every repository the
// run used, and the host checkouts and remotes (`git ls-remote origin`), must be what they
// were before. Evidence: .local/staging/realuser-<ts>.json (and realuser-<ts>/ for agent
// logs), scrubbed of secrets.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostDrift } from './agent-sandbox.mjs';
import { hostState } from './agent-sandbox-host.mjs';
import { Recorder, Session } from './client.mjs';
import { realuserItems } from './agent-tools-plan.mjs';
import { realuserAgentTools } from './realuser-agent-tools.mjs';
import { realuserAgents } from './realuser-agents.mjs';
import { realuserClones, realuserEveryday, Workspace } from './realuser-git.mjs';
import { importRepo } from './realuser-import.mjs';
import { DEFAULT_IMPORTS, leftovers, parseImports, pickRepo, protectedMoves, scratch, scrubber } from './realuser-plan.mjs';
import { realuserChange, realuserReads } from './realuser-product.mjs';

const PROTECTED = ['refs/heads/main', 'refs/heads/dev'];

/** `repo`'s refs as of its current log version: GET /refs alone is a snapshot up to 2 s old
 * (repo-snapshots.ts), which named branches this run had just deleted as left over. */
async function freshRefs(owner, repo) {
  const { version } = await owner.get(`/repos/${repo}`);
  return (await owner.get(`/repos/${repo}/refs?min_version=${version}`)).refs;
}

/** Deletes this run's scratch branches of `repo` at their current heads (one retry when a
 * head moved in between); returns how many, or throws with the platform's refusal. */
export async function deleteScratch(owner, repo, ts) {
  for (let attempt = 1; ; attempt++) {
    const left = leftovers(await freshRefs(owner, repo), ts).filter((l) => l.ref.startsWith('refs/heads/'));
    for (const { ref } of left) scratch(ref, ts);
    if (!left.length) return 0;
    const done = await owner.raw('POST', `/repos/${repo}/refs/batch`, { updates: left.map(({ ref, commit }) => ({ ref, commit: null, expected: commit })) });
    if (done.ok) return left.length;
    const refusal = `${done.status} ${done.body?.error?.code ?? ''} ${done.body?.error?.message ?? ''}`.trim();
    if (attempt >= 2 || done.body?.error?.code !== 'STALE_HEAD') throw new Error(`refs/batch refused: ${refusal}`);
  }
}

/** Signs the owner in (never signs up); returns the cookie. */
async function ownerLogin(origin, username, password) {
  const login = await new Session(origin).raw('POST', '/api/auth/login', { username, password });
  assert.equal(login.status, 200, `owner sign-in failed: ${login.body?.error?.code ?? login.status}`);
  return (login.headers.get('set-cookie') ?? '').split(';')[0];
}

/** Runs the real-user flow; returns the process exit code. `values`: the kit's parsed options. */
export async function realuser(values, root) {
  const { DEV_OWNER_USERNAME: username, DEV_OWNER_PASSWORD: password } = process.env;
  assert.ok(username && password, 'set DEV_OWNER_USERNAME and DEV_OWNER_PASSWORD (set -a; . ~/.config/yonedarepo/dev-owner.env; set +a)');
  const ts = String(Date.now());
  const secrets = new Set([password]);
  const scrub = scrubber(secrets);
  const cookie = await ownerLogin(values.origin, username, password);
  secrets.add(cookie.split('=').slice(1).join('='));
  const owner = new Session(`${values.origin}/api/v1`, { cookie });
  const rec = new Recorder();
  const evidence = resolve(root, `.local/staging/realuser-${ts}`);
  mkdirSync(evidence, { recursive: true });
  const ws = new Workspace({ api: values.api, bin: values['cli-bin'] ?? resolve(root, 'target/release'), scrub });
  const tokens = [];
  const ctx = { ws, ts, owner, secrets, evidence, root, origin: values.origin, cookie, changes: [], touched: new Set(), tag: values['realuser-tag'] };
  const items = realuserItems(values);
  ctx.touch = (repo) => ctx.touched.add(repo);
  ctx.tokenSession = (token) => new Session(`${ws.api}/api/v1`, { bearer: token });
  ctx.mint = async (step, scopes, repo = ctx.repo) => {
    const name = `realuser-${ts}-${step}`;
    const minted = await owner.post(`/repos/${repo}/tokens`, { name, scopes });
    secrets.add(minted.token);
    tokens.push({ repo, name });
    return minted.token;
  };
  const revoke = async () => {
    // A token leaves the list only once deleted, so cleanup retries what an item could not.
    while (tokens.length) {
      const { repo, name } = tokens.at(-1);
      const done = await owner.raw('DELETE', `/repos/${repo}/tokens/${name}`);
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
  const protectedBefore = new Map();
  let agentRepos = [];
  const imports = [...parseImports(values.import ?? []), ...(values['import-defaults'] ? DEFAULT_IMPORTS : [])];
  try {
    await item('30.0', 'Owner sign-in, live revisions, host snapshot', async (m) => {
      ctx.platformHealth = await new Session(values.platform).get('/health');
      Object.assign(m, { front: (await new Session(values.origin).get('/health')).revision, platform: ctx.platformHealth.revision });
      before = await hostState([root, process.cwd(), process.env.PWD]);
      m.host_checkouts = Object.keys(before.checkouts).length;
      m.host_remotes = Object.keys(before.remotes).length;
    });
    if (before && imports.length)
      await item('30.i', `Imports: ${imports.map((i) => i.name).join(', ')}`, async (m) => {
        const repos = (await owner.get('/repos')).repos;
        for (const one of imports) m[one.name] = await importRepo({ ws, owner, root, repos, secrets }, one);
      });
    if (before)
      await item('30.r', 'Test repositories: lookup, main/dev snapshot', async (m) => {
        const repos = (await owner.get('/repos')).repos;
        const repo = pickRepo(repos, values['realuser-repo']);
        ctx.repo = repo.id;
        ctx.touch(repo.id);
        const named = values['agent-repos']?.split(',').filter(Boolean);
        agentRepos = named ? named.map((n) => pickRepo(repos, n)) : [repo, ...DEFAULT_IMPORTS.map((d) => repos.find((r) => r.name === d.name)).filter(Boolean)];
        const tools = items.tools ? [pickRepo(repos, values['agent-tools-repo'])] : [];
        if (tools.length) {
          ctx.toolsRepo = tools[0].id;
          ctx.touch(tools[0].id);
          m.tools_repo = `${tools[0].name} (${tools[0].id})`;
        }
        for (const r of [repo, ...agentRepos, ...tools]) {
          const { version } = await owner.get(`/repos/${r.id}`);
          const refs = (await owner.get(`/repos/${r.id}/refs`)).refs;
          protectedBefore.set(r.id, { version, refs: Object.fromEntries(PROTECTED.map((p) => [p, refs[p] ?? null])) });
        }
        Object.assign(m, { repo: `${repo.name} (${repo.id})`, agent_repos: agentRepos.map((r) => r.name).join(','), main: protectedBefore.get(repo.id).refs['refs/heads/main'] });
      });
    if (ctx.repo && items.everyday) {
      await item('30.1', 'Clones: HTTPS full, partial + checkout, shallow + deepen, yoneda::, SSH; fsck', (m) => realuserClones(ctx, m));
      await item('30.2', 'Everyday Git: branch, commit, push, pull --rebase over a server commit, cherry-pick, revert, tag, delete', (m) => realuserEveryday(ctx, m));
      await item('30.3', 'Change loop: session, open, comment, approval, page data, land on scratch base, server rebase', (m) => realuserChange(ctx, m));
      await item('30.4', 'Reads: search, blame, history, Overview, file --at and at a commit, compare (latency)', (m) => realuserReads(ctx, m));
    }
    if (ctx.toolsRepo)
      await item('30.6', 'Agent tools: contracts (stale after a change), pins (through a vacuum), bisect (names the breaking commit); MCP, REST and browser', (m) =>
        realuserAgentTools({ ...ctx, repo: ctx.toolsRepo }, m, { headed: values.headed }),
      );
    if (ctx.repo && items.everyday) {
      const perRepo = Number(values['realuser-agents'] ?? 0);
      await item('30.5', `Agents: ${perRepo} per repository on ${agentRepos.length} repositories at once, changes landed on scratch bases`, (m) =>
        realuserAgents(ctx, { repos: agentRepos, perRepo, model: values['agent-model'], timeoutS: Number(values['agent-timeout']), budgetUsd: Number(values['agent-budget']) }, m),
      );
    }
  } finally {
    await rec.step('30.9', 'Cleanup: changes closed, scratch branches deleted, main/dev and host unchanged', (m) => cleanup(ctx, { before, protectedBefore, revoke, root }, m));
    ws.dispose();
    await new Session(values.origin, { cookie }).raw('POST', '/api/auth/logout').catch(() => {});
  }
  const file = resolve(root, `.local/staging/realuser-${ts}.json`);
  const record = { schema: 1, origin: values.origin, api: values.api, repo: ctx.repo, repos: [...ctx.touched], scratch: `realuser/${ts}-*`, recorded_at: new Date().toISOString(), items: rec.items };
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
  // Landed and closed changes stay as they are; only a change still open is closed.
  for (const { repo, number } of ctx.changes)
    await attempt(`close change #${number} of ${repo}`, async () => {
      if ((await owner.get(`/repos/${repo}/changes/${number}`)).status === 'open') await owner.post(`/repos/${repo}/changes/${number}/close`);
    });
  m.changes = ctx.changes.map((c) => `${c.repo}#${c.number}`).join(',') || 'none';
  m.branches_deleted = 0;
  for (const repo of ctx.touched)
    await attempt(`delete scratch branches of ${repo}`, async () => {
      m.branches_deleted += await deleteScratch(owner, repo, ts);
    });
  await attempt('delete tokens', revoke);
  const tags = [];
  const warnings = [];
  for (const [repo, was] of protectedBefore)
    await attempt(`check ${repo}`, async () => {
      const refs = await freshRefs(owner, repo);
      const { entries } = await owner.get(`/repos/${repo}/txlog?after=${was.version}&limit=500`);
      const moved = protectedMoves({ repo, refs: PROTECTED, was: was.refs, now: refs, entries, ts });
      problems.push(...moved.problems);
      warnings.push(...moved.warnings);
      const left = leftovers(refs, ts);
      tags.push(...left.filter((l) => l.ref.startsWith('refs/tags/')).map((l) => `${repo}:${l.ref}`));
      const branches = left.filter((l) => l.ref.startsWith('refs/heads/'));
      if (branches.length) problems.push(`scratch branches left in ${repo}: ${branches.map((l) => l.ref).join(', ')}`);
    });
  m.permanent_tags = tags.join(',') || 'none';
  if (warnings.length) {
    m.warnings = warnings;
    console.warn(`Warning: ${warnings.join('; ')}`);
  }
  m.main_dev_unchanged = problems.every((p) => !p.includes('moved during the run'));
  if (before)
    await attempt('host recheck', async () => {
      const drift = hostDrift(before, await hostState([root, process.cwd(), process.env.PWD]));
      m.host_unchanged = drift.length === 0;
      if (drift.length) console.error(`\n!!! HOST CHANGED DURING THE REAL-USER RUN !!!\n${drift.map((d) => `  - ${d}`).join('\n')}\n`);
      problems.push(...drift.map((d) => `HOST CHANGED: ${d}`));
    });
  assert.ok(problems.length === 0, problems.join('; '));
}
