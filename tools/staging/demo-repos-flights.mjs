// Resumable demo flights, memory evidence, approvals and release readback.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_SESSION } from './agent-hooks-flow.mjs';
import { accountSession } from './client.mjs';
import { assertFlight } from './demo-repos-acceptance.mjs';
import { agentClone, flyAgent, landingOn, settleLanding, usageOf, verdictOn } from './demo-repos-run.mjs';
import { approveHeldFlight } from './demo-repos-approval.mjs';
import { AGENTS_BY_KIND, fixPrompt, REPOS, workPrompt } from './demo-repos-plan.mjs';
import { memoryFromPage, writeJson } from './demo-repos-web.mjs';
import { McpClient } from './mcp-client.mjs';
import { judgeTrap } from './memory-plan.mjs';

export function demoFlights({ ctx, state, local, owner, save, scrub, log, origin, account, sessionFile, renew, capUsd, secrets, stamp }) {
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
  const mcp = new McpClient(`${ctx.api}/api/v1/mcp`, r.token);
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo-repos', version: '1' } });
  for (const memory of plan.filter((m) => !have.has(m.text))) {
    await addMemory(web, r, mcp, memory);
    log(`${r.key}: memory by ${memory.via}: ${memory.text.slice(0, 50)}`);
  }
}

const FIXES = { fix: 'sloppy', fix2: 'sloppy2', fix3: 'sloppy3' };
const specOf = (key, id) => REPOS[key].flights[FIXES[id] ?? id];
const wantOf = (key, id) => (FIXES[id] ? 'landed' : specOf(key, id).want);

/** Whether the proof's commit followed the memory: the diff, read through the API. */
async function proofOf(r, spec, settled, base) {
  const { changes } = await owner.get(`/repos/${r.id}/diff?${new URLSearchParams({ base, head: settled.head, patch: '1' })}`);
  return judgeTrap({ oracle: spec.oracle }, { head: settled.head, base, changes });
}

/** A flight whose agent pushed before the driver stopped: its usage from the run's own evidence. */
function usageFromEvidence(key, id, kind) {
  const files = readdirSync(local).filter((d) => d.startsWith('run-')).sort().reverse().map((d) => join(local, d, `${key}-${id}.events.jsonl`));
  const file = files.find((f) => existsSync(f));
  return file ? { kind, ms: 0, ...usageOf(kind, readFileSync(file, 'utf8').split('\n')) } : { kind, ms: 0 };
}

/** The open or landed Landing a first run already pushed, if any: it is settled, not flown again. */
async function pushedBefore(r, id, spec) {
  if (spec.continues || state.repos[r.key].flights[id]) return null;
  const was = state.repos[r.key].flights[FIXES[id]]?.head;
  if (FIXES[id]) return (await owner.get(`/repos/${r.id}/changes?status=open`)).changes.find((c) => c.branch === spec.branch && c.head !== was) ?? null;
  for (const status of ['open', 'landed']) {
    const found = (await owner.get(`/repos/${r.id}/changes?status=${status}`)).changes.find((c) => c.branch === spec.branch);
    if (found) return found;
  }
  return null;
}

