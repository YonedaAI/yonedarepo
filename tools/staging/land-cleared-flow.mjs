// Item 34 of the staging kit (no model): CTC lands. It needs LAND_WHEN_CLEARED=on on the platform
// Worker, deployed after the deploy that ships the job (docs/runbook.md, "Land when cleared");
// while it is off the item stops at once with a note. With it on, on a repository with the switch
// turned on: an approval lands the head with nobody calling land, as the platform, with why on the
// record and the page saying so. A head Risk reads High lands too: Risk holds nothing. Separation: with a ticket held in line (ticket-line.mjs), a Landing that read what it writes
// is held on the record with SEPARATION, and lands by itself once the way is clear.
import assert from 'node:assert/strict';
import { see } from './browser-collab-flow.mjs';
import { cloneOf, kitRepo, landingOn, openPage, refusal, settled } from './feature-kit.mjs';
import { withChrome } from './kit-chrome.mjs';
import { LINE_FILES, lineBase, lineUp, READ, readerOf } from './ticket-line.mjs';

export const LWC_OFF = 'LAND_WHEN_CLEARED is off on this platform. To run it: deploy the job with the switch off, then set LAND_WHEN_CLEARED=on on the platform Worker in infra/envs/<env>.json and deploy again; a queue job a Worker does not know is dropped';
const ACTOR = 'platform:land-when-cleared';
const QUEUE_MS = 90_000;

const change = (kit, repo, number) => kit.pat().get(repo.path(`/changes/${number}`));
const review = (reviewer, repo, head, decision = 'approve') => reviewer.session.post(repo.path(`/commits/${head}/reviews`), { decision });

/** An approval lands it, as the platform, with why on the record. */
async function lands(kit, repo, dir, reviewer, web, m) {
  const landing = await landingOn(kit, repo, dir, { branch: 'kit/lands', title: 'Lands by itself', files: { 'src/lands.ts': 'export const lands = 1;\n' } });
  const gates = await kit.pat().get(repo.path(`/changes/${landing.number}/gates`));
  assert.equal(gates.land_when_cleared?.decision, 'hold', `before its approval: ${JSON.stringify(gates.land_when_cleared)}`);
  if (web) {
    await withChrome({ ...web.chrome, name: 'land-cleared' }, m, async ({ page, shot }) => {
      await openPage(page, { origin: web.chrome.origin, account: web.account }, repo, `/changes/${landing.number}`);
      await see(page.getByText('Tower: will land when cleared.'), 'the note that Tower will land it');
      await shot('will-land');
    });
  }
  await review(reviewer, repo, landing.head);
  const landed = await settled(async () => {
    const read = await change(kit, repo, landing.number);
    return read.status === 'landed' && read;
  }, 'CTC to land the approved Landing', QUEUE_MS);
  const why = landed.clearances[0];
  assert.deepEqual([why.decision, why.actor, why.head], ['cleared', ACTOR, landing.head], `the record: ${JSON.stringify(why)}`);
  assert.ok(why.landed_version > 0, 'the record has no landed version');
  assert.ok(why.state.approved_by.some((p) => p.includes(reviewer.name)), `who approved it: ${JSON.stringify(why.state.approved_by)}`);
  if (web) {
    await withChrome({ ...web.chrome, name: 'land-cleared-done' }, m, async ({ page, shot }) => {
      await openPage(page, { origin: web.chrome.origin, account: web.account }, repo, `/changes/${landing.number}`);
      await see(page.getByText('Landed automatically'), '"Landed automatically" on the page');
      await shot('landed-automatically');
    });
  }
  m.landed_at = why.landed_version;
}

