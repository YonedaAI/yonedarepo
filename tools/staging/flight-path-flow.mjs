// Item 43 of the staging kit (no model): one Landing through the whole Flight Path, on a fresh
// repository, by the real API, CLI, Git and browser. The pilot's edits are scripted and its
// Claude Code session is the real `yoneda hook claude-*` on stock Git; the review agent's verdicts
// are check results and comments posted with a review token, as managed agents post them. Twelve
// legs, each asserting what happened and timed in `legs`: the first six here, the rest in
// flight-landing-flow.mjs. Needs LAND_WHEN_CLEARED=on and LANDING_INSTRUMENTS=on; skips while the
// platform refuses the switch. Nothing here calls land for the flight: it has to land by itself.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hook } from './agent-hooks-flow.mjs';
import { see } from './browser-collab-flow.mjs';
import { cloneOf, openPage, pushWork, settled, writeInto } from './feature-kit.mjs';
import { flightLanding } from './flight-landing-flow.mjs';
import { ACTOR, change, flightRepo, landedOf, landingOf, legs, passCheck, pilotEnv, pushedLanding, review } from './flight-kit.mjs';
import { BRANCH, FILE, FIRST_MESSAGE, FIX_LINE, GOAL, injected, MEMORY, MOVED, net, OTHER, readFile, stopSession, SUMMARY } from './flight-session.mjs';
import { withChrome } from './kit-chrome.mjs';

const SCOPE = 'src/net.ts only';
const ON_READ = 'CTC traffic on the files you read:';
const SESSION = 'kit-flight';

/** The repository before the flight: a memory on the file, a Landing that lands to move main, and
 * another pilot's Landing left open on the same file, behind main. */
async function preflight(kit, credentials, m) {
  const made = await flightRepo(kit, 'kit-flight', { switches: { create: true, findings_block: true }, files: { [FILE]: net(), 'README.md': '# Flight\n' } });
  if (made.skip) return made;
  const { repo, crew } = made;
  m.repo = repo.id;
  const api = kit.pat();
  const reviewer = await credentials.second();
  await api.post(repo.path('/members'), { account: reviewer.name, role: 'land' });
  await api.post(repo.path('/memories'), { kind: 'gotcha', text: MEMORY, anchors: [{ path: FILE }] });
  const other = await cloneOf(kit, repo, 'flight-other');
  const b = await pushedLanding(kit, repo, other, { branch: 'kit/other', message: 'Other pilot: a longer timeout', files: { [FILE]: net(OTHER) } });
  const moved = await pushedLanding(kit, repo, other, { branch: 'kit/moved', message: 'The base moves', files: { [FILE]: net(MOVED) } });
  await passCheck(crew.ci, repo, moved.head);
  await review(reviewer, repo, moved.head);
  const landed = await landedOf(kit, repo, moved.number, 'CTC to land the pre-flight Landing');
  assert.equal(landed.clearances[0].actor, ACTOR, `who landed the pre-flight Landing: ${JSON.stringify(landed.clearances[0])}`);
  const dir = await cloneOf(kit, repo, 'flight-pilot');
  return { kit, repo, crew, reviewer, other, dir, b };
}

/** 1: filed before there is a Landing, for a branch not pushed yet. */
async function plan(f) {
  await f.kit.gitOk(f.dir, 'switch', '-q', '-c', BRANCH);
  const filed = await f.kit.yonedaOk(['flight-plan', '-m', GOAL, '--scope', SCOPE], { cwd: f.dir, env: pilotEnv(f.kit, f.crew.pilot) });
  const said = filed.stdout + filed.stderr;
  assert.match(said, new RegExp(`Flight plan #\\d+ filed for ${BRANCH}`), `yoneda flight-plan: ${said}`);
  return said.trim();
}

/** 2: a session starts on the branch with the repository's context and the memory. */
async function takeoff(f) {
  const envFile = f.kit.path('flight-claude-env');
  writeFileSync(envFile, '');
  const started = await hook(f.kit, 'claude-start', { session_id: SESSION, cwd: f.dir, hook_event_name: 'SessionStart', source: 'startup' }, pilotEnv(f.kit, f.crew.pilot, null, { CLAUDE_ENV_FILE: envFile }));
  assert.equal(started.code, 0, started.stderr);
  const context = injected(started);
  assert.ok(context.includes(MEMORY), `the start context lacks the memory: ${context.slice(0, 600)}`);
  const { deliveries } = await f.kit.pat().get(f.repo.path(`/context/deliveries?session_id=claude-code:${SESSION}`));
  const start = deliveries.find((d) => d.trigger === 'start');
  assert.ok(start?.items.some((i) => i.type === 'memory' && i.label?.includes(MEMORY)), `the start delivery: ${JSON.stringify(deliveries).slice(0, 400)}`);
  return `${context.length} bytes of context, memory delivered`;
}

