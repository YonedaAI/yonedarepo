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
//   node tools/staging/demo-repos.mjs [--only cobra,commander,click] [--phases ...] [--cap-usd 2.4]
//
// Paid: each pushed head costs two review runs of managed credit, and the run stops before the cap;
// Claude Code stops before CLAUDE_CAP_USD in all. Agents' tokens are the owner's, limited to the one
// repository for a day and revoked at the end. MiMo needs tools/staging/model-proxy deployed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { hostProblems, spendBudget } from './agent-run-flow.mjs';
import { NO_SESSION } from './agent-hooks-flow.mjs';
import { egressAllowlist, sandboxOrigin } from './agent-sandbox.mjs';
import { buildSandbox, dockerAvailable, hostState, modelCredential, startEgress } from './agent-sandbox-host.mjs';
import { accountSession, readEnvFile, Session } from './client.mjs';
import { agentClone, flyAgent, settleLanding } from './demo-repos-run.mjs';
import { AGENTS_BY_KIND, fixPrompt, REPOS, workPrompt } from './demo-repos-plan.mjs';
import { readBack } from './demo-repos-report.mjs';
import { memoryFromPage, openWeb, setUpRepository, writeJson } from './demo-repos-web.mjs';
import { McpClient } from './mcp-client.mjs';
import { judgeTrap } from './memory-plan.mjs';
import { scanHidden } from './memory-run.mjs';
import { TRAPS } from './memory-traps.mjs';
import { Workspace } from './realuser-git.mjs';
import { scrubber } from './realuser-plan.mjs';

const PHASES = ['setup', 'memories', 'smoke', 'clean', 'sloppy', 'fix', 'config', 'suggest', 'suggest2', 'drift', 'approvals', 'approval', 'release', 'report'];
const CLAUDE_CAP_USD = 20;
const GATEWAY = 'https://gateway.ai.cloudflare.com/v1/f011d0ee02b23cad26b4b38151b204ad/yonedarepo-dev-managed-agents';
const MIMO_PROXY = 'https://yonedarepo-dev-model-proxy.mlong-f01.workers.dev';
const { values } = parseArgs({
  options: {
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    api: { type: 'string', default: 'https://api.dev.yonedarepo.com' },
    only: { type: 'string', default: Object.keys(REPOS).join(',') },
    phases: { type: 'string', default: PHASES.join(',') },
    'agent-timeout': { type: 'string', default: '900' },
    'cap-usd': { type: 'string', default: '2.4' },
  },
});
const origin = values.origin.replace(/\/$/, '');
assert.equal(new URL(origin).hostname, 'dev.yonedarepo.com', 'dev only');
const keys = values.only.split(',').map((x) => x.trim());
const phases = values.phases.split(',').map((x) => x.trim());
for (const key of keys) assert.ok(REPOS[key], `--only takes ${Object.keys(REPOS).join(', ')}`);
for (const phase of phases) assert.ok(PHASES.includes(phase), `--phases takes ${PHASES.join(', ')}`);

const root = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
const local = join(root, '.local/demo-repos');
const ts = Date.now();
const evidence = join(local, `run-${ts}`);
mkdirSync(join(local, 'shots'), { recursive: true });
mkdirSync(evidence, { recursive: true });
const stateFile = join(local, 'state.json');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { repos: {} };
const save = () => writeJson(stateFile, state);
const log = (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const sessionFile = join(root, '.local/agents-live/session.json');
const cookie = JSON.parse(readFileSync(sessionFile, 'utf8')).cookies.filter((c) => c.name === 'yoneda_account').map((c) => `${c.name}=${c.value}`).join('; ');
const secrets = new Set([cookie.split('=').slice(1).join('=')]);
const scrub = scrubber(secrets);

/** The owner's cookie session: state-changing calls have to name the site. */
const signedIn = (base) => {
  const session = new Session(base, { cookie });
  const headers = session.headers.bind(session);
  session.headers = (extra) => headers({ origin, ...extra });
  return session;
};
const owner = signedIn(`${origin}/api/v1`);
const account = signedIn(origin);
const ctx = { origin, owner, account, ws: null, evidence, containers: [], egress: {}, timeoutS: Number(values['agent-timeout']), sandboxOrigin: sandboxOrigin(values.api).origin };
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
  secrets.add(minted.token);
  return minted;
};

