// Item 45 of the staging kit (a real model, so outside the free kit, and started only with --yes):
// the Flight Path with a real coding agent as the pilot. opencode runs in the Docker sandbox of
// item 29 (agent-sandbox.mjs): its clone is the only host path it sees, it gets no host
// environment, configuration or credential but the model's, on stdin, its egress reaches the
// platform and the model's API alone, and the host checkouts and remotes are compared before and
// after. The kit writes none of its code: it asks for the work, then reads what the agent did. The
// other Landing, the person who approves, the check and the review agent's finding are scripted,
// as in item 43, so what is measured is a stock agent on this platform. A time limit per run and a
// spend budget across runs kill the containers. Evidence in .local/staging/flight-agent-<ts>/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostProblems, runAgent, spendBudget } from './agent-run-flow.mjs';
import { opencodeArgs, printable } from './agent-run-plan.mjs';
import { clientEnv, egressAllowlist, HOOK_LOG, sandboxArgs, sandboxEnv, sandboxOrigin, WORKDIR } from './agent-sandbox.mjs';
import { buildSandbox, dockerAvailable, hostState, modelCredential, startEgress } from './agent-sandbox-host.mjs';
import { cloneOf, settled } from './feature-kit.mjs';
import { cleared, finding, landsOnce, traffic } from './flight-landing-flow.mjs';
import { ACTOR, change, flightRepo, gates, landedOf, landingOf, legs, passCheck, pushedLanding, review } from './flight-kit.mjs';

const FILE = 'src/net.js';
const BRANCH = 'flight/retry';
const LINES = Array.from({ length: 20 }, (_, i) => `export const setting${i} = ${i};`);
const SOURCE = (edits = {}) => `${[...LINES.map((line, i) => edits[i] ?? line), '', '// Runs fn until it succeeds.', 'export async function retry(fn) {', '  for (;;) {', '    try {', '      return await fn();', '    } catch {', '      // try again', '    }', '  }', '}'].join('\n')}\n`;
const MEMORY = 'Kit flight memory: the gateway drops a connection after 3 tries, so retry() must stop at 3.';
const FINDING = 'High: retry() retries with no delay. Wait 100 ms between tries, or the gateway drops us.';
const FIRST = 'Bound retry()';

const prompts = {
  first: [
    'You are working in a Git clone of a YonedaRepo repository (remote origin). Do these steps in order.',
    `1. Create your branch: git switch -c ${BRANCH}`,
    `2. Before you edit anything, file a flight plan: yoneda flight-plan -m "<one sentence on what you set out to do>" --scope "${FILE}"`,
    `3. Read ${FILE}. retry(fn) loops forever when fn keeps failing. Make it give up after a fixed number of tries and rethrow the last error. Change no other file.`,
    `4. Commit with the message "${FIRST}" and push: git push origin ${BRANCH}`,
    'Never push to main and do not land anything: the platform decides when it lands.',
    'When the push has succeeded, answer with one sentence saying what you changed.',
  ].join('\n'),
  again: (number) =>
    [
      `You are working in a Git clone of a YonedaRepo repository (remote origin), on branch ${BRANCH}, whose Landing is #${number}.`,
      'A review sent it back. What it found is in your session context, in the Go-around section, and in: yoneda change show ' + number,
      '1. Main moved and a file you read changed, so first run: git pull --no-rebase --no-edit origin main',
      '2. Fix what the finding asks in the code. Change nothing else.',
      `3. Commit and push: git push origin ${BRANCH}`,
      'Never push to main and do not land anything.',
      'When the push has succeeded, answer with one sentence saying what you changed.',
    ].join('\n'),
};

/** The repository: a real function to change, a memory on it and another pilot's Landing. */
async function preflight(kit, credentials, m) {
  const made = await flightRepo(kit, 'kit-flight-agent', { switches: { create: true, findings_block: true }, files: { [FILE]: SOURCE(), 'README.md': '# Net helpers\n' } });
  if (made.skip) return made;
  const { repo, crew } = made;
  m.repo = repo.id;
  const api = kit.pat();
  const reviewer = await credentials.second();
  await api.post(repo.path('/members'), { account: reviewer.name, role: 'land' });
  await api.post(repo.path('/memories'), { kind: 'gotcha', text: MEMORY, anchors: [{ path: FILE }] });
  const other = await cloneOf(kit, repo, 'flight-agent-other');
  const b = await pushedLanding(kit, repo, other, { branch: 'kit/other', message: 'Other pilot: a longer timeout', files: { [FILE]: SOURCE({ 3: 'export const timeout = 30;' }) } });
  const moved = await pushedLanding(kit, repo, other, { branch: 'kit/moved', message: 'The base moves', files: { [FILE]: SOURCE({ 15: 'export const moved = true;' }) } });
  await passCheck(crew.ci, repo, moved.head);
  await review(reviewer, repo, moved.head);
  await landedOf(kit, repo, moved.number, 'CTC to land the pre-flight Landing');
  return { kit, repo, crew, reviewer, b, file: FILE, title: FIRST, finding: FINDING, findingLine: 1 };
}

