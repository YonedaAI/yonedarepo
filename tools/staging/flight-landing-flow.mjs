// Item 43's second half (flight-path-flow.mjs): legs 7 to 12. CTC warns of, holds behind and orders
// a second Landing on the same file; a review agent's finding blocks a head a person approved; the
// pilot's next session pulls it, merges main and fixes it; the agent looks again and finds nothing;
// CTC clears that exact head and lands it by itself, once; and the black box reads afterwards.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hook } from './agent-hooks-flow.mjs';
import { see } from './browser-collab-flow.mjs';
import { openPage, refusal, settled, writeInto } from './feature-kit.mjs';
import { ACTOR, change, decisionOn, gates, landedOf, nowSaid, onMainTimes, passCheck, pilotEnv, reasonCodes, review, SETTLE_MS } from './flight-kit.mjs';
import { BRANCH, FILE, FIRST_MESSAGE, FIX_LINE, GOAL, injected, MEMORY, readFile, stopSession, SUMMARY } from './flight-session.mjs';
import { rowWith, withChrome } from './kit-chrome.mjs';
import { McpClient } from './mcp-client.mjs';
import { glass } from './ticket-line.mjs';

const FINDING = 'High: retry() still allows 5 tries, past the gateway limit of 3';
const SECOND = 'kit-flight-2';
const FIXED = 'Kit flight session 2: answered the finding, retry() stops at 3.';
const FIX_MESSAGE = 'Answer the finding: stop at 3 tries';

/** 7: both Landings on the radar with their overlap and the warning on record. Then the other
 * pilot's Landing takes a ticket, this one waits behind it with SEPARATION, and they land in that
 * order: its landing changes what this one read, which sends this one around. */
async function traffic(f, web, m) {
  const { kit, repo, b, number } = f;
  const api = kit.pat();
  const { landings } = await api.get(repo.path('/ctc'));
  const row = landings.find((l) => l.number === number);
  const meet = row?.overlaps.find((o) => o.landing === b.number);
  assert.ok(meet?.paths.includes(FILE), `the radar's overlap: ${JSON.stringify(row)}`);
  const { deliveries } = await api.get(repo.path('/context/deliveries?session_id=claude-code:kit-flight'));
  const warned = deliveries.flatMap((d) => d.items ?? []).filter((i) => i.type === 'traffic').map((i) => i.id);
  assert.ok(warned.includes(b.number), `the session's record holds no warning of #${b.number}: ${warned}`);

  await glass(kit, repo, { action: 'pause_automation' });
  let landing;
  let line;
  try {
    // A pause refuses every other poster; the owner's own acts still go through.
    await passCheck(kit.platformAccount, repo, b.head);
    await review(f.reviewer, repo, b.head);
    landing = kit.platformAccount.raw('POST', repo.path('/land'), { ref: 'main', commit: b.head });
    const ticket = await settled(async () => (await api.get(repo.path('/ctc'))).landings.find((l) => l.number === b.number)?.place?.ticket, 'the other Landing to hold a ticket', 20_000);
    line = (await api.get(repo.path('/ctc'))).landings;
    const [front, behind] = [b.number, number].map((n) => line.find((l) => l.number === n));
    assert.deepEqual(front.place, { position: 1, line: 'queued', ticket }, 'the ticket leads the line');
    const held = behind.reasons.find((r) => r.code === 'SEPARATION');
    assert.ok(held?.reason.includes(`Landing ${b.number}`) && held.reason.includes(FILE), `what it waits for: ${JSON.stringify(behind.reasons)}`);
    assert.equal(behind.place.position, 2, `its place: ${JSON.stringify(behind.place)}`);
    await withChrome({ ...web.chrome, name: 'flight-ctc' }, m, async ({ page, shot }) => {
      await openPage(page, { origin: web.chrome.origin, account: web.account }, repo, '/ctc');
      const table = page.getByRole('region', { name: 'CTC', exact: true }).getByRole('table');
      await see(table.getByText(`1 · queued, ticket ${ticket}`), 'the ticket on the radar');
      await see(rowWith(table, 'row', FIRST_MESSAGE).getByText(held.reason), 'separation on the radar');
      await shot('ctc-held');
    });
  } finally {
    await glass(kit, repo, { action: 'resume_automation' });
  }
  const answered = await landing;
  assert.ok(answered.ok, `the ticket: ${refusal(answered)} ${JSON.stringify(answered.body).slice(0, 200)}`);
  f.otherLanded = (await landedOf(kit, repo, b.number, 'the ticket to land the other Landing')).landed_version;
  const said = await nowSaid(kit, repo, number, (s) => reasonCodes(s).includes('CONFLICT'), 'what landed first to send this one around');
  assert.ok(said.reasons.some((r) => r.reason.includes(FILE)), `the conflict names the file: ${JSON.stringify(said.reasons)}`);
  return `warned; held behind #${b.number} (ticket), it landed v${f.otherLanded}; this one: ${said.decision} ${reasonCodes(said)}`;
}