/** One flight of a repository, once. */
async function flight(r, id) {
  const record = state.repos[r.key].flights;
  const want = wantOf(r.key, id);
  const plan = REPOS[r.key];
  const spec = specOf(r.key, id);
  const verify = () => assertFlight(record[id], { want, proof: Boolean(spec.oracle) });
  if (record[id]?.outcome === want) { verify(); if (id === 'approval') await approve(r, record[id]); return log(`${r.key} ${id}: already ${want}`); }
  const kind = spec.agent ?? plan.agent;
  if (await pushedBefore(r, id, spec)) {
    const settled = await settleLanding(ctx, r, spec.branch, want);
    const [{ parents }] = (await owner.get(`/repos/${r.id}/log?ref=${encodeURIComponent(spec.branch)}&limit=1`)).commits;
    record[id] = { ...settled, run: usageFromEvidence(r.key, id, kind), base: parents?.[0] ?? null, proof: spec.oracle ? await proofOf(r, spec, settled, parents[0]) : undefined };
    save();
    verify();
    if (id === 'approval') await approve(r, record[id]);
    return log(`${r.key} ${id}: adopted #${settled.number} ${settled.outcome} (wanted ${want}); slop ${settled.slop.value}, drift ${settled.drift.value}; proof ${JSON.stringify(record[id].proof ?? null)}`);
  }
  const again = FIXES[id] || spec.continues || record[id]?.number;
  const prompt = FIXES[id] ? fixPrompt(plan, spec, record[FIXES[id]].number) : workPrompt(plan, spec);
  const reserved = await ctx.guards.reserve(r.id);
  await ctx.guards.suppress(r.id);
  log(`${r.key} ${id}: reserving up to $${reserved.worst_usd.toFixed(4)} for reviews; $${reserved.remaining_usd.toFixed(4)} remains`);
  log(`${r.key} ${id}: ${AGENTS_BY_KIND[kind].label} starts on ${spec.branch}`);
  await ctx.egressFor(kind);
  const clone = await agentClone(ctx, r, id, { branch: spec.branch, start: again ? `origin/${spec.branch}` : 'origin/main' });
  const run = await flyAgent(ctx, r, id, kind, clone, prompt);
  log(`${r.key} ${id}: done in ${Math.round(run.ms / 1000)} s, ${run.input} in, ${run.output} out, ${AGENTS_BY_KIND[kind].rates ? `$${run.usd.toFixed(4)} estimated` : 'coding plan; no dollar quote'}`);
  const opened = await landingOn(ctx, r, spec.branch);
  await ctx.guards.review(r.id, opened);
  const settled = await settleLanding(ctx, r, spec.branch, want);
  record[id] = { ...settled, run, base: clone.base, proof: spec.oracle ? await proofOf(r, spec, settled, clone.base) : undefined };
  save();
  verify();
  await ctx.guards.complete(r.id, { ...settled, branch: spec.branch });
  record[id].review_trigger = 'owner_exact_head';
  record[id].review_reservation = reserved;
  if (id === 'approval') {
    await approve(r, record[id]);
    await ctx.guards.complete(r.id, { ...record[id].approval.after, head: settled.head, branch: spec.branch });
  }
  save();
  log(`${r.key} ${id}: #${settled.number} ${settled.outcome} (wanted ${want}); slop ${settled.slop.value}, drift ${settled.drift.value}${record[id].proof ? `; proof ${JSON.stringify(record[id].proof)}` : ''}${settled.reasons.length ? `; ${settled.reasons.join(' | ').slice(0, 160)}` : ''}`);
}

async function approve(r, held) {
  if (held.approval?.after?.status === 'landed') return;
  held.approval = await approveHeldFlight({ owner, reviewer: await secondUser(), held, repo: r.id, origin,
    wait: () => verdictOn(ctx, r, held.number, held.head, 'landed') });
  save();
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
  assert.ok(spent < capUsd, `spent $${spent.toFixed(4)}, at the cap: stopping`);
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
  // Tags and releases need land, which no agent's token holds: a token for this step alone.
  const name = `demo-tags-${stamp}`;
  const tagger = await owner.post(`/repos/${r.id}/tokens`, { name, scopes: ['read', 'write', 'land'] });
  const tokenPath = `/repos/${r.id}/tokens/${name}`;
  ctx.tokens.track(tokenPath);
  secrets.add(tagger.token);
  try {
    await ws.git(r.base, tagger.token, 'push', '-q', 'origin', 'refs/tags/flight-1', 'refs/tags/flight-2');
    if ((await owner.get(`/repos/${r.id}/releases`)).releases.some((x) => x.tag === 'flight-2')) return;
    const archive = ws.path(`flight-${r.key}-2.tar.gz`);
    await ws.git(r.base, null, 'archive', '--format=tar.gz', '-o', archive, 'flight-2');
    const notes = [`Landed: ${REPOS[r.key].flights.clean.message} (#${flights.clean.number}) and ${REPOS[r.key].flights.sloppy.message} (#${flights.fix.number}), after review.`, 'Tags flight-1 and flight-2 mark each landing.'].join('\n');
    await ws.ok(join(ws.bin, 'yoneda'), ['release', 'create', 'flight-2', '--title', `flight-${r.key} 2`, '-m', notes, '--asset', archive], { cwd: r.base, token: tagger.token, extra: NO_SESSION });
  } finally {
    await ctx.tokens.revoke(tokenPath);
  }
}

/** One repository at a time, so review reservations never race the shared credit ledger. */
async function eachRepo(rows, what, body) {
  const done = [];
  for (const row of rows) {
    try { done.push({ status: 'fulfilled', value: await body(row) }); }
    catch (reason) { done.push({ status: 'rejected', reason }); }
  }
  for (const [i, d] of done.entries())
    if (d.status === 'rejected') {
      const line = `${rows[i].key} ${what}: ${scrub(d.reason?.message ?? String(d.reason)).slice(0, 500)}`;
      (state.errors ??= []).push(line);
      log(`FAILED ${line}`);
    }
  save();
  assert.ok(done.every((d) => d.status === 'fulfilled'), `${what}: a repository phase failed`);
  return true;
}


return { specOf, memories, flight, smoke, spendCheck, approvals, release, eachRepo };
}
