#!/usr/bin/env node
// Three repositories that stay in the dev owner's account, full of real work, so the Flight Path,
// memory and context pages have something to show. Each holds the history of a real repository in
// the account (not a fork: review agents can't clone a fork yet), set up through the pages a person
// uses (demo-repos-web.mjs); memories arrive by web, CLI and MCP; stock agents in the Docker sandbox
// build a real feature (demo-repos-plan.mjs) and the real managed review agents read it. Dev only.
// It deletes no repository and changes no parent: their refs are compared at the end. Every step
// reads .local/demo-repos/state.json, so a rerun carries on.
//
//   set -a; . ~/.config/yonedarepo/dev-owner.env; set +a
//   node tools/staging/demo-repos.mjs [--only cobra,commander,click] [--phases ...] [--cap-usd 2.9]
//
// Paid: each pushed head costs two review runs of managed credit, and the run stops before the cap;
// Claude Code stops before CLAUDE_CAP_USD in all. Agents' tokens are the owner's, limited to the one
// repository for a day and revoked at the end.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { hostProblems, spendBudget } from './agent-run-flow.mjs';
import { egressAllowlist, sandboxOrigin } from './agent-sandbox.mjs';
import { buildSandbox, dockerAvailable, hostState, modelCredential, startEgress } from './agent-sandbox-host.mjs';
import { readEnvFile, Session } from './client.mjs';
import { DemoTokens, finishDemoRun, removeOwnedContainer } from './demo-repos-acceptance.mjs';
import { demoFlights } from './demo-repos-flights.mjs';
import { DemoGuards } from './demo-repos-guards.mjs';
import { AGENTS_BY_KIND, REPOS } from './demo-repos-plan.mjs';
import { readBack } from './demo-repos-report.mjs';
import { openWeb, setUpRepository, writeJson } from './demo-repos-web.mjs';
import { scanHidden } from './memory-run.mjs';
import { TRAPS } from './memory-traps.mjs';
import { ownerLogin } from './realuser-flow.mjs';
import { Workspace } from './realuser-git.mjs';
import { scrubber } from './realuser-plan.mjs';

const PHASES = ['setup', 'memories', 'smoke', 'clean', 'sloppy', 'fix', 'config', 'sloppy2', 'fix2', 'config2', 'suggest', 'suggest2', 'drift', 'strict', 'sloppy3', 'relax', 'fix3', 'approvals', 'approval', 'release', 'report'];
const CLAUDE_CAP_USD = 20;
const GATEWAY = 'https://gateway.ai.cloudflare.com/v1/f011d0ee02b23cad26b4b38151b204ad/yonedarepo-dev-managed-agents';
const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    api: { type: 'string', default: 'https://api.dev.yonedarepo.com' },
    only: { type: 'string', default: Object.keys(REPOS).join(',') },
    phases: { type: 'string', default: PHASES.join(',') },
    'agent-timeout': { type: 'string', default: '2400' },
    'cap-usd': { type: 'string', default: '2.9' },
  },
});
const origin = values.origin.replace(/\/$/, '');
assert.equal(new URL(origin).hostname, 'dev.yonedarepo.com', 'dev only');
const keys = values.only.split(',').map((x) => x.trim());
const phases = values.phases.split(',').map((x) => x.trim());
for (const key of keys) assert.ok(REPOS[key], `--only takes ${Object.keys(REPOS).join(', ')}`);
for (const phase of phases) assert.ok(PHASES.includes(phase), `--phases takes ${PHASES.join(', ')}`);
assert.ok(Number.isSafeInteger(Number(values['agent-timeout'])) && Number(values['agent-timeout']) > 0, '--agent-timeout must be a positive integer');
assert.ok(Number.isFinite(Number(values['cap-usd'])) && Number(values['cap-usd']) > 0, '--cap-usd must be positive');
assert.ok(Number(values['cap-usd']) <= 2.9, 'the original demo cap is $2.90');

if (values['dry-run']) {
  console.log(JSON.stringify({ repositories: keys, phases, models: Object.fromEntries(Object.entries(AGENTS_BY_KIND).map(([kind, agent]) => [kind, agent.model])), managed_cap_usd: Number(values['cap-usd']), claude_cap_usd: CLAUDE_CAP_USD }));
  process.exit(0);
}

