// Item 36 of the staging kit (no model): the flight plan and the go-around. A plan is filed with
// `yoneda flight-plan`, REST and MCP where the repository has the table; until 0045 is applied
// (APPLY_THROUGH in repo_store/migration.rs) each refuses with NOT_SUPPORTED and every read answers
// as if none was filed, and the item checks that. A go-around is pull, not push: an open finding on
// a Landing reaches `yoneda change show`, `yoneda context` and a session's start, marks an older
// commit when the head moves, and leaves when resolved. With "Block landing on unresolved agent
// findings" on, a token's finding refuses the landing until it is resolved.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { hook, NO_SESSION } from './agent-hooks-flow.mjs';
import { see } from './browser-collab-flow.mjs';
import { cloneOf, kitRepo, landingOn, openPage, pushWork, refusal, settled } from './feature-kit.mjs';
import { withChrome } from './kit-chrome.mjs';
import { McpClient } from './mcp-client.mjs';

const GOAL = 'Keep retries under the gateway limit';
const SCOPE = 'src/net.ts only';
const FINDING = 'High: this retries forever';

async function accountMcp(kit) {
  const mcp = new McpClient(`${kit.api}/api/v1/mcp`, kit.token);
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'staging-kit', version: '1' } });
  return mcp;
}

/** Filing while the repository has no table: refused everywhere, and nothing reads otherwise. */
async function plansNotApplied(kit, repo, dir, mcp, { number }, m) {
  const cli = await kit.yoneda(['flight-plan', '-m', GOAL], { cwd: dir, env: kit.env(NO_SESSION) });
  assert.notEqual(cli.code, 0, 'yoneda flight-plan claimed to file what the platform refused');
  const tool = await mcp.attempt('git_flight_plan', { repo: repo.id, goal: GOAL, branch: 'kit/fly' });
  assert.ok(tool.isError || tool.error, `git_flight_plan: ${tool.text.slice(0, 200)}`);
  assert.equal((await kit.pat().get(repo.path(`/changes/${number}`))).flight_plan, null, 'a refused plan reads back');
  m.flight_plan = 'NOT_SUPPORTED by REST, CLI and MCP (0045 not applied on dev)';
}

