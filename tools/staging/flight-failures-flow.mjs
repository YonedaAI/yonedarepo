// Item 44 of the staging kit (no model): what goes wrong on a Flight Path, each on the live
// platform. A stale head, a failed check, a path-limited token, a fork, two Landings racing, a
// pause, a repository that asks for nothing and a rollback with a ticket in line. Every case
// asserts what CTC said and what main holds. `REPO_FULL` and a job delivered many times live in
// tests/workers/repo-flight-failures.test.ts: the first needs a database at its limit and the
// second a queue that redelivers on command. Item 43 races duplicate jobs live, too.
import assert from 'node:assert/strict';
import { see } from './browser-collab-flow.mjs';
import { author, cloneOf, noLeak, openPage, pushWork, refusal, seedFiles, settled } from './feature-kit.mjs';
import { flightFork } from './flight-fork-flow.mjs';
import { CI, change, decisionOn, flightRepo, gates, landedOf, legs, nowSaid, onMainTimes, passCheck, pilotEnv, pushedLanding, QUEUE_MS, reasonCodes, review, staysOpen } from './flight-kit.mjs';
import { withChrome } from './kit-chrome.mjs';
import { glass } from './ticket-line.mjs';

const pending = (kit, repo, number) =>
  settled(async () => (await kit.pat().get(repo.path('/ctc'))).landings.find((l) => l.number === number)?.place?.ticket, 'a ticket in line', 20_000);

/** Approved, with every check passed, on a head that moved on: nothing lands until the new head has
 * its own approval, and then only the new head. */
async function staleHead({ kit, repo, crew, reviewer, dir }) {
  const old = await pushedLanding(kit, repo, dir, { branch: 'fail/stale', message: 'Stale one', files: { 'src/stale.ts': 'export const v = 1;\n' } });
  await review(reviewer, repo, old.head);
  const next = await pushWork(kit, dir, { branch: 'fail/stale', from: null, message: 'Stale two', files: { 'src/stale.ts': 'export const v = 2;\n' } });
  await settled(async () => (await change(kit, repo, old.number)).head === next, 'the Landing at its new head');
  await passCheck(crew.ci, repo, old.head);
  await staysOpen(kit, repo, old.number, 'the old head landed');
  const said = await nowSaid(kit, repo, old.number, (s) => s.decision === 'hold', 'CTC to hold the new head');
  assert.deepEqual([...new Set(reasonCodes(said))], ['GATES'], JSON.stringify(said));
  assert.ok(said.reasons.some((r) => r.reason.startsWith('Approvals: 0')), `the old head's approval counted: ${JSON.stringify(said)}`);
  await passCheck(crew.ci, repo, next);
  await review(reviewer, repo, next);
  const landed = await landedOf(kit, repo, old.number);
  assert.equal(landed.landed_commit, next, 'it landed the older head');
  return `old head approved and passed: stayed open; new head v${landed.landed_version}`;
}

/** A required check fails and comes back; one nobody requires fails too, and that alone sends a
 * head with green gates around, on the page as well. */
