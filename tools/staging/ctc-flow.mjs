// Item 33 of the staging kit (no model): CTC, Code Traffic Control, on a real repository. Other
// people's Landings are pushed with stock Git and opened; a Claude Code session (the real
// `yoneda hook claude-*`) on a branch touching the same file hears of them at its start, then
// once on each file it reads, never of its own Landing. REST and the account MCP answer the same.
// A path-limited token gets none of it: not the warnings, not the radar, not one path. Then the
// radar, by API and MCP and in Chrome: state, what each waits for, the place in line, overlaps
// (same file, read conflict), a Landing arriving while the page is open (its poll) and leaving on
// Refresh. Separation with a ticket held in line (ticket-line.mjs): the radar says what is ahead,
// with LAND_WHEN_CLEARED off too, since it reads the decision the job would make.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hook, NO_SESSION } from './agent-hooks-flow.mjs';
import { highlighted } from './browser-agent-flow.mjs';
import { see } from './browser-collab-flow.mjs';
import { sleep } from './client.mjs';
import { cloneOf, kitRepo, landingOn, noLeak, openPage, pushWork, refusal, settled } from './feature-kit.mjs';
import { rowWith, withChrome } from './kit-chrome.mjs';
import { McpClient } from './mcp-client.mjs';
import { LINE_FILES, lineBase, lineUp, READ, readerOf } from './ticket-line.mjs';

const SESSION = 'kit-ctc';
const START = 'Traffic: open Landings on what you are working on';
const ON_READ = 'Tower traffic on the files you read:';
const FILES = { 'src/net.ts': 'export function retry() {}\n', 'src/auth.ts': 'export function login() {}\n', 'README.md': '# CTC kit\n' };
const warned = (number, title, branch, path) => new RegExp(`Landing ${number} \\("${title}", branch ${branch}\\) is changing .*${path.replace('.', '\\.')}`);
const account = (kit) => new McpClient(`${kit.api}/api/v1/mcp`, kit.token);

/** What a session hears: at its start, then once per Landing and file as it reads them. */
async function sessionWarnings(kit, repo, dir, first, m) {
  const envFile = kit.path('ctc-claude-env');
  writeFileSync(envFile, '');
  const started = await hook(kit, 'claude-start', { session_id: SESSION, cwd: dir, hook_event_name: 'SessionStart', source: 'startup' }, kit.env({ ...NO_SESSION, CLAUDE_ENV_FILE: envFile }));
  assert.equal(started.code, 0, started.stderr);
  const context = JSON.parse(started.stdout || '{}').hookSpecificOutput?.additionalContext ?? '';
  assert.ok(context.includes(START), `the start context has no traffic: ${context.slice(0, 600)}`);
  assert.match(context, warned(first, 'Retry budget', 'kit/a', 'src/net.ts'), 'the start context does not name the Landing on the branch\'s file');

  const read = async (path) => {
    const ran = await hook(kit, 'claude-read', { session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, path) }, tool_response: {}, cwd: dir });
    assert.equal(ran.code, 0, ran.stderr);
    return JSON.parse(ran.stdout || '{}').hookSpecificOutput?.additionalContext ?? '';
  };
  assert.ok(!(await read('src/net.ts')).includes(ON_READ), 'a warning the start context gave came again on the read');
  const onRead = await read('src/auth.ts');
  assert.ok(onRead.includes(ON_READ), `reading a file a Landing changes warned of nothing: ${onRead}`);
  assert.match(onRead, warned(first, 'Retry budget', 'kit/a', 'src/auth.ts'), 'the read warning does not name the Landing');
  assert.ok(!(await read('src/auth.ts')).includes(ON_READ), 'a read warning came twice');

  const { deliveries } = await kit.pat().get(repo.path(`/context/deliveries?session_id=claude-code:${SESSION}`));
  const told = deliveries.flatMap((d) => (d.items ?? []).filter((i) => i.type === 'traffic').map((i) => `${d.trigger}:${i.id}:${i.path ?? i.label ?? ''}`));
  assert.ok(told.includes(`start:${first}:src/net.ts`) && told.includes(`read:${first}:src/auth.ts`), `the session's record of its warnings: ${told}`);
  m.warnings = told.join(',');
}