/** One opencode run in the sandbox, on the agent's clone. */
async function fly(f, name, text) {
  const { kit, sandbox } = f;
  const { origin, remote, egress, credential, evidence, budget, model, timeoutS, secrets } = sandbox;
  const env = sandboxEnv({ origin, token: f.crew.pilot, remote, credential, proxy: egress.address });
  const container = `yoneda-flight-${name}-${Date.now().toString(36)}`;
  sandbox.containers.push(container);
  const command = ['opencode', ...opencodeArgs({ model, title: `flight ${name}`, text })];
  const args = sandboxArgs({ name: container, clone: realpathSync(f.dir), env, command, network: egress.network, image: sandbox.image });
  writeFileSync(join(evidence, `${name}.command.txt`), `${printable(['docker', ...args])}\n`);
  const scrub = (out) => secrets.reduce((t, secret) => t.split(secret).join('[secret]'), kit.scrub(out));
  const task = { agent: name };
  const done = await runAgent({ task, name: container, cwd: kit.path(), env: clientEnv(process.env, env), credential, scrub, args, evidence, timeoutMs: timeoutS * 1000, budget });
  const log = join(f.dir, HOOK_LOG.slice(WORKDIR.length + 1));
  const hooks = existsSync(log) ? readFileSync(log, 'utf8') : '';
  writeFileSync(join(evidence, `${name}.hooks.jsonl`), scrub(hooks));
  assert.ok(!done.killed && done.code === 0, `the agent's run ${name}: ${done.killed ?? `exit ${done.code}`} ${done.stderr.split('\n').pop()}`);
  const events = hooks.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const start = events.filter((e) => e.event === 'opencode-start').at(-1);
  assert.ok(start, `the plugin made no start call in ${name}: is it loaded?`);
  sandbox.runs.push({ name, ms: done.ms, cost: done.cost, hooks: events.length });
  return { ...done, events, start: JSON.stringify(start.output ?? '') };
}

/** 1 to 3: the plan, the context, and the work, all the agent's. */
async function firstRun(f, leg) {
  const { kit, repo } = f;
  const api = kit.pat();
  let run;
  await leg('1-3', 'Agent files its plan, takes off and pushes', async () => {
    run = await fly(f, 'first', prompts.first);
    f.events = run.events;
    assert.ok(run.start.includes(MEMORY), `the start context lacks the memory: ${run.start.slice(0, 500)}`);
    const row = await landingOf(kit, repo, BRANCH);
    f.number = row.number;
    f.first = row.head;
    return `${run.ms} ms, $${run.cost ?? 'not reported'}, head ${row.head.slice(0, 7)}`;
  });
  await leg(4, 'A Landing opens from the push', async () => {
    const shown = await change(kit, repo, f.number);
    assert.equal(shown.origin, 'auto', 'the Landing came from the push');
    assert.ok(shown.flight_plan?.goal, 'the agent filed no plan, though it was told to');
    assert.equal(shown.flight_plan.branch, BRANCH, 'the plan is on another branch');
    return `#${f.number}, plan: ${shown.flight_plan.goal}`;
  });
  await leg(5, 'Route', async () => {
    const route = await settled(async () => {
      const read = await api.get(repo.path(`/changes/${f.number}/route`));
      return read.sessions.length > 0 && read;
    }, 'the session on the route', 30_000);
    f.session = route.sessions[0].session_id;
    assert.equal(route.sessions[0].cli, 'opencode', 'the session record');
    assert.ok(route.totals.memories_delivered >= 1, `no memory delivered: ${JSON.stringify(route.totals)}`);
    return `${route.commits.length} commits, session ${f.session}, ${route.deliveries.length} deliveries`;
  });
  await leg(6, 'Instruments', async () => {
    const [head] = (await api.get(repo.path(`/changes/${f.number}/instruments`))).heads;
    assert.ok(head.risk?.level, `no Risk: ${JSON.stringify(head)}`);
    return `Risk ${head.risk.level} (${head.risk.score}); Slop and Intent drift scripted`;
  });
}

/** 9: the second run: the finding reaches it with nothing but the context. The diff through the
 * API is the oracle, since the clone is the agent's: the delay it was asked for has to be there. */