/** 3: reads the file (and hears of the other Landing on it), edits, commits and pushes. */
async function work(f) {
  const heard = await readFile(f, SESSION, FILE);
  assert.ok(heard.includes(ON_READ) && heard.includes(`Landing ${f.b.number}`) && heard.includes(FILE), `reading the file warned of nothing: ${heard}`);
  writeInto(f.dir, { [FILE]: net({ ...MOVED, [FIX_LINE]: 'export const tries = 5;' }) });
  await f.kit.gitOk(f.dir, 'add', '-A');
  await f.kit.gitOk(f.dir, 'commit', '-qm', FIRST_MESSAGE);
  await f.kit.ok('git', ['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], { cwd: f.dir, env: pilotEnv(f.kit, f.crew.pilot, SESSION) });
  f.first = await f.kit.gitOk(f.dir, 'rev-parse', 'HEAD');
  const pushed = await f.kit.pat().get(f.repo.path(`/commits/${f.first}`));
  assert.deepEqual(pushed.read_set, [FILE], 'the push declared what the session read');
  await stopSession(f, SESSION, 'Make retry stop at the gateway limit', SUMMARY);
  const records = (await f.kit.pat().get(f.repo.path(`/commits/${f.first}/sessions`))).sessions;
  assert.deepEqual(records.map((s) => [s.cli, s.session_id, s.summary]), [['claude-code', `claude-code:${SESSION}`, SUMMARY]], 'the session is recorded on its commit');
  return `${f.first.slice(0, 7)}, read declared, warned of #${f.b.number}, session recorded`;
}

/** 4: nobody opened it: the push did, with the plan filed before it existed. */
async function opens(f) {
  const row = await landingOf(f.kit, f.repo, BRANCH);
  assert.deepEqual([row.origin, row.head, row.title], ['auto', f.first, FIRST_MESSAGE], 'the Landing the push opened');
  f.number = row.number;
  const shown = await change(f.kit, f.repo, f.number);
  assert.deepEqual([shown.flight_plan?.goal, shown.flight_plan?.scope, shown.flight_plan?.branch], [GOAL, SCOPE, BRANCH], 'the plan filed before the push is not on the Landing');
  return `#${f.number}, origin auto, plan on it`;
}

/** 5: commits, the session, what it was shown; by REST and the CLI. */
async function route(f) {
  const read = await f.kit.pat().get(f.repo.path(`/changes/${f.number}/route`));
  assert.deepEqual(read.commits.map((c) => [c.commit, c.subject]), [[f.first, FIRST_MESSAGE]], 'the route\'s commits');
  assert.deepEqual(read.sessions.map((s) => s.summary), [SUMMARY], 'the route\'s session');
  assert.ok(['start', 'read'].every((t) => read.deliveries.some((d) => d.trigger === t)), `the route's deliveries: ${read.deliveries.map((d) => d.trigger)}`);
  assert.ok(read.totals.memories_delivered >= 1, `no memory on the route: ${JSON.stringify(read.totals)}`);
  const cli = await f.kit.yonedaOk(['change', 'route', String(f.number)], { cwd: f.dir, env: pilotEnv(f.kit, f.crew.pilot) });
  assert.ok(cli.stdout.includes(f.first.slice(0, 7)) && cli.stdout.includes(SUMMARY.slice(0, 40)), `yoneda change route: ${cli.stdout.slice(0, 400)}`);
  return `1 commit, 1 session, ${read.deliveries.length} deliveries, ${read.totals.memories_delivered} memory`;
}

/** 6: Risk from the platform, Slop and Intent drift as an agent posts them, read and seen. */
async function instruments(f, web, m) {
  const { kit, repo, crew, number, first } = f;
  await passCheck(crew.agent, repo, first, 'slop-review', { agent: 'slop-review', value: 'low' });
  await passCheck(crew.agent, repo, first, 'intent-drift', { agent: 'intent-drift', value: 'low', verdict: 'On course' });
  const read = async () => (await kit.pat().get(repo.path(`/changes/${number}/instruments`))).heads[0];
  const head = await settled(async () => {
    const newest = await read();
    return newest.checks.length === 2 && newest;
  }, 'both agents on the instruments');
  assert.equal(head.commit, first, 'the instruments read another head');
  assert.deepEqual(head.checks.map((c) => [c.name, c.value]).sort(), [['intent-drift', 'low'], ['slop-review', 'low']], 'the agents\' values');
  assert.ok(head.risk?.level, `no Risk: ${JSON.stringify(head.risk)}`);
  assert.equal(head.risk.reasons.length, 4, 'Risk shows all four inputs');
  assert.deepEqual((await read()).risk, head.risk, 'Risk moved between two reads of one head');
  await withChrome({ ...web.chrome, name: 'flight-instruments' }, m, async ({ page, shot }) => {
    await openPage(page, { origin: web.chrome.origin, account: web.account }, repo, `/changes/${number}`);
    const panel = page.locator('section.source-instruments');
    for (const card of ['Slop', 'Intent drift', 'Risk (beta)']) await see(panel.getByRole('heading', { level: 4, name: card, exact: true }), `the ${card} card`);
    await see(page.locator('article.source-change header').getByText(GOAL), 'the goal on the Landing');
    await shot('instruments');
  });
  return `Risk ${head.risk.level} (${head.risk.score}), Slop low, Intent drift low, 3 cards seen`;
}

/** 43: `web` is `{ chrome, account }`; `credentials.second()` is the person who approves. */
export async function flightPath(kit, { web, credentials }, m) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const f = await preflight(kit, credentials, m);
  if (f.skip) return f;
  const leg = legs(m);
  await leg(1, 'Flight plan filed', () => plan(f));
  await leg(2, 'Takeoff with context and memory', () => takeoff(f));
  await leg(3, 'Agent works and pushes', () => work(f));
  await leg(4, 'A Landing opens from the push', () => opens(f));
  await leg(5, 'Route', () => route(f));
  await leg(6, 'Instruments: Risk, Slop, Intent drift', () => instruments(f, web, m));
  await flightLanding(f, { web, leg }, m);
}