async function failedCheck({ kit, repo, crew, reviewer, dir, web, m }) {
  const required = await pushedLanding(kit, repo, dir, { branch: 'fail/ci', message: 'CI fails', files: { 'src/ci.ts': 'export const v = 1;\n' } });
  await crew.ci.post(repo.path(`/commits/${required.head}/checks`), { name: CI, status: 'fail' });
  await review(reviewer, repo, required.head);
  const back = await decisionOn(kit, repo, required.number, required.head, 'GATES');
  assert.equal(back.decision, 'go_around', JSON.stringify(back));
  await passCheck(crew.ci, repo, required.head);
  const landed = await landedOf(kit, repo, required.number, 'a passing rerun to land it');

  const other = await pushedLanding(kit, repo, dir, { branch: 'fail/slop', message: 'Slop fails', files: { 'src/slop.ts': 'export const v = 1;\n' } });
  await crew.agent.post(repo.path(`/commits/${other.head}/checks`), { name: 'slop-review', status: 'fail', evidence: { agent: 'slop-review', value: 'high' } });
  await passCheck(crew.ci, repo, other.head);
  await review(reviewer, repo, other.head);
  const around = await decisionOn(kit, repo, other.number, other.head, 'CHECK_FAILED');
  assert.equal(around.decision, 'go_around', JSON.stringify(around));
  assert.equal((await gates(kit, repo, other.number)).ready, true, 'the gates of a head only a check nobody requires failed');
  await withChrome({ ...web.chrome, name: 'flight-check-failed' }, m, async ({ page, shot }) => {
    await openPage(page, { origin: web.chrome.origin, account: web.account }, repo, `/changes/${other.number}`);
    await see(page.locator('article.source-change header .source-change-status').getByText('Go-around', { exact: true }), 'Go-around on green gates');
    await shot('check-failed');
  });
  await staysOpen(kit, repo, other.number, 'a failed check landed');
  return `required: go_around then v${landed.landed_version} on a pass; not required: go_around, page agrees`;
}

/** A token limited to docs/ reads nothing of a flight, and work it touched that reaches beyond
 * its grant holds. */
async function pathLimited({ kit, repo, crew, reviewer, dir }) {
  const api = kit.pat();
  const secret = 'Beyond the grant';
  const landing = await pushedLanding(kit, repo, dir, { branch: 'fail/grant', message: secret, files: { 'src/grant.ts': 'export const v = 1;\n' } });
  const { token } = await api.post(repo.path('/tokens'), { name: 'kit-docs', scopes: ['read', 'write'], paths: ['docs/'] });
  const limited = kit.pat(token);
  const refused = [];
  for (const read of [`/changes/${landing.number}`, `/changes/${landing.number}/route`, `/changes/${landing.number}/instruments`, `/changes/${landing.number}/gates`, '/ctc', '/context?paths=src/grant.ts', '/context/relevant?paths=src/grant.ts']) {
    const answer = await limited.raw('GET', repo.path(read));
    assert.equal(answer.status, 403, `${read} for a path-limited token: ${refusal(answer)}`);
    noLeak(answer, secret, read);
    noLeak(answer, 'src/grant.ts', read);
    refused.push(answer.status);
  }
  const filed = await limited.raw('POST', repo.path('/flight-plans'), { goal: 'Not whole', branch: 'fail/grant' });
  assert.equal(filed.status, 403, `a path-limited token filed a plan: ${refusal(filed)}`);
  // Git refuses such a token outright (docs/runbook.md), so its work comes through the API.
  const { version } = await api.get(repo.path());
  const made = await limited.post(repo.path('/commits'), { parent: landing.head, base_version: version, message: 'Docs on top', author, changes: seedFiles({ 'docs/grant.md': 'on top\n' }) });
  const head = made.commit;
  await limited.post(repo.path('/refs/batch'), { updates: [{ ref: 'fail/grant', commit: head, expected: landing.head }] });
  await settled(async () => (await change(kit, repo, landing.number)).head === head, 'the Landing at the limited token\'s push');
  await passCheck(crew.ci, repo, head);
  await review(reviewer, repo, head);
  const held = await decisionOn(kit, repo, landing.number, head, 'OUTSIDE_GRANT');
  assert.equal(held.decision, 'hold', JSON.stringify(held));
  await staysOpen(kit, repo, landing.number, 'work beyond the grant landed');
  return `${refused.length} reads refused, nothing leaked, plan refused; OUTSIDE_GRANT holds`;
}

