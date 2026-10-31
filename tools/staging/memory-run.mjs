// One run of the memory test (memory-flow.mjs): a fresh fork, its memories (memory arm only, so
// nothing can leak into the plain arm), a clone and a repository token, the sandboxed agent's
// container, and afterwards what it did: read through the API, never from its clone (the clone
// was the agent's, so host Git must not touch it), and its branch landed through a change on
// the fork. Deletion is guarded to this test's own fork names.
//
// The agent's token is the owner's, limited to the fork and its parent and revoked after the run:
// the platform refuses a token of the fork alone both a lazy clone and any push ("Objects this
// fork inherits need read on its parent", repo-inherit.ts), and no token reads one repository
// while writing another. So an agent could write to its parent; nothing tells it to, it holds no
// land scope, and the test compares every ref of each parent at the end and fails if one moved.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { opencodeArgs, printable } from './agent-run-plan.mjs';
import { clientEnv, FAKE_MEMORY_AGENT, HOOK_LOG, sandboxArgs, sandboxEnv, WORKDIR } from './agent-sandbox.mjs';
import { branchName, deliveryOf, forkName, isTestFork, judgeTrap, opencodeUsage, retryableClone, runProblems } from './memory-plan.mjs';
import { armPrompt, seedOrder } from './memory-traps.mjs';

const q = (params) => new URLSearchParams(params).toString();
/** Open so the operator's landing needs nothing: this is the fork's policy, not the parent's. */
const OPEN = { required_checks: [], approvals: 0 };
const PAGE = 50;

/** `repo`'s refs as of its current log version (GET /refs alone can be up to 2 s old). */
export async function freshRefs(owner, repo) {
  const { version } = await owner.get(`/repos/${repo}`);
  return (await owner.get(`/repos/${repo}/refs?min_version=${version}`)).refs;
}

/** Deletes fork `id`. Today that is immediate. Deletes will become a 30-day window: the name may
 * then stay held, which `forkName`'s time allows for, and the read after may still answer, so
 * it is reported rather than required. */
export async function deleteFork(owner, id, name) {
  assert.ok(isTestFork(name), `refusing to delete ${name}: not a fork of this test`);
  const done = await owner.raw('DELETE', `/repos/${id}?confirm=${encodeURIComponent(name)}`);
  if (!done.ok && ![404, 410].includes(done.status)) throw new Error(`deleting ${name}: ${done.status} ${done.body?.error?.code ?? ''}`);
  return (await owner.raw('GET', `/repos/${id}`)).status;
}

/** The trap's rule must not be findable: not in the tree, a commit message or any commit's
 * changes, in a full clone (the plain arm's) before any agent touched it. Once per repository. */
export function scanHidden({ ws, scanned }, trap, dir) {
  if (scanned.has(trap.repo)) return scanned.get(trap.repo);
  const scan = (async () => {
    for (const pattern of trap.hidden)
      for (const args of [['grep', '-I', '-i', '-l', '-E', pattern, 'HEAD'], ['log', '--all', '-i', '-E', `--grep=${pattern}`, '--format=%h'], ['log', '--all', '-i', `-G${pattern}`, '--format=%h']]) {
        const found = await ws.run('git', args, { cwd: dir });
        assert.ok(found.code <= 1, `git ${args[0]} for ${pattern}: ${found.stderr.slice(-200)}`);
        assert.equal(found.stdout, '', `${trap.id}: ${trap.repo} reveals its rule (${pattern}): ${found.stdout.slice(0, 200)}`);
      }
  })();
  scanned.set(trap.repo, scan);
  return scan;
}

/** Adds the trap's memories oldest first; returns the trap memory's id. */
async function seed(owner, repo, trap) {
  let id = null;
  for (const memory of seedOrder(trap)) {
    const added = await owner.post(`/repos/${repo}/memories`, { kind: memory.kind, text: memory.text, anchors: memory.anchors, ref: 'main' });
    if (memory.trap) id = added.memory;
  }
  return id;
}

const CLONE_TRIES = 4;

/** Each retried clone is on record: a refusal here is a finding about the platform. */
function evidenceClone(evidence, agent, attempt) {
  appendFileSync(join(evidence, 'clone-retries.txt'), `${agent} attempt ${attempt}: overloaded\n`);
  console.log(`  ${agent}: clone refused as overloaded, retrying`);
}