/** 8: an agent's finding on a head a person approved and CI passed: nothing lands, and it says why. */
async function finding(f, web, m) {
  const { kit, repo, crew, number, first } = f;
  await crew.agent.post(repo.path(`/changes/${number}/comments`), { commit: first, path: FILE, line: FIX_LINE + 1, side: 'new', body: FINDING });
  await passCheck(crew.ci, repo, first);
  await review(f.reviewer, repo, first);
  const held = await decisionOn(kit, repo, number, first, 'FINDINGS');
  assert.equal(held.decision, 'go_around', `the decision: ${JSON.stringify(held)}`);
  const shown = await gates(kit, repo, number);
  assert.equal(shown.ready, false, 'a blocking finding left the head ready');
  const refused = await kit.pat().raw('POST', repo.path('/land'), { ref: 'main', commit: first });
  assert.ok(!refused.ok, `an owner's landing went past the finding: ${JSON.stringify(refused.body).slice(0, 200)}`);
  assert.equal((await change(kit, repo, number)).status, 'open', 'a blocked Landing moved');
  await withChrome({ ...web.chrome, name: 'flight-blocked' }, m, async ({ page, shot }) => {
    await openPage(page, { origin: web.chrome.origin, account: web.account }, repo, `/changes/${number}`);
    await see(page.locator('article.source-change header .source-change-status').getByText('Go-around', { exact: true }), 'Go-around on the Landing');
    await shot('go-around');
  });
  return `${held.decision}: ${reasonCodes(held)}; owner's land refused ${refusal(refused)}`;
}