/** At once: two on different files both land; two on one line, one lands and one goes around. */
async function racing({ kit, repo, crew, reviewer, dir }) {
  const pair = async (a, b, filesOf) => {
    const landings = [];
    for (const [branch, message] of [a, b]) landings.push(await pushedLanding(kit, repo, dir, { branch, message, files: filesOf(branch) }));
    for (const { head } of landings) await passCheck(crew.ci, repo, head);
    await Promise.all(landings.map(({ head }) => review(reviewer, repo, head)));
    return landings;
  };
  const disjoint = await pair(['fail/left', 'Left'], ['fail/right', 'Right'], (branch) => ({ [`src/${branch.slice(5)}.ts`]: 'export const v = 1;\n' }));
  const versions = await Promise.all(disjoint.map(({ number }) => landedOf(kit, repo, number)));
  for (const { head } of disjoint) assert.equal(await onMainTimes(kit, dir, head) <= 1, true, 'a racing head landed twice');
  const line = { 'src/line.ts': 'export const v = 1;\n' };
  await pushWork(kit, dir, { branch: 'fail/base', message: 'A line both change', files: line });
  const base = await kit.gitOk(dir, 'rev-parse', 'HEAD');
  await passCheck(crew.ci, repo, base);
  await review(reviewer, repo, base);
  await landedOf(kit, repo, (await kit.pat().get(repo.path('/changes?status=open'))).changes.find((c) => c.branch === 'fail/base').number, 'the shared line to land');
  const same = await pair(['fail/one', 'One way'], ['fail/two', 'Another way'], (branch) => ({ 'src/line.ts': `export const v = '${branch}';\n` }));
  const ends = await settled(async () => {
    const read = await Promise.all(same.map(({ number }) => change(kit, repo, number)));
    const landed = read.filter((c) => c.status === 'landed');
    const back = read.filter((c) => c.status === 'open' && c.clearances?.[0]?.decision === 'go_around');
    return landed.length === 1 && back.length === 1 && { landed, back };
  }, 'one to land and one to go around', QUEUE_MS);
  const why = reasonCodes(ends.back[0].clearances[0]);
  await staysOpen(kit, repo, ends.back[0].number, 'the loser landed');
  return `disjoint: both landed (v${versions.map((v) => v.landed_version)}); same line: #${ends.landed[0].number} landed, #${ends.back[0].number} ${why}`;
}

/** Paused, an approved head holds and says why; the resume alone lands it. */
async function paused({ kit, repo, crew, reviewer, dir }) {
  const landing = await pushedLanding(kit, repo, dir, { branch: 'fail/pause', message: 'Paused', files: { 'src/pause.ts': 'export const v = 1;\n' } });
  await passCheck(crew.ci, repo, landing.head);
  await glass(kit, repo, { action: 'pause_automation' });
  try {
    await review(reviewer, repo, landing.head);
    await decisionOn(kit, repo, landing.number, landing.head, 'AUTOMATION_PAUSED');
    await staysOpen(kit, repo, landing.number, 'a paused repository landed');
  } finally {
    await glass(kit, repo, { action: 'resume_automation' });
  }
  const started = performance.now();
  const landed = await landedOf(kit, repo, landing.number, 'the resume to land it');
  return `held AUTOMATION_PAUSED; resume landed it v${landed.landed_version} in ${Math.round(performance.now() - started)} ms`;
}

/** Rules that ask for nothing: a push must not become a landing. */
async function nothingRequired(kit, { credentials }) {
  const made = await flightRepo(kit, 'kit-fail-open', { policy: { approvals: 0, required_checks: [] }, switches: { create: true } });
  const { repo, crew } = made;
  const dir = await cloneOf(kit, repo, 'fail-open');
  const landing = await pushedLanding(kit, repo, dir, { branch: 'fail/open', message: 'Asks for nothing', files: { 'src/open.ts': 'export const v = 1;\n' }, env: pilotEnv(kit, crew.pilot) });
  const held = await decisionOn(kit, repo, landing.number, landing.head, 'NOTHING_REQUIRED');
  assert.equal(held.decision, 'hold', JSON.stringify(held));
  await staysOpen(kit, repo, landing.number, 'a repository with no rules landed a push');
  await credentials.second();
  return 'NOTHING_REQUIRED holds; the push did not land';
}

/** A landed commit is reverted with a ticket in line behind it: the ticket still lands, on top of
 * the revert, and what was reverted stays out. */