/** Filed: by the CLI on this branch, then MCP; the newest is what the Landing shows. */
async function plansFiled(kit, repo, dir, mcp, { number }, m) {
  const api = kit.pat();
  const filed = await kit.yonedaOk(['flight-plan', '-m', GOAL, '--scope', SCOPE], { cwd: dir, env: kit.env(NO_SESSION) });
  assert.match(filed.stdout + filed.stderr, /Flight plan #\d+ filed for kit\/fly/, `yoneda flight-plan: ${filed.stderr}`);
  const shown = (await api.get(repo.path(`/changes/${number}`))).flight_plan;
  assert.deepEqual([shown?.goal, shown?.scope, shown?.branch], [GOAL, SCOPE, 'kit/fly'], 'the Landing does not show the plan');
  const { token } = await api.post(repo.path('/tokens'), { name: 'kit-reader', scopes: ['read'] });
  try {
    const refused = await kit.pat(token).raw('POST', repo.path('/flight-plans'), { goal: 'Not mine to file', branch: 'kit/fly' });
    assert.equal(refused.status, 403, `a read-only token filed a plan: ${refusal(refused)}`);
  } finally {
    await api.call('DELETE', repo.path('/tokens/kit-reader'));
  }
  const tool = await mcp.tool('git_flight_plan', { repo: repo.id, goal: `${GOAL}, by MCP`, branch: 'kit/fly' });
  assert.ok(tool.plan?.id, `git_flight_plan: ${JSON.stringify(tool).slice(0, 200)}`);
  m.flight_plan = `filed, #${shown.id}, then #${tool.plan.id}`;
}

async function flightPlan(kit, repo, dir, mcp, landing, m) {
  const probe = await kit.pat().raw('POST', repo.path('/flight-plans'), { goal: GOAL, scope: SCOPE, branch: 'kit/fly' });
  if (probe.body?.error?.code === 'NOT_SUPPORTED') return plansNotApplied(kit, repo, dir, mcp, landing, m);
  assert.ok(probe.ok, `POST /flight-plans: ${refusal(probe)}`);
  return plansFiled(kit, repo, dir, mcp, landing, m);
}

const comment = (session, repo, number, body) => session.post(repo.path(`/changes/${number}/comments`), body);

/** One open finding reaches every way a session reads, and an older commit is said to be one. */
async function findings(kit, repo, dir, mcp, { number, head }, m) {
  const api = kit.pat();
  const anchor = { commit: head, path: 'src/net.ts', line: 1, side: 'new' };
  await comment(api, repo, number, { ...anchor, body: FINDING });
  const shown = (await kit.yonedaOk(['change', 'show', String(number)], { cwd: dir, env: kit.env(NO_SESSION) })).stdout;
  assert.ok(shown.includes(`Go-around: 1 open finding on change #${number}`), `yoneda change show: ${shown.slice(0, 500)}`);
  assert.ok(shown.includes(`src/net.ts:1: ${FINDING}`), `the finding's line in yoneda change show: ${shown.slice(0, 500)}`);
  const context = (await kit.yonedaOk(['context'], { cwd: dir, env: kit.env(NO_SESSION) })).stdout;
  assert.ok(context.includes(`Go-around: 1 open finding on change #${number}`) && context.includes(FINDING), `yoneda context: ${context.slice(0, 500)}`);
  const envFile = kit.path('around-claude-env');
  writeFileSync(envFile, '');
  const started = await hook(kit, 'claude-start', { session_id: 'kit-around', cwd: dir, hook_event_name: 'SessionStart', source: 'startup' }, kit.env({ ...NO_SESSION, CLAUDE_ENV_FILE: envFile }));
  assert.ok((JSON.parse(started.stdout || '{}').hookSpecificOutput?.additionalContext ?? '').includes(FINDING), 'a session starting on the branch does not hear of the finding');
  const tool = await mcp.tool('git_context', { repo: repo.id, branch: 'kit/fly' });
  assert.deepEqual([tool.go_around?.open, tool.go_around?.change], [1, number], 'git_context');
  assert.equal(tool.go_around.findings[0].on_head, true, 'a finding on the head is on_head');

  const next = await pushWork(kit, dir, { branch: 'kit/fly', from: null, message: 'Answer the finding', files: { 'src/net.ts': 'export function retry() { return 2; }\n' } });
  const older = await settled(async () => {
    const { go_around: around, head: at } = await api.get(repo.path(`/changes/${number}`));
    return at === next && around;
  }, 'the Landing at its new head');
  assert.equal(older.findings[0].on_head, false, 'the push left the finding on the head');
  const after = (await kit.yonedaOk(['change', 'show', String(number)], { cwd: dir, env: kit.env(NO_SESSION) })).stdout;
  assert.ok(after.includes(`(on older commit ${head.slice(0, 7)})`), `the older commit is not named: ${after.slice(0, 500)}`);
  await comment(api, repo, number, { ...anchor, resolve: true });
  assert.equal((await api.get(repo.path('/context?branch=kit/fly'))).go_around.open, 0, 'a resolved finding stays open');
  m.go_around = 'show,context,start hook,MCP,older commit,resolved';
  return next;
}

/** The switch: a token's open finding refuses landing, for anyone, until it is resolved. */
async function findingsBlock(kit, repo, { number }, head, m) {
  const api = kit.pat();
  await api.call('PUT', repo.path('/auto-landings'), { findings_block: true });
  const { token } = await api.post(repo.path('/tokens'), { name: 'kit-reviewer', scopes: ['read', 'review'] });
  try {
    const anchor = { commit: head, path: 'src/net.ts', line: 1, side: 'new' };
    await comment(kit.pat(token), repo, number, { ...anchor, body: FINDING });
    const gates = await settled(async () => {
      const read = (await api.get(repo.path(`/changes/${number}`))).head_commit?.gates;
      return read?.open_findings === 1 && read;
    }, 'the finding in the head\'s gates');
    assert.equal(gates.ready, false, 'an open finding left the head ready');
    const refused = await api.raw('POST', repo.path('/land'), { ref: 'main', commit: head });
    assert.ok(!refused.ok, `an open finding did not refuse the landing: ${JSON.stringify(refused.body).slice(0, 200)}`);
    await comment(api, repo, number, { ...anchor, resolve: true });
    const landed = await api.post(repo.path('/land'), { ref: 'main', commit: head });
    m.findings_block = `refused ${refusal(refused)}, landed v${landed.version ?? landed.landed_version}`;
  } finally {
    await api.call('DELETE', repo.path('/tokens/kit-reviewer'));
  }
}

/** The Landing's page, for the plan or its absence. */
async function planOnThePage(repo, plan, number, { chrome, account }, m) {
  if (!chrome) return;
  await withChrome({ ...chrome, name: 'flight-plan' }, m, async ({ page, shot }) => {
    await openPage(page, { origin: chrome.origin, account }, repo, `/changes/${number}`);
    const header = page.locator('article.source-change header');
    if (plan) await see(header.getByText(plan.goal), 'the goal on the Landing');
    else await see(header.getByText('No flight plan'), '"No flight plan" on the Landing');
    await shot('flight-plan');
  });
}

/** 36: `chrome` and `account` for the page. */
export async function goAroundFlow(kit, web, m) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const repo = await kitRepo(kit, 'kit-around', { files: { 'src/net.ts': 'export function retry() {}\n' } });
  m.repo = repo.id;
  const dir = await cloneOf(kit, repo, 'around');
  const landing = await landingOn(kit, repo, dir, { branch: 'kit/fly', title: 'Retry less', files: { 'src/net.ts': 'export function retry() { return 3; }\n' } });
  const mcp = await accountMcp(kit);
  await flightPlan(kit, repo, dir, mcp, landing, m);
  const { flight_plan: plan } = await kit.pat().get(repo.path(`/changes/${landing.number}`));
  await planOnThePage(repo, plan, landing.number, web, m);
  const head = await findings(kit, repo, dir, mcp, landing, m);
  await findingsBlock(kit, repo, landing, head, m);
}