/** Everything agents and Git need from here on: a run's own clones and tokens. */
async function prepareRepos(rows) {
  for (const r of rows) {
    const minted = await mint(`demo-${r.key}-${ts}`, ['repo:read', 'repo:write'], [r.id]);
    Object.assign(r, { token: minted.token, tokenId: minted.id, base: ctx.ws.path(`base-${r.key}`) });
    await ctx.ws.ok('git', ['clone', '-q', `${ctx.ws.api}/git/${r.id}.git`, r.base], { token: r.token });
    for (const memory of REPOS[r.key].memories.filter((m) => m.trapOf)) await scanHidden({ ws: ctx.ws, scanned: new Map() }, TRAPS.find((t) => t.id === memory.trapOf), r.base);
  }
}

/** The parent's whole main, read with a read-only token, into new repository `id`, once. */
async function pushHistory(key, parent, id) {
  const { ws } = ctx;
  const dir = ws.path(`history-${key}`);
  const reader = await mint(`demo-read-${key}-${ts}`, ['repo:read'], [parent]);
  const writer = await mint(`demo-history-${key}-${ts}`, ['repo:read', 'repo:write'], [id]);
  await ws.ok('git', ['clone', '-q', '--single-branch', '--branch', 'main', `${ws.api}/git/${parent}.git`, dir], { token: reader.token });
  await ws.git(dir, null, 'remote', 'set-url', 'origin', `${ws.api}/git/${id}.git`);
  await ws.ok('git', ['push', '-q', 'origin', 'main'], { cwd: dir, token: writer.token });
  log(`${key}: ${await ws.git(dir, null, 'rev-list', '--count', 'main')} commits of ${state.parents[parent].name} pushed`);
  for (const t of [reader, writer]) await owner.raw('DELETE', `/tokens/${t.id}`);
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
    let repo = (await owner.get('/repos')).repos.find((r) => r.name === name);
    if (!repo) {
      repo = await owner.post('/repos', { name, visibility: 'private', policy: { approvals: 0, required_checks: [] } });
      await pushHistory(key, parent.id, repo.id);
    }
    const made = await setUpRepository(web, { origin, evidence: join(local, 'shots'), name, repo, log });
    state.repos[key] = { flights: {}, ...state.repos[key], id: made.id, parent: parent.id };
    state.managed = made.managed;
  }
  state.credit_before ??= (await account.get(state.managed)).credit.used_usd;
  save();
}

const fileAnchors = (anchors) => anchors.map((a) => a.split('#')[0]);
const anchorBody = (spec) => {
  const [path, symbol] = spec.split('#');
  return symbol ? { path, symbol_path: symbol } : { path };
};

/** One memory by its route; a symbol the platform can't find falls back to its file, and says so. */
async function addMemory(web, r, mcp, memory) {
  const send = (anchors) => {
    if (memory.via === 'web') return memoryFromPage(web, { origin, repo: r.id, kind: memory.kind, text: memory.text, anchors });
    if (memory.via === 'mcp') return mcp.tool('git_memory_add', { repo: r.id, kind: memory.kind, text: memory.text, anchors: anchors.map(anchorBody) });
    return ctx.ws.ok(join(ctx.ws.bin, 'yoneda'), ['memory', 'add', memory.kind, '-m', memory.text, '--anchors', anchors.join(',')], { cwd: r.base, token: r.token, extra: NO_SESSION });
  };
  try {
    await send(memory.anchors);
  } catch (e) {
    if (!memory.anchors.some((a) => a.includes('#'))) throw e;
    (state.notes ??= []).push(`${r.key} ${memory.anchors}: ${scrub(e.message).slice(0, 200)}`);
    await send(fileAnchors(memory.anchors));
  }
}