const root = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
const local = join(root, '.local/demo-repos');
const ts = Date.now();
const evidence = join(local, `run-${ts}`);
mkdirSync(join(local, 'shots'), { recursive: true });
mkdirSync(evidence, { recursive: true });
const stateFile = join(local, 'state.json');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { repos: {} };
/** One driver flies each repository at a time: each writes only what is its own. */
const save = () => {
  const now = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : state;
  for (const key of keys) if (state.repos[key]) now.repos[key] = state.repos[key];
  if (state.report) now.report = { ...now.report, ...state.report };
  for (const name of ['parents', 'managed', 'credit_before', 'notes']) if (state[name] !== undefined) now[name] = state[name];
  now.errors = [...new Set([...(now.errors ?? []), ...(state.errors ?? [])])];
  now.claude_usd = Math.max(now.claude_usd ?? 0, state.claude_usd ?? 0);
  writeJson(stateFile, now);
};
const log = (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const sessionFile = join(root, '.local/agents-live/session.json');
/** The saved login, renewed by one sign-in when it has lapsed, so a rerun is no new session. */
async function savedCookie() {
  const saved = JSON.parse(readFileSync(sessionFile, 'utf8'));
  const row = saved.cookies.find((c) => c.name === 'yoneda_account');
  const live = await new Session(origin, { cookie: `${row.name}=${row.value}` }).raw('GET', '/api/auth/session');
  if (!live.body?.authenticated) {
    const { DEV_OWNER_USERNAME: username, DEV_OWNER_PASSWORD: password } = process.env;
    assert.ok(username && password, 'set -a; . ~/.config/yonedarepo/dev-owner.env; set +a');
    row.value = (await ownerLogin(origin, username, password)).split(';')[0].split('=').slice(1).join('=');
    writeJson(sessionFile, saved);
  }
  return `${row.name}=${row.value}`;
}
let cookie = await savedCookie();
const secrets = new Set([cookie.split('=').slice(1).join('=')]);
const scrub = scrubber(secrets);

/** The owner's cookie session: state-changing calls have to name the site. */
const signedIn = (base) => {
  const session = new Session(base, { cookie });
  const headers = session.headers.bind(session);
  session.headers = (extra) => headers({ origin, cookie, ...extra });
  const raw = session.raw.bind(session);
  // Other tools sign in as the owner too, so a long run can outlive its login.
  session.raw = async (...args) => {
    const first = await raw(...args);
    if (first.status !== 401) return first;
    cookie = await savedCookie();
    secrets.add(cookie.split('=').slice(1).join('='));
    return raw(...args);
  };
  return session;
};
const owner = signedIn(`${origin}/api/v1`);
const account = signedIn(origin);
const ctx = { api: values.api, origin, owner, account, ws: null, evidence, containers: [], egress: {}, timeoutS: Number(values['agent-timeout']), sandboxOrigin: sandboxOrigin(values.api).origin };
ctx.guards = new DemoGuards({ account, owner, managed: state.managed, baseline: state.credit_before, capUsd: Number(values['cap-usd']) });
ctx.tokens = new DemoTokens(owner);
ctx.claudeSpent = (usd) => {
  state.claude_usd = Number(((state.claude_usd ?? 0) + usd).toFixed(4));
  save();
};
/** What the next Claude Code run may spend: a run stops itself at this. */
ctx.claudeBudget = () => {
  const left = CLAUDE_CAP_USD - (state.claude_usd ?? 0) - 1;
  assert.ok(left > 0.5, `Claude Code has spent $${state.claude_usd}, at its cap`);
  return Math.min(6, Number(left.toFixed(2)));
};

const mint = async (name, scopes, repos) => {
  const minted = await owner.post('/tokens', { name, scopes, repos, expires_days: 1 });
  ctx.tokens.track(`/tokens/${minted.id}`);
  secrets.add(minted.token);
  return minted;
};

/** Everything agents and Git need from here on: a run's own clones and tokens. */
async function prepareRepos(rows) {
  for (const r of rows) {
    const minted = await mint(`demo-${r.key}-${ts}`, ['repo:read', 'repo:write'], [r.id]);
    Object.assign(r, { token: minted.token, tokenId: minted.id, base: ctx.ws.path(`base-${r.key}`) });
    await ctx.ws.ok('git', ['clone', '-q', `${ctx.ws.api}/git/${r.id}.git`, r.base], { token: r.token });
    // Once a Landing has landed, the rule is in the history because the agent followed it.
    const untouched = !(await owner.get(`/repos/${r.id}/changes?status=landed`)).changes.length;
    if (untouched) for (const memory of REPOS[r.key].memories.filter((m) => m.trapOf)) await scanHidden({ ws: ctx.ws, scanned: new Map() }, TRAPS.find((t) => t.id === memory.trapOf), r.base);
  }
}

/** The parent's whole main, read with a read-only token, into new repository `id`, once. */
async function pushHistory(key, parent, id) {
  const { ws } = ctx;
  const dir = ws.path(`history-${key}`);
  const reader = await mint(`demo-read-${key}-${ts}`, ['repo:read'], [parent]);
  const writer = await owner.post(`/repos/${id}/tokens`, { name: `demo-history-${ts}`, scopes: ['read', 'write', 'land'] });
  ctx.tokens.track(`/repos/${id}/tokens/demo-history-${ts}`);
  secrets.add(writer.token);
  await ws.ok('git', ['clone', '-q', '--single-branch', '--branch', 'main', `${ws.api}/git/${parent}.git`, dir], { token: reader.token });
  await ws.git(dir, null, 'remote', 'set-url', 'origin', `${ws.api}/git/${id}.git`);
  const rules = (await owner.get(`/repos/${id}`)).policy;
  await owner.call('PUT', `/repos/${id}/policy`, { policy: { ...rules, approvals: 0, required_checks: [] } });
  try { await ws.ok('git', ['push', '-q', 'origin', 'main'], { cwd: dir, token: writer.token }); }
  finally { await owner.call('PUT', `/repos/${id}/policy`, { policy: rules }); }
  log(`${key}: ${await ws.git(dir, null, 'rev-list', '--count', 'main')} commits of ${state.parents[parent].name} pushed`);
  await ctx.tokens.revoke(`/tokens/${reader.id}`);
  await ctx.tokens.revoke(`/repos/${id}/tokens/demo-history-${ts}`);
  rmSync(dir, { recursive: true, force: true });
}

const parentRefs = async (id) => {
  const { version } = await owner.get(`/repos/${id}`);
  return JSON.stringify((await owner.get(`/repos/${id}/refs?min_version=${version}`)).refs);
};

async function setup(web) {
  const repos = (await owner.get('/repos')).repos;
  state.parents ??= {};
  for (const key of keys) {
    const parent = repos.find((r) => r.name === `oss-${key}`);
    assert.ok(parent, `no oss-${key}`);
    state.parents[parent.id] ??= { name: parent.name, refs: await parentRefs(parent.id), memories: (await owner.get(`/repos/${parent.id}/memories?limit=50`)).memories.length };
    const name = `flight-${key}`;
    // Empty, so history can be main: the New repository dialog seeds a first commit.
    const repo = (await owner.get('/repos')).repos.find((r) => r.name === name) ?? (await owner.post('/repos', { name, visibility: 'private', policy: { approvals: 0, required_checks: [] } }));
    if (!(await owner.get(`/repos/${repo.id}/refs`)).refs['refs/heads/main']) await pushHistory(key, parent.id, repo.id);
    const made = await setUpRepository(web, { origin, evidence: join(local, 'shots'), name, repo, log });
    state.repos[key] = { flights: {}, ...state.repos[key], id: made.id, parent: parent.id };
    state.managed = made.managed;
  }
  state.credit_before ??= (await account.get(state.managed)).credit.used_usd;
  save();
}

const { specOf, memories, flight, smoke, spendCheck, approvals, release, eachRepo } = demoFlights({ ctx, state, local, owner, save, scrub, log, origin, account, sessionFile, renew: async () => { cookie = await savedCookie(); }, capUsd: Number(values['cap-usd']), secrets, stamp: ts });

/** The agent's way out, one proxy per kind: the platform and that kind's model route alone. */
ctx.egressFor = (kind) => {
  ctx.starting ??= {};
  ctx.starting[kind] ??= (async () => {
    const hosts = { glm: egressAllowlist({ origin: ctx.sandboxOrigin, model: AGENTS_BY_KIND.glm.model }), claude: ['gateway.ai.cloudflare.com:443'], codex: ['gateway.ai.cloudflare.com:443'] }[kind];
    const allow = [...new Set([...egressAllowlist({ origin: ctx.sandboxOrigin }), ...hosts])].sort();
    ctx.egress[kind] = await startEgress({ image: ctx.image, allow, run: `demo${ts}${kind}` });
    log(`${kind} egress: ${allow.join(', ')}`);
  })();
  return ctx.starting[kind];
};

/** Keys in memory only, for the kinds these phases fly. */
async function modelCredentials(rows, agentPhases, also) {
  const kinds = new Set([...also, ...rows.flatMap((r) => agentPhases.filter((p) => REPOS[r.key].order.includes(p)).map((p) => specOf(r.key, p).agent ?? REPOS[r.key].agent))]);
  if (kinds.has('glm')) {
    ctx.glmCredential = await modelCredential(AGENTS_BY_KIND.glm.model, ctx.ws.dir);
    ctx.glmKey = JSON.parse(ctx.glmCredential).map(entry => entry.value?.key ?? entry.value?.access).find(Boolean);
    assert.ok(ctx.glmKey, 'The coding-plan credential has no key');
    for (const entry of JSON.parse(ctx.glmCredential)) for (const v of [entry.value?.key, entry.value?.access]) if (v) secrets.add(v);
  }
  if (kinds.has('claude') || kinds.has('codex')) {
    const token = readEnvFile('sandbox-ai-gateway.env').CF_AIG_TOKEN;
    secrets.add(token);
    ctx.gateway = { url: GATEWAY, token };
  }
}

async function run() {
  const agentPhases = phases.filter((p) => !['setup', 'memories', 'smoke', 'strict', 'relax', 'approvals', 'release', 'report'].includes(p));
  const web = phases.some((p) => ['setup', 'memories'].includes(p)) ? await openWeb({ origin, sessionFile }) : null;
  ctx.ws = new Workspace({ api: values.api, bin: join(root, 'target/release'), scrub });
  try {
    if (phases.includes('setup')) await setup(web);
    assert.ok(state.managed, 'run the setup phase first');
    ctx.managed = state.managed;
    Object.assign(ctx.guards, { managed: state.managed, baseline: state.credit_before });
    const rows = keys.map((key) => ({ key, ...state.repos[key] }));
    const watched = [root, process.cwd(), process.env.PWD];
    let before = null;
    try {
      await prepareRepos(rows);
      const kindsOf = (r) => [...new Set([REPOS[r.key].agent, ...REPOS[r.key].order.map((p) => REPOS[r.key].flights[p]?.agent).filter(Boolean)])];
      if (agentPhases.length || phases.includes('smoke')) {
        assert.ok(dockerAvailable(), 'Docker is not available, and agents run only in the sandbox');
        const sandbox = await buildSandbox(dirname(dirname(dirname(import.meta.filename))));
        ctx.image = sandbox.image;
        ctx.budget = spendBudget(Number.POSITIVE_INFINITY);
        await modelCredentials(rows, agentPhases, phases.includes('smoke') ? rows.flatMap(kindsOf) : []);
        log(`sandbox ${sandbox.image.slice(0, 19)}, opencode ${sandbox.opencode}`);
        before = await hostState(watched);
      }
      for (const phase of phases) {
        if (phase === 'memories') for (const r of rows) await memories(web, r);
        else if (phase === 'smoke') await eachRepo(rows, phase, async (r) => {
          for (const kind of kindsOf(r)) await smoke(r, kind);
        });
        else if (phase === 'strict' || phase === 'relax') {
          for (const r of rows) {
            if (phase === 'strict') await ctx.guards.slop(r.id, 'medium');
            else await ctx.guards.relax(r.id);
          }
        } else if (phase === 'approvals') {
          cookie = await savedCookie();
          const late = await openWeb({ origin, sessionFile });
          try {
            for (const r of rows) await ctx.guards.approvals(r.id, () => approvals(late, r));
          } finally {
            await late.close();
          }
        }
        else if (agentPhases.includes(phase)) {
          await eachRepo(rows.filter((r) => REPOS[r.key].order.includes(phase)), phase, (r) => flight(r, phase));
          await spendCheck();
        } else if (phase === 'release') await eachRepo(rows, phase, release);
        else if (phase === 'report') {
          state.report = { ...state.report };
          for (const r of rows) state.report[r.key] = await readBack(ctx, r, state.repos[r.key]);
          state.report.parents = {};
          for (const [id, was] of Object.entries(state.parents)) {
            const memoriesNow = (await owner.get(`/repos/${id}/memories?limit=50`)).memories.length;
            state.report.parents[was.name] = { refs_unchanged: was.refs === (await parentRefs(id)), memories_unchanged: was.memories === memoriesNow };
          }
          state.report.claude_usd = state.claude_usd ?? 0;
          state.report.credit_spent = Number(((await account.get(state.managed)).credit.used_usd - state.credit_before).toFixed(6));
          save();
          console.log(JSON.stringify(state.report, null, 1));
        }
      }
    } finally {
      await finishDemoRun({
        clean: [
          ...ctx.containers.map(name => async () => removeOwnedContainer(name)),
          ...Object.entries(ctx.egress).map(([kind, egress]) => async () => {
            const stopped = await egress.stop();
            log(`${kind} egress refused: ${[...new Set(stopped.refused)].join(', ') || 'nothing'}`);
            assert.ok(!stopped.died, 'An agent egress proxy stopped unexpectedly');
          }),
          ...ctx.tokens.cleanup(),
          ...Object.entries(state.parents ?? {}).map(([id, was]) => async () => { assert.equal(await parentRefs(id), was.refs, 'A retained parent repository changed during the demo'); }),
        ],
        check: async () => {
          const drift = before ? await hostProblems(before, watched) : [];
          if (before && drift.length === 0) log('host checkout and remotes unchanged');
          return drift;
        },
      });
    }
  } finally {
    try { await finishDemoRun({ clean: ctx.tokens.cleanup(), check: async () => [] }); }
    finally { await web?.close(); ctx.ws?.dispose(); save(); }
  }
}

await ctx.guards.run(run);