async function secondRun(f, leg) {
  const { kit, repo } = f;
  await leg(9, 'Go-around: the agent pulls the finding, fixes and pushes', async () => {
    const run = await fly(f, 'around', prompts.again(f.number));
    assert.ok(run.start.includes('Go-around') && run.start.includes('100 ms'), `the second session did not start with the finding: ${run.start.slice(0, 800)}`);
    const moved = await settled(async () => {
      const read = await kit.pat().get(repo.path(`/changes/${f.number}?patch=1`));
      return read.head !== f.first && read;
    }, 'the agent\'s new head', 30_000);
    f.head = moved.head;
    const patch = moved.diff.changes.find((c) => c.path === FILE)?.patch ?? '';
    assert.match(patch, /\+.*\b100\b/, `the fix has no 100 ms delay: ${patch.slice(0, 800)}`);
    const asks = (await gates(kit, repo, f.number)).requirements.find((r) => r.kind === 'approvals');
    assert.equal(asks?.state, 'waiting', `an approval of the older head counted: ${JSON.stringify(asks)}`);
    assert.equal(moved.status, 'open', 'it left while going around');
    return `${run.ms} ms, $${run.cost ?? 'not reported'}, head ${moved.head.slice(0, 7)}, delay in the diff`;
  });
}

/** 12: both real sessions, their transcripts and what they were shown. */
async function blackBox(f) {
  const api = f.kit.pat();
  const route = await settled(async () => {
    const read = await api.get(f.repo.path(`/changes/${f.number}/route`));
    return new Set(read.sessions.map((s) => s.session_id)).size === 2 && read;
  }, 'both sessions on the route', 30_000);
  const models = [...new Set(route.sessions.map((s) => s.model))];
  const { document: stored } = await api.get(f.repo.path(`/sessions/${route.sessions.at(-1).id}/transcript`));
  assert.ok(stored.turns.length > 0, 'an empty transcript');
  const { clearances } = await change(f.kit, f.repo, f.number);
  const landing = clearances.find((c) => c.landed_version);
  assert.equal(landing?.actor, ACTOR, 'who landed it');
  return `2 sessions (${models}), ${stored.turns.length} transcript turns, ${route.deliveries.length} deliveries`;
}

/** 45: paid: see the header. Starts only with `yes`. */
export async function flightAgent(kit, { root, web, credentials, model, timeoutS, budgetUsd, yes }, m) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  if (!dockerAvailable()) return { skip: 'Docker is not available, and agents run only in the sandbox' };
  if (!yes) return { skip: `A real model: 2 runs of ${model}, at most ${timeoutS} s each and $${budgetUsd} in all. Add --yes to start` };
  const f = await preflight(kit, credentials, m);
  if (f.skip) return f;
  const credential = await modelCredential(model, kit.dir);
  const image = (await buildSandbox(root)).image;
  const watched = [root, process.cwd(), process.env.PWD];
  const before = await hostState(watched);
  const { origin } = sandboxOrigin(kit.api);
  const egress = await startEgress({ image, allow: egressAllowlist({ origin, model }), run: Date.now().toString(36) });
  const evidence = join(root, `.local/staging/flight-agent-${Date.now()}`);
  mkdirSync(evidence, { recursive: true });
  const secrets = [f.crew.pilot, ...JSON.parse(credential).map((e) => e.value?.key ?? e.value?.access).filter(Boolean)];
  f.sandbox = { origin, remote: kit.remote(f.repo.id, origin), egress, credential, evidence, budget: spendBudget(budgetUsd), model, timeoutS, image, containers: [], runs: [], secrets };
  Object.assign(m, { model, evidence, budget_usd: budgetUsd, time_limit_s: timeoutS });
  f.dir = await cloneOf(kit, f.repo, 'flight-agent');
  await kit.gitOk(f.dir, 'config', 'user.name', 'Kit flight agent');
  await kit.gitOk(f.dir, 'config', 'user.email', 'kit-flight-agent@yonedarepo.invalid');
  await kit.gitOk(f.dir, 'remote', 'set-url', 'origin', f.sandbox.remote);
  const leg = legs(m);
  try {
    await firstRun(f, leg);
    await leg(7, 'CTC warns, holds and orders against a second Landing', () => traffic(f, web, m));
    await leg(8, 'A blocking finding', () => finding(f, web, m));
    await secondRun(f, leg);
    await leg(10, 'Cleared to land on that exact head', () => cleared(f));
    await leg(11, 'Lands by itself, exactly once', () => landsOnce(f, web, m));
    await leg(12, 'Black box readable afterwards', () => blackBox(f));
  } finally {
    for (const name of f.sandbox.containers) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    const stopped = await egress.stop();
    m.egress_refused = stopped.refused.join(',') || 'none';
    const spent = f.sandbox.runs.map((r) => r.cost).filter((c) => c !== null);
    Object.assign(m, { runs: f.sandbox.runs, spend_usd: spent.length ? Number(spent.reduce((a, b) => a + b, 0).toFixed(4)) : 'not reported by opencode' });
    writeFileSync(join(evidence, 'outcome.json'), `${JSON.stringify(m, null, 2)}\n`);
    const drift = await hostProblems(before, watched);
    m.host_unchanged = drift.length === 0;
    assert.equal(drift.length, 0, `HOST CHANGED during the agent run: ${drift.join('; ')}`);
  }
}