async function memories(web, r) {
  const plan = REPOS[r.key].memories;
  const have = new Set((await owner.get(`/repos/${r.id}/memories?limit=50`)).memories.map((m) => m.text));
  const mcp = new McpClient(`${values.api}/api/v1/mcp`, r.token);
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo-repos', version: '1' } });
  for (const memory of plan.filter((m) => !have.has(m.text))) {
    await addMemory(web, r, mcp, memory);
    log(`${r.key}: memory by ${memory.via}: ${memory.text.slice(0, 50)}`);
  }
}

const specOf = (key, id) => REPOS[key].flights[id === 'fix' ? 'sloppy' : id];
const wantOf = (key, id) => (id === 'fix' ? 'landed' : specOf(key, id).want);

/** Whether the proof's commit followed the memory: the diff, read through the API. */
async function proofOf(r, spec, settled, base) {
  const { changes } = await owner.get(`/repos/${r.id}/diff?${new URLSearchParams({ base, head: settled.head, patch: '1' })}`);
  return judgeTrap({ oracle: spec.oracle }, { head: settled.head, base, changes });
}

/** One flight of a repository, once. */
async function flight(r, id) {
  const record = state.repos[r.key].flights;
  const want = wantOf(r.key, id);
  if (record[id]?.outcome === want) return log(`${r.key} ${id}: already ${want}`);
  const plan = REPOS[r.key];
  const spec = specOf(r.key, id);
  const kind = spec.agent ?? plan.agent;
  const again = id === 'fix' || record[id]?.number;
  const prompt = id === 'fix' ? fixPrompt(plan, spec, record.sloppy.number) : workPrompt(plan, spec);
  log(`${r.key} ${id}: ${AGENTS_BY_KIND[kind].label} starts on ${spec.branch}`);
  await ctx.egressFor(kind);
  const clone = await agentClone(ctx, r, id, { branch: spec.branch, start: again ? `origin/${spec.branch}` : 'origin/main' });
  const run = await flyAgent(ctx, r, id, kind, clone, prompt);
  log(`${r.key} ${id}: done in ${Math.round(run.ms / 1000)} s, ${run.input} in, ${run.output} out, $${run.usd.toFixed(4)}`);
  const settled = await settleLanding(ctx, r, spec.branch, want);
  record[id] = { ...settled, run, base: clone.base, proof: spec.oracle ? await proofOf(r, spec, settled, clone.base) : undefined };
  save();
  log(`${r.key} ${id}: #${settled.number} ${settled.outcome} (wanted ${want}); slop ${settled.slop.value}, drift ${settled.drift.value}${record[id].proof ? `; proof ${JSON.stringify(record[id].proof)}` : ''}${settled.reasons.length ? `; ${settled.reasons.join(' | ').slice(0, 160)}` : ''}`);
}

/** Each kind answers one word on a clone that pushes nothing, before any real work. */
async function smoke(r, kind) {
  await ctx.egressFor(kind);
  const clone = await agentClone(ctx, r, `smoke-${kind}`, { branch: `smoke-${kind}`, start: 'origin/main' });
  const run = await flyAgent(ctx, r, `smoke-${kind}`, kind, clone, 'Run: yoneda status --brief. Then answer with the single word ok. Change nothing and push nothing.');
  log(`${r.key} smoke ${kind}: ${JSON.stringify(run)}`);
}

async function spendCheck() {
  const { used_usd: used } = (await account.get(state.managed)).credit;
  const spent = used - state.credit_before;
  log(`managed credit spent since the start: $${spent.toFixed(4)}`);
  assert.ok(spent < Number(values['cap-usd']), `spent $${spent.toFixed(4)}, at the cap: stopping`);
}