/** The same warnings by REST and the account MCP; a session is not warned of its own Landing. */
async function clientsHearIt(kit, repo, { first, second }, m) {
  const api = kit.pat();
  const ask = async (query) => (await api.get(repo.path(`/context/relevant?paths=src/net.ts${query}`))).traffic.warnings.map((w) => w.landing).sort((a, b) => a - b);
  assert.deepEqual(await ask('&branch=none'), [first, second], 'a read of the file names both Landings on it');
  assert.deepEqual(await ask('&branch=kit/b'), [first], "a session on kit/b is told of its own Landing");
  assert.deepEqual(await ask('&branch=kit/a'), [second], "a session on kit/a is told of its own Landing");
  const start = (await api.get(repo.path('/context?paths=src/net.ts'))).traffic.warnings;
  assert.ok(start.every((w) => w.path === 'src/net.ts') && start.length === 2, `GET /context: ${JSON.stringify(start)}`);
  const mcp = account(kit);
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'staging-kit', version: '1' } });
  const relevant = await mcp.tool('git_context_relevant', { repo: repo.id, paths: ['src/auth.ts'], branch: 'none' });
  assert.deepEqual(relevant.traffic.warnings.map((w) => w.landing), [first], 'git_context_relevant');
  const started = await mcp.tool('git_context', { repo: repo.id, paths: ['src/net.ts'] });
  assert.equal(started.traffic.warnings.length, 2, 'git_context');
  m.mcp_warnings = relevant.traffic.warnings.length + started.traffic.warnings.length;
  return mcp;
}

/** A path-limited token sees nothing of the traffic: not a warning, not the radar, not a path. */
async function pathLimited(kit, repo, dir, m) {
  const api = kit.pat();
  const { token } = await api.post(repo.path('/tokens'), { name: 'kit-docs', scopes: ['read', 'write'], paths: ['docs/'] });
  try {
    const limited = kit.pat(token);
    const refused = [];
    for (const read of ['/context?paths=src/net.ts', '/context/relevant?paths=src/net.ts', '/ctc']) {
      const answer = await limited.raw('GET', repo.path(read));
      assert.equal(answer.status, 403, `${read} for a path-limited token: ${refusal(answer)}`);
      noLeak(answer, 'src/net.ts', read);
      noLeak(answer, 'Retry budget', read);
      refused.push(refusal(answer));
    }
    const mcp = new McpClient(`${kit.api}/api/v1/repos/${repo.id}/mcp`, token);
    await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'staging-kit', version: '1' } });
    for (const [tool, args] of [['git_ctc_radar', {}], ['git_context_relevant', { paths: ['src/net.ts'] }]]) {
      const tried = await mcp.attempt(tool, args);
      assert.ok(tried.isError || tried.error, `${tool} answered a path-limited token: ${tried.text.slice(0, 200)}`);
      assert.ok(!tried.text.includes('Retry budget'), `${tool} leaks a Landing to a path-limited token`);
    }
    const cli = await kit.yoneda(['context'], { cwd: dir, env: kit.env({ ...NO_SESSION, YONEDA_TOKEN: token }) });
    assert.ok(!`${cli.stdout}${cli.stderr}`.includes('Retry budget'), 'yoneda context leaks a Landing to a path-limited token');
    m.path_limited = refused.join(',');
  } finally {
    await api.call('DELETE', repo.path('/tokens/kit-docs'));
  }
}