/** A head Risk reads High lands like any other: Risk is a beta reading and holds nothing. */
async function highRiskLands(kit, repo, dir, reviewer, m) {
  const files = { '.github/workflows/ci.yml': 'on: push\n', 'migrations/0001.sql': 'select 1;\n', 'pnpm-lock.yaml': 'x\n' };
  const landing = await landingOn(kit, repo, dir, { branch: 'kit/risky', title: 'Risky', files });
  await review(reviewer, repo, landing.head);
  const landed = await settled(async () => {
    const read = await change(kit, repo, landing.number);
    return read.status === 'landed' ? read : null;
  }, 'CTC to land the High Risk head', QUEUE_MS);
  const why = landed.clearances[0];
  assert.equal(why.decision, 'cleared', `a High Risk head: ${JSON.stringify(why)}`);
  m.high_risk_landed_at = why.landed_version;
}

/** With a ticket held in line, a Landing that read what it writes is held on the record; once
 * the way is clear it lands. The switch goes on last: on, CTC would land the front at once. */
async function separation(kit, reviewer, m) {
  const repo = await kitRepo(kit, 'kit-lwc-line', { approvals: 1, files: LINE_FILES });
  await kit.pat().post(repo.path('/members'), { account: reviewer.name, role: 'land' });
  const [front, behind] = [await cloneOf(kit, repo, 'lwc-line-front'), await cloneOf(kit, repo, 'lwc-line-behind')];
  await lineBase(kit, front);
  const reader = await readerOf(kit, repo, behind, { branch: 'kit/behind', title: 'Behind the line' });
  const line = await lineUp(kit, repo, front, reviewer);
  let released = false;
  try {
    await kit.pat().call('PUT', repo.path('/auto-landings'), { land_when_cleared: true });
    await review(reviewer, repo, reader.head);
    const held = await settled(async () => {
      const read = await change(kit, repo, reader.number);
      return read.clearances?.find((c) => c.reasons.some((r) => r.code === 'SEPARATION'));
    }, 'CTC to hold the Landing behind the ticket', QUEUE_MS);
    assert.equal(held.decision, 'hold', `behind a ticket: ${JSON.stringify(held)}`);
    assert.ok(held.reasons.some((r) => r.reason.includes(`Landing ${line.front.number}`) && r.reason.includes(READ)), `what it waits for: ${JSON.stringify(held.reasons)}`);
    assert.equal((await change(kit, repo, reader.number)).status, 'open', 'it landed past the ticket');
    m.separation = held.reasons.find((r) => r.code === 'SEPARATION').reason;
    await line.release();
    released = true;
    // The resume asks again too, so what stood in front may land first; closing it does the same.
    const closed = await kit.pat().raw('POST', repo.path(`/changes/${line.front.number}/close`));
    assert.ok(closed.ok || /landed/.test(closed.body?.error?.message ?? ''), `closing the front: ${closed.status}`);
    const landed = await settled(async () => {
      const read = await change(kit, repo, reader.number);
      return read.status === 'landed' && read;
    }, 'the Landing to land once the way is clear', QUEUE_MS);
    assert.equal(landed.clearances[0].actor, ACTOR, `who landed it: ${JSON.stringify(landed.clearances[0])}`);
    m.separation_then = `landed v${landed.landed_version}`;
  } finally {
    if (!released) await line.release();
  }
}

/** 34: `web` is `{ chrome, account }` for the pages; `credentials.second()` approves. */
export async function landWhenCleared(kit, { web, credentials }, m) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const repo = await kitRepo(kit, 'kit-lwc', { approvals: 1 });
  m.repo = repo.id;
  const on = await kit.pat().raw('PUT', repo.path('/auto-landings'), { land_when_cleared: true });
  if (on.body?.error?.code === 'NOT_SUPPORTED') return { skip: LWC_OFF };
  assert.ok(on.ok, `turning the switch on: ${refusal(on)}`);
  const reviewer = await credentials.second();
  await kit.pat().post(repo.path('/members'), { account: reviewer.name, role: 'land' });
  const dir = await cloneOf(kit, repo, 'lwc');
  await lands(kit, repo, dir, reviewer, web, m);
  await highRiskLands(kit, repo, dir, reviewer, m);
  await separation(kit, reviewer, m);
}