async function rollback({ kit, repo, crew, reviewer, dir }) {
  const api = kit.pat();
  const shared = (edits) => Object.assign(Array.from({ length: 12 }, (_, i) => `export const l${i} = ${i};`), edits).join('\n');
  await pushWork(kit, dir, { branch: 'fail/seed', message: 'Seed the rollback file', files: { 'src/roll.ts': `${shared({})}\n` } });
  const seed = await kit.gitOk(dir, 'rev-parse', 'HEAD');
  await passCheck(crew.ci, repo, seed);
  await review(reviewer, repo, seed);
  await landedOf(kit, repo, (await api.get(repo.path('/changes?status=open'))).changes.find((c) => c.branch === 'fail/seed').number, 'the seed to land');

  const bad = await pushedLanding(kit, repo, dir, { branch: 'fail/bad', message: 'Goes bad', files: { 'src/roll.ts': `${shared({ 1: 'export const bad = true;' })}\n` } });
  const queued = await pushedLanding(kit, repo, dir, { branch: 'fail/queued', message: 'In line', files: { 'src/roll.ts': `${shared({ 10: 'export const queued = true;' })}\n` } });
  await passCheck(crew.ci, repo, bad.head);
  await review(reviewer, repo, bad.head);
  await landedOf(kit, repo, bad.number, 'the bad Landing to land');
  await glass(kit, repo, { action: 'pause_automation' });
  let landing;
  try {
    await passCheck(kit.platformAccount, repo, queued.head);
    await review(reviewer, repo, queued.head);
    landing = kit.platformAccount.raw('POST', repo.path('/land'), { ref: 'main', commit: queued.head });
    await pending(kit, repo, queued.number);
    const main = (await api.get(repo.path('/refs'))).refs['refs/heads/main'];
    await glass(kit, repo, { action: 'revert', commit: bad.head, expected_old: main });
  } finally {
    await glass(kit, repo, { action: 'resume_automation' });
  }
  const answered = await landing;
  assert.ok(answered.ok, `the ticket after the revert: ${refusal(answered)} ${JSON.stringify(answered.body).slice(0, 300)}`);
  const landed = await landedOf(kit, repo, queued.number, 'the ticket to land after the revert');
  await kit.ok('git', ['fetch', '-q', 'origin'], { cwd: dir, env: pilotEnv(kit, crew.pilot) });
  const held = await kit.gitOk(dir, 'show', 'origin/main:src/roll.ts');
  assert.ok(held.includes('queued = true') && !held.includes('bad = true'), `main after the rollback: ${held}`);
  assert.equal((await change(kit, repo, bad.number)).status, 'landed', 'the reverted Landing stays landed: the revert is its own commit');
  return `ticket landed v${landed.landed_version} on the revert; bad line gone, queued line there`;
}

/** 44: `web` is `{ chrome, account }`; `credentials.second()` approves and forks. */
export async function flightFailures(kit, { web, credentials }, m) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const made = await flightRepo(kit, 'kit-fail', { switches: { create: true } });
  if (made.skip) return made;
  const { repo, crew } = made;
  m.repo = repo.id;
  const reviewer = await credentials.second();
  await kit.pat().post(repo.path('/members'), { account: reviewer.name, role: 'land' });
  const dir = await cloneOf(kit, repo, 'fail');
  const s = { kit, repo, crew, reviewer, dir, web, m };
  const leg = legs(m);
  await leg('F1', 'Stale head', () => staleHead(s));
  await leg('F2', 'Failed check', () => failedCheck(s));
  await leg('F3', 'Path-limited token sees nothing', () => pathLimited(s));
  await leg('F4', 'A fork needs an approval of its head', () => flightFork(kit, { reviewer }));
  await leg('F5', 'Two Landings racing', () => racing(s));
  await leg('F6', 'Automation pause', () => paused(s));
  await leg('F7', 'Nothing required', () => nothingRequired(kit, { credentials }));
  await leg('F10', 'A rollback mid-queue', () => rollback(s));
}