/** The radar's answer: every open Landing, what it waits for, its place, its overlaps. */
async function radarAnswers(kit, repo, mcp, { first, second, third }, m) {
  const radar = await kit.pat().get(repo.path('/ctc'));
  assert.equal(radar.truncated, false, 'a radar of three is not truncated');
  const row = (number) => radar.landings.find((l) => l.number === number);
  assert.deepEqual(radar.landings.map((l) => l.number).sort((a, b) => a - b), [first, second, third], 'the radar lists every open Landing');
  for (const l of radar.landings) {
    assert.equal(l.decision, 'hold', `Landing ${l.number} is ${l.decision}: no one has approved it`);
    assert.ok(l.reasons.length > 0, `Landing ${l.number} holds without saying why`);
    // The rules here ask for an approval: "they ask for nothing" beside it contradicted them.
    assert.deepEqual(l.reasons.map((r) => r.code), ['GATES'], `Landing ${l.number} waits for what the rules ask`);
    assert.equal(l.place?.line, 'waiting', `Landing ${l.number} place`);
  }
  assert.deepEqual(radar.landings.map((l) => l.place.position), [1, 2, 3], 'the line runs from 1, oldest first');
  const meet = (a, b) => row(a).overlaps.find((o) => o.landing === b);
  assert.ok(['file', 'symbol'].includes(meet(first, second)?.overlap) && meet(first, second).paths.includes('src/net.ts'), `the two writers of src/net.ts: ${JSON.stringify(row(first).overlaps)}`);
  assert.deepEqual(meet(first, third)?.paths, ['src/auth.ts'], 'the reader of src/auth.ts overlaps its writer');
  assert.equal(meet(first, third)?.overlap, 'read', 'a declared read is a read overlap');
  const small = await mcp.tool('git_ctc_radar', { repo: repo.id, limit: 1 });
  assert.equal(small.truncated, true, 'git_ctc_radar with limit 1 of 3');
  Object.assign(m, { radar: radar.landings.length, reasons: row(first).reasons.map((r) => r.code).join(','), overlaps: row(first).overlaps.map((o) => `${o.landing}:${o.overlap}`).join(',') });
  return radar;
}

/** The radar page: the table, the note, a Landing's link, its poll, and Refresh. */
async function radarPage(kit, repo, dir, { chrome, account: web }, radar, { first, second, third }, m) {
  await withChrome({ ...chrome, name: 'ctc' }, m, async ({ page, shot }) => {
    await openPage(page, { origin: chrome.origin, account: web }, repo, '/tower');
    const board = page.getByRole('region', { name: 'Tower', exact: true });
    await see(board.getByRole('heading', { level: 2, name: 'Tower', exact: true }), 'the Tower heading');
    const table = board.getByRole('table');
    await see(table.getByRole('rowheader', { name: /Retry budget/ }), 'the Landing on the radar');
    assert.deepEqual((await highlighted(page)).map((t) => t.trim()), ['Tower'], 'the sidebar highlights Tower only');
    if (!radar.land_when_cleared) await see(board.getByText('Land when cleared is off, so nothing lands on its own'), 'the note that nothing lands');
    const row = rowWith(table, 'row', 'Retry budget');
    await see(row.getByRole('cell', { name: /Hold/ }).first(), 'the Hold state');
    await see(row.getByText(radar.landings.find((l) => l.number === first).reasons[0].reason), 'what it waits for');
    await see(row.getByText(/same (file|symbol).*src\/net\.ts/), 'the same-file overlap');
    await see(row.getByText('read conflict: src/auth.ts'), 'the read overlap');
    await see(row.getByText('1 · waiting'), 'its place in line');
    await shot('ctc-radar');

    // The page asks again every 15 s while it is on screen: no reload here.
    const fourth = await landingOn(kit, repo, dir, { branch: 'kit/d', title: 'Arrives on the radar', files: { 'src/d.ts': 'export const d = 1;\n' } });
    await see(table.getByRole('rowheader', { name: /Arrives on the radar/ }), 'a new Landing, by the page\'s own poll', 25_000);
    await kit.pat().post(repo.path(`/changes/${fourth.number}/close`));
    await sleep(1_500);
    await board.getByRole('button', { name: 'Refresh' }).click();
    await table.getByRole('rowheader', { name: /Arrives on the radar/ }).waitFor({ state: 'detached', timeout: 15_000 });

    await row.getByRole('link', { name: `#${second}` }).click();
    await page.getByRole('heading', { level: 2, name: /Same retry/ }).waitFor();
    await page.goBack();
    await see(table.getByRole('rowheader', { name: new RegExp(`#${third}`) }), 'the radar after going back');
    await shot('ctc-radar-after');
    m.radar_page = 'table,note,poll,refresh,link';
  });
}