/** Everything one agent needs: its fork, memories, token, clone and `runAgent` job. */
export async function prepareRun(ctx, { trap, arm, round, parent }) {
  const { owner, ws, ts, origin, evidence, credential, model, image, egress, budget, timeoutS, fake } = ctx;
  const agent = `${trap.id}-${round}-${arm}`;
  const name = forkName(ts, trap.id, arm, round);
  const fork = await owner.post(`/repos/${parent}/fork`, { name, policy: OPEN });
  // Registered before anything else can fail, so the run's end always deletes it.
  ctx.forks.set(fork.id, fork.name);
  assert.equal((await owner.get(`/repos/${fork.id}/memories?limit=1`)).memories.length, 0, `${name}: a new fork holds memories`);
  const trapMemory = arm === 'memory' ? await seed(owner, fork.id, trap) : null;
  const main = (await freshRefs(owner, fork.id))['refs/heads/main'];
  assert.ok(main, `${name} has no main`);
  const minted = await owner.post('/tokens', { name, scopes: ['repo:read', 'repo:write'], repos: [parent, fork.id], expires_days: 1 });
  ctx.tokens.add(minted.id);
  ctx.secrets.add(minted.token);
  const dir = ws.path(agent);
  const plain = arm === 'plain';
  for (let attempt = 1; ; attempt++) {
    try {
      await ws.ok('git', ['clone', '-q', plain ? `${ws.api}/git/${fork.id}.git` : `yoneda::${ws.api}/${fork.id}`, dir], { token: minted.token });
      break;
    } catch (e) {
      if (attempt >= CLONE_TRIES || !retryableClone(e?.message)) throw e;
      evidenceClone(evidence, agent, attempt);
      rmSync(dir, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 15_000 * attempt));
    }
  }
  if (plain) await scanHidden(ctx, trap, dir);
  const branch = branchName(trap.id, round);
  await ws.git(dir, null, 'switch', '-q', '-c', branch);
  await ws.git(dir, null, 'config', 'user.name', `Memory test ${agent}`);
  await ws.git(dir, null, 'config', 'user.email', `memtest-${arm}@yonedarepo.invalid`);
  // The URL the platform has from inside the container; the sandbox refuses any other.
  const remote = plain ? `${origin}/git/${fork.id}.git` : `yoneda::${origin}/${fork.id}`;
  await ws.git(dir, null, 'remote', 'set-url', 'origin', remote);
  const env = sandboxEnv({ origin, token: minted.token, remote, credential, proxy: egress.address, plain });
  const container = `yoneda-memtest-${agent}-${Date.now().toString(36)}`;
  ctx.containers.push(container);
  const command = [...(fake ? FAKE_MEMORY_AGENT : ['opencode']), ...opencodeArgs({ model, title: `memtest ${agent}`, text: armPrompt(trap, branch, arm) })];
  const args = sandboxArgs({ name: container, clone: realpathSync(dir), env, command, network: egress.network, image });
  writeFileSync(join(evidence, `${agent}.command.txt`), `${printable(['docker', ...args])}\n`);
  return {
    trap,
    arm,
    round,
    agent,
    fork,
    main,
    branch,
    dir,
    trapMemory,
    job: { task: { agent }, name: container, cwd: ws.dir, env: clientEnv(process.env, env), credential, scrub: ws.scrub, args, evidence, timeoutMs: timeoutS * 1000, budget },
  };
}

/** Opens a change for the agent's branch on the fork and lands it; whether it landed, and why
 * not. Never throws: a landing that fails is a measured result. */
async function land(owner, path, { branch, agent }, head) {
  const opened = await owner.raw('POST', `${path}/changes`, { branch, base: 'main', title: `Memory test ${agent}` });
  if (!opened.ok) return { landed: false, why: `change: ${opened.status} ${opened.body?.error?.code ?? ''}` };
  const landed = await owner.raw('POST', `${path}/land`, { ref: 'main', commit: head });
  if (!landed.ok) return { landed: false, change: opened.body.number, why: `land: ${landed.status} ${landed.body?.error?.code ?? ''}` };
  const change = await owner.get(`${path}/changes/${opened.body.number}`);
  return { landed: change.status === 'landed', change: opened.body.number, status: change.status };
}

/** The run's record, scrubbed and written as its own timestamped evidence file. */
export async function judgeRun(ctx, run, outcome) {
  const { owner, ws, evidence } = ctx;
  const path = `/repos/${run.fork.id}`;
  const events = join(evidence, `${run.agent}.events.jsonl`);
  const usage = opencodeUsage(existsSync(events) ? readFileSync(events, 'utf8').split('\n') : []);
  const log = join(run.dir, HOOK_LOG.slice(WORKDIR.length + 1));
  if (existsSync(log)) writeFileSync(join(evidence, `${run.agent}.hooks.jsonl`), ws.scrub(readFileSync(log, 'utf8')));
  const session = usage.session ? `opencode:${usage.session}` : null;
  const deliveries = session ? (await owner.get(`${path}/context/deliveries?${q({ session_id: session })}`)).deliveries : [];
  const memories = (await owner.get(`${path}/memories?limit=${PAGE}`)).memories.length;
  const delivery = run.trapMemory ? deliveryOf(deliveries, run.trapMemory) : null;
  const head = (await freshRefs(owner, run.fork.id))[`refs/heads/${run.branch}`] ?? null;
  const changes = head && head !== run.main ? ((await owner.get(`${path}/diff?${q({ base: run.main, head, patch: '1' })}`)).changes ?? []) : [];
  const oracle = judgeTrap(run.trap, { head, base: run.main, changes });
  const landing = oracle.outcome === 'no_push' ? { landed: false, why: 'nothing pushed' } : await land(owner, path, run, head);
  const sessions = head && head !== run.main ? ((await owner.get(`${path}/commits/${head}/sessions`)).sessions ?? []).length : 0;
  const problems = runProblems({ arm: run.arm, code: outcome.code, killed: outcome.killed, session, delivery, deliveries, memories, yonedaCalls: usage.yoneda_calls });
  const record = {
    recorded_at: new Date().toISOString(),
    trap: run.trap.id,
    repo: run.trap.repo,
    arm: run.arm,
    round: run.round,
    fork: run.fork.id,
    branch: run.branch,
    head,
    valid: problems.length === 0,
    problems,
    oracle,
    delivery,
    deliveries: deliveries.map((d) => ({ trigger: d.trigger, bytes: d.bytes, items: d.items.map((i) => `${i.type}:${i.id}`) })),
    memories_on_fork: memories,
    landed: landing.landed,
    landing,
    sessions_on_head: sessions,
    session,
    tokens: usage.tokens.total,
    ms: outcome.ms,
    whole_file_reads: usage.whole_file_reads,
    usage,
    exit: outcome.killed ?? outcome.code,
    cost_usd: outcome.cost,
    stderr: outcome.stderr,
  };
  const stamp = record.recorded_at.replaceAll(':', '-');
  writeFileSync(join(evidence, `${stamp}-${run.agent}.json`), ws.scrub(`${JSON.stringify(record, null, 2)}\n`));
  return record;
}