/** 9: the next session pulls the finding, merges main, fixes it and pushes; approvals drop. */
async function goAround(f) {
  const { kit, repo, crew, number, dir, first } = f;
  const envFile = kit.path('flight-claude-env-2');
  writeFileSync(envFile, '');
  const started = await hook(kit, 'claude-start', { session_id: SECOND, cwd: dir, hook_event_name: 'SessionStart', source: 'startup' }, pilotEnv(kit, crew.pilot, null, { CLAUDE_ENV_FILE: envFile }));
  assert.equal(started.code, 0, started.stderr);
  const context = injected(started);
  assert.ok(context.includes(`Go-around: 1 open finding on change #${number}`) && context.includes(FINDING), `the next session did not hear of the finding: ${context.slice(0, 800)}`);
  const shown = (await kit.yonedaOk(['change', 'show', String(number)], { cwd: dir, env: pilotEnv(kit, crew.pilot) })).stdout;
  assert.ok(shown.includes(FINDING), `yoneda change show: ${shown.slice(0, 500)}`);

  const env = pilotEnv(kit, crew.pilot, SECOND);
  await kit.ok('git', ['pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main'], { cwd: dir, env });
  await readFile(f, SECOND, FILE);
  const merged = (await kit.gitOk(dir, 'show', `HEAD:${FILE}`)).split('\n');
  merged[FIX_LINE] = 'export const tries = 3;';
  writeInto(dir, { [FILE]: `${merged.join('\n')}\n` });
  await kit.gitOk(dir, 'add', '-A');
  await kit.gitOk(dir, 'commit', '-qm', FIX_MESSAGE);
  await kit.ok('git', ['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], { cwd: dir, env });
  f.head = await kit.gitOk(dir, 'rev-parse', 'HEAD');
  await stopSession(f, SECOND, 'Answer the finding', FIXED);

  const after = await settled(async () => {
    const read = await change(kit, repo, number);
    return read.head === f.head && read;
  }, 'the Landing at its new head');
  assert.equal(after.status, 'open', 'the Landing left while going around');
  assert.equal(after.go_around.open, 1, `the finding before anyone looked again: ${JSON.stringify(after.go_around)}`);
  assert.equal(after.go_around.findings[0].on_head, false, 'the finding is on the older commit');
  const asks = (await gates(kit, repo, number)).requirements.find((r) => r.kind === 'approvals');
  assert.equal(asks?.state, 'waiting', `an approval of the older head counted on the new one: ${JSON.stringify(asks)}`);
  await kit.ok('git', ['fetch', '-q', 'origin'], { cwd: dir, env });
  assert.equal(await onMainTimes(kit, dir, first), 0, 'the refused head reached main');
  return `heard in context and show; ${f.head.slice(0, 7)} pushed; approval dropped`;
}

/** 10: the agent looks at the new head and finds nothing, as a passing re-review does: it resolves
 * nothing, and its finding has to stop counting. CTC holds for what is missing until the last
 * approval, which lands this exact head. Three more check results race the approval: every one
 * asks for a job, so duplicates reach the queue. */
async function cleared(f) {
  const { kit, repo, crew, number, head } = f;
  await passCheck(crew.agent, repo, head, 'slop-review', { agent: 'slop-review', value: 'low' });
  await passCheck(crew.agent, repo, head, 'intent-drift', { agent: 'intent-drift', value: 'low', verdict: 'On course' });
  await crew.agent.post(repo.path(`/changes/${number}/comments`), { body: 'Looked again: no findings' });
  const clean = await change(kit, repo, number);
  assert.equal(clean.go_around.open, 0, `the finding after the agent looked again: ${JSON.stringify(clean.go_around)}`);
  await passCheck(crew.ci, repo, head);
  const waiting = await nowSaid(kit, repo, number, (s) => s.decision === 'hold', 'CTC to hold for the approval');
  assert.deepEqual(reasonCodes(waiting), ['GATES'], `what it waits for: ${JSON.stringify(waiting.reasons)}`);
  assert.equal((await change(kit, repo, number)).status, 'open', 'it landed with no approval of this head');
  f.approvedAt = performance.now();
  await Promise.all([review(f.reviewer, repo, head), passCheck(crew.ci, repo, head), passCheck(crew.ci, repo, head), passCheck(crew.ci, repo, head)]);
  const decided = await settled(async () => (await change(kit, repo, number)).clearances?.find((c) => c.head === head && c.decision === 'cleared'), 'CTC to clear the head', 90_000);
  assert.ok(decided.state.approved_by.some((p) => p.includes(f.reviewer.name)), `who approved it: ${JSON.stringify(decided.state.approved_by)}`);
  return `cleared ${head.slice(0, 7)}, approved by the second account`;
}

/** 11: it lands by itself, once. Nobody here called land for it. */
async function landsOnce(f, web, m) {
  const { kit, repo, number, head, dir } = f;
  const landed = await landedOf(kit, repo, number);
  const ms = Math.round(performance.now() - f.approvedAt);
  const records = landed.clearances.filter((c) => c.landed_version !== null && c.landed_version !== undefined);
  assert.equal(records.length, 1, `decisions that say they landed it: ${JSON.stringify(records)}`);
  assert.deepEqual([records[0].head, records[0].decision, records[0].actor], [head, 'cleared', ACTOR], 'the record of the landing');
  assert.equal(landed.landed_commit, head, 'it landed another commit');
  assert.ok(landed.landed_version > f.otherLanded, `order: this one landed at v${landed.landed_version}, the other at v${f.otherLanded}`);
  await new Promise((done) => setTimeout(done, SETTLE_MS));
  assert.equal(await onMainTimes(kit, dir, head), 1, 'the head on main\'s first-parent line');
  const again = await change(kit, repo, number);
  assert.equal(again.landed_version, landed.landed_version, 'a duplicate job landed it again');
  await withChrome({ ...web.chrome, name: 'flight-landed' }, m, async ({ page, shot }) => {
    await openPage(page, { origin: web.chrome.origin, account: web.account }, repo, `/changes/${number}`);
    await see(page.getByText('Landed automatically'), '"Landed automatically" on the page');
    await shot('landed');
  });
  return `v${landed.landed_version} after #${f.b.number} at v${f.otherLanded}; once on main, ${ms} ms from the approval`;
}

/** 12: what happened, readable after the fact: by API, MCP and page. */
async function blackBox(f, web, m) {
  const { kit, repo, number, head, first } = f;
  const api = kit.pat();
  const route = await api.get(repo.path(`/changes/${number}/route`));
  const commits = route.commits.map((c) => c.commit);
  assert.ok(commits.includes(first) && commits.includes(head), `the route's commits: ${commits}`);
  assert.deepEqual(route.sessions.map((s) => s.summary).sort(), [FIXED, SUMMARY].sort(), 'the route keeps both sessions');
  const record = route.sessions.find((s) => s.summary === SUMMARY);
  const { document: stored } = await api.get(repo.path(`/sessions/${record.id}/transcript`));
  assert.ok(stored.context?.includes(MEMORY), 'the transcript keeps the context the session started with');
  assert.ok(stored.turns.some((t) => t.text === SUMMARY), 'the transcript keeps the reply');
  const { clearances } = await change(kit, repo, number);
  const codes = new Set(clearances.flatMap((c) => c.reasons.map((r) => r.code)));
  assert.ok(codes.has('FINDINGS'), `the record of what held it: ${[...codes]}`);
  const mcp = new McpClient(`${kit.api}/api/v1/mcp`, kit.token);
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'staging-kit', version: '1' } });
  const shown = await mcp.tool('git_change_show', { repo: repo.id, number });
  assert.equal(shown.flight_plan?.goal, GOAL, `git_change_show: ${JSON.stringify(shown).slice(0, 200)}`);
  await withChrome({ ...web.chrome, name: 'flight-black-box' }, m, async ({ page, shot }) => {
    await openPage(page, { origin: web.chrome.origin, account: web.account }, repo, `/changes/${number}`);
    const sessions = page.getByRole('region', { name: 'Sessions behind this Landing' });
    await see(sessions.getByText(SUMMARY), 'the first session on the Landing');
    await see(sessions.getByText(FIXED), 'the second session on the Landing');
    await shot('black-box-landing');
    await sessions.getByRole('link', { name: /claude/i }).last().click();
    const detail = page.locator('article.agent-session');
    await see(detail.getByRole('heading', { name: 'Context delivered' }), 'the delivered context');
    await see(detail.getByText(MEMORY).first(), 'the memory it was given');
    await shot('black-box-session');
  });
  return `${commits.length} commits, 2 sessions, transcript with its context, ${clearances.length} decisions (${[...codes]})`;
}

/** Legs 7 to 12. */
export async function flightLanding(f, { web, leg }, m) {
  await leg(7, 'CTC warns, holds and orders against a second Landing', () => traffic(f, web, m));
  await leg(8, 'A blocking finding', () => finding(f, web, m));
  await leg(9, 'Go-around: the agent pulls it, fixes and pushes', () => goAround(f));
  await leg(10, 'Cleared to land on that exact head', () => cleared(f));
  await leg(11, 'Lands by itself, exactly once', () => landsOnce(f, web, m));
  await leg(12, 'Black box readable afterwards', () => blackBox(f, web, m));
}