/** A Landing that read what the one in line writes waits behind it, and says so. */
async function separation(kit, { chrome, account: web, credentials }, m) {
  const repo = await kitRepo(kit, 'kit-ctc-line', { approvals: 1, files: LINE_FILES });
  const [front, behind] = [await cloneOf(kit, repo, 'ctc-line-front'), await cloneOf(kit, repo, 'ctc-line-behind')];
  const reviewer = await credentials.second();
  await kit.pat().post(repo.path('/members'), { account: reviewer.name, role: 'land' });
  await lineBase(kit, front);
  const reader = await readerOf(kit, repo, behind, { branch: 'kit/behind', title: 'Behind the line' });
  const line = await lineUp(kit, repo, front, reviewer);
  try {
    const { landings } = await kit.pat().get(repo.path('/ctc'));
    const [first, second] = [line.front.number, reader.number].map((n) => landings.find((l) => l.number === n));
    assert.deepEqual(first.place, { position: 1, line: 'queued', ticket: line.ticket }, 'the Landing with a ticket leads the line');
    const held = second.reasons.find((r) => r.code === 'SEPARATION');
    assert.equal(second.decision, 'hold', `the Landing behind is ${second.decision}`);
    assert.ok(held?.reason.includes(`Landing ${first.number}`) && held.reason.includes(READ), `what it waits for: ${JSON.stringify(second.reasons)}`);
    if (chrome) {
      await withChrome({ ...chrome, name: 'ctc-line' }, m, async ({ page, shot }) => {
        await openPage(page, { origin: chrome.origin, account: web }, repo, '/tower');
        const table = page.getByRole('region', { name: 'Tower', exact: true }).getByRole('table');
        await see(table.getByText(`1 · queued, ticket ${line.ticket}`), 'its place in line and ticket');
        await see(rowWith(table, 'row', 'Behind the line').getByText(held.reason), 'separation on the radar');
        await shot('ctc-separation');
      });
    }
    m.separation = held.reason;
  } finally {
    await line.release();
  }
  const after = await settled(async () => {
    const { landings } = await kit.pat().get(repo.path('/ctc'));
    const row = landings.find((l) => l.number === reader.number);
    return !row?.reasons.some((r) => r.code === 'SEPARATION') && row;
  }, 'the way to clear once the ticket is gone');
  m.separation_after = after.reasons.map((r) => r.code).join(',');
}

/** 33: `chrome` and `account` for the page; without them, the API half. */
export async function ctcTraffic(kit, feature, m) {
  const { chrome, account: web } = feature;
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const repo = await kitRepo(kit, 'kit-ctc', { approvals: 1, files: FILES });
  m.repo = repo.id;
  const [pilot, own, reader] = [await cloneOf(kit, repo, 'ctc-pilot'), await cloneOf(kit, repo, 'ctc-own'), await cloneOf(kit, repo, 'ctc-reader')];
  const a = await landingOn(kit, repo, pilot, { branch: 'kit/a', title: 'Retry budget', files: { 'src/net.ts': 'export function retry() { return 3; }\n', 'src/auth.ts': 'export function login() { return 1; }\n' } });
  await pushWork(kit, own, { branch: 'kit/b', message: 'Same retry', files: { 'src/net.ts': 'export function retry() { return 4; }\n' } });
  await sessionWarnings(kit, repo, own, a.number, m);
  const { number: second } = await kit.pat().post(repo.path('/changes'), { branch: 'kit/b', title: 'Same retry' });
  const mcp = await clientsHearIt(kit, repo, { first: a.number, second }, m);
  await pathLimited(kit, repo, own, m);
  // A Landing that read what the first writes, declared by its push.
  await kit.gitOk(reader, 'switch', '-q', '-c', 'kit/c');
  await kit.yonedaOk(['reads', 'add', 'src/auth.ts'], { cwd: reader, env: kit.env(NO_SESSION) });
  const c = await pushWork(kit, reader, { branch: 'kit/c', from: null, message: 'Reads auth', files: { 'src/c.ts': 'export const c = 1;\n' } });
  assert.deepEqual((await kit.pat().get(repo.path(`/commits/${c}`))).read_set, ['src/auth.ts'], 'the push declared the read');
  const { number: third } = await kit.pat().post(repo.path('/changes'), { branch: 'kit/c', title: 'Reads auth' });
  const numbers = { first: a.number, second, third };
  const radar = await radarAnswers(kit, repo, mcp, numbers, m);
  if (chrome) await radarPage(kit, repo, pilot, { chrome, account: web }, radar, numbers, m);
  else m.browser = 'not run';
  await separation(kit, feature, m);
}