/** A person's approval is asked for from here on; the second user can give it, the owner can't. */
async function approvals(web, r) {
  const { page } = web;
  await page.goto(`${origin}/source/${r.id}/settings`);
  await page.getByLabel('Approvals needed to land on main').fill('1');
  await page.getByRole('button', { name: /^Save / }).first().click();
  await page.getByText(/^Saved\./).waitFor();
  const reviewer = await secondUser();
  const { members = [] } = await owner.get(`/repos/${r.id}/members`);
  if (!members.some((m) => m.account === reviewer.name)) await owner.post(`/repos/${r.id}/members`, { account: reviewer.name, role: 'land' });
  log(`${r.key}: 1 approval needed, reviewer ${reviewer.name}`);
}

let reviewerSession = null;
async function secondUser() {
  if (reviewerSession) return reviewerSession;
  const file = join(local, 'second-user.json');
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { username: 'flight_reviewer', password: randomBytes(24).toString('hex') };
  writeJson(file, saved);
  secrets.add(saved.password);
  reviewerSession = await accountSession(origin, saved.username, saved.password);
  return reviewerSession;
}

/** Annotated tags by stock Git from the host's clone, and a release by the CLI with its archive. */
async function release(r) {
  const { ws } = ctx;
  const { flights } = state.repos[r.key];
  await ws.git(r.base, r.token, 'fetch', '-q', 'origin');
  const tags = (await ws.git(r.base, null, 'tag')).split('\n');
  if (!tags.includes('flight-1')) await ws.git(r.base, null, 'tag', '-a', 'flight-1', flights.clean.landed_commit, '-m', `First flight: ${REPOS[r.key].flights.clean.message}`);
  if (!tags.includes('flight-2')) await ws.git(r.base, null, 'tag', '-a', 'flight-2', flights.fix.landed_commit, '-m', 'Second flight: the go-around, answered');
  await ws.git(r.base, r.token, 'push', '-q', 'origin', 'refs/tags/flight-1', 'refs/tags/flight-2');
  const { releases } = await owner.get(`/repos/${r.id}/releases`);
  if (releases.some((x) => x.tag === 'flight-2')) return;
  const archive = ws.path(`flight-${r.key}-2.tar.gz`);
  await ws.git(r.base, null, 'archive', '--format=tar.gz', '-o', archive, 'flight-2');
  const notes = [`Landed: ${REPOS[r.key].flights.clean.message} (#${flights.clean.number}) and ${REPOS[r.key].flights.sloppy.message} (#${flights.sloppy.number}), after a go-around.`, 'Tags flight-1 and flight-2 mark each landing.'].join('\n');
  await ws.ok(join(ws.bin, 'yoneda'), ['release', 'create', 'flight-2', '--title', `flight-${r.key} 2`, '-m', notes, '--asset', archive], { cwd: r.base, token: r.token, extra: NO_SESSION });
}

/** Runs `body` on every repository together; a repository's failure leaves the others flying. */
async function eachRepo(rows, what, body) {
  const done = await Promise.allSettled(rows.map(body));
  for (const [i, d] of done.entries())
    if (d.status === 'rejected') {
      const line = `${rows[i].key} ${what}: ${scrub(d.reason?.message ?? String(d.reason)).slice(0, 500)}`;
      (state.errors ??= []).push(line);
      log(`FAILED ${line}`);
    }
  save();
  return done.every((d) => d.status === 'fulfilled');
}

/** The agent's way out, one proxy per kind: the platform and that kind's model route alone. */
ctx.egressFor = (kind) => {
  ctx.starting ??= {};
  ctx.starting[kind] ??= (async () => {
    const hosts = { glm: egressAllowlist({ origin: ctx.sandboxOrigin, model: AGENTS_BY_KIND.glm.model }), mimo: [`${new URL(MIMO_PROXY).hostname}:443`], claude: ['gateway.ai.cloudflare.com:443'], codex: ['gateway.ai.cloudflare.com:443'] }[kind];
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
    for (const entry of JSON.parse(ctx.glmCredential)) for (const v of [entry.value?.key, entry.value?.access]) if (v) secrets.add(v);
  }
  if (kinds.has('mimo')) {
    const token = readFileSync(join(local, 'model-proxy.env'), 'utf8').match(/^PROXY_TOKEN=(.+)$/m)[1];
    secrets.add(token);
    ctx.mimo = { url: MIMO_PROXY, token };
  }
  if (kinds.has('claude') || kinds.has('codex')) {
    const token = readEnvFile('sandbox-ai-gateway.env').CF_AIG_TOKEN;
    secrets.add(token);
    ctx.gateway = { url: GATEWAY, token };
  }
}

async function main() {
  const agentPhases = phases.filter((p) => !['setup', 'memories', 'smoke', 'approvals', 'release', 'report'].includes(p));
  const web = phases.some((p) => ['setup', 'memories', 'approvals'].includes(p)) ? await openWeb({ origin, sessionFile }) : null;
  ctx.ws = new Workspace({ api: values.api, bin: join(root, 'target/release'), scrub });
  try {
    if (phases.includes('setup')) await setup(web);
    assert.ok(state.managed, 'run the setup phase first');
    ctx.managed = state.managed;
    const rows = keys.map((key) => ({ key, ...state.repos[key] }));
    await prepareRepos(rows);
    const kindsOf = (r) => [...new Set([REPOS[r.key].agent, ...REPOS[r.key].order.map((p) => REPOS[r.key].flights[p]?.agent).filter(Boolean)])];
    if (agentPhases.length || phases.includes('smoke')) {
      assert.ok(dockerAvailable(), 'Docker is not available, and agents run only in the sandbox');
      const sandbox = await buildSandbox(dirname(dirname(dirname(import.meta.filename))));
      ctx.image = sandbox.image;
      ctx.budget = spendBudget(Number.POSITIVE_INFINITY);
      await modelCredentials(rows, agentPhases, phases.includes('smoke') ? rows.flatMap(kindsOf) : []);
      log(`sandbox ${sandbox.image.slice(0, 19)}, opencode ${sandbox.opencode}`);
    }
    const watched = [root];
    const before = agentPhases.length ? await hostState(watched) : null;
    try {
      for (const phase of phases) {
        if (phase === 'memories') for (const r of rows) await memories(web, r);
        else if (phase === 'smoke') await eachRepo(rows, phase, async (r) => {
          for (const kind of kindsOf(r)) await smoke(r, kind);
        });
        else if (phase === 'approvals') for (const r of rows) await approvals(web, r);
        else if (agentPhases.includes(phase)) {
          await eachRepo(rows.filter((r) => REPOS[r.key].order.includes(phase)), phase, (r) => flight(r, phase));
          await spendCheck();
        } else if (phase === 'release') await eachRepo(rows, phase, release);
        else if (phase === 'report') {
          state.report = { ...state.report };
          for (const r of rows) state.report[r.key] = await readBack(ctx, r);
          state.report.parents = {};
          for (const [id, was] of Object.entries(state.parents)) {
            const memoriesNow = (await owner.get(`/repos/${id}/memories?limit=50`)).memories.length;
            state.report.parents[was.name] = { refs_unchanged: was.refs === (await parentRefs(id)), memories_unchanged: was.memories === memoriesNow };
          }
          state.report.credit_spent = Number(((await account.get(state.managed)).credit.used_usd - state.credit_before).toFixed(6));
          save();
          console.log(JSON.stringify(state.report, null, 1));
        }
      }
    } finally {
      for (const name of ctx.containers) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      for (const [kind, egress] of Object.entries(ctx.egress)) {
        const stopped = await egress.stop();
        log(`${kind} egress refused: ${[...new Set(stopped.refused)].join(', ') || 'nothing'}`);
      }
      if (before) {
        const drift = await hostProblems(before, watched);
        log(drift.length ? `host changed (other sessions work here too, so read it): ${drift.join('; ')}` : 'host checkout and remotes unchanged');
      }
      for (const r of rows) if (r.tokenId) await owner.raw('DELETE', `/tokens/${r.tokenId}`);
    }
  } finally {
    await web?.close();
    ctx.ws?.dispose();
    save();
  }
}

await main();
