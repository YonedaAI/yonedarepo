#!/usr/bin/env node
// Real-world test kit for the staging stack (dev.yonedarepo.com). An explicit, separate
// command that spends real (cheap) model money and creates projects and repositories:
// project creation, two compare runs, owner publish + readback, refresh merge, an external MCP
// agent, an Artifacts clone checked byte for byte, a container check, 100/1000-writer and
// many-repo bursts, and project deletion. Items 12-17 use the git platform without the agents
// website (zero model spend): `yoneda login` by device flow, `yoneda repo`, plain git through
// git-remote-yoneda (concurrent pushes, conflicts, atomic and killed pushes), the account MCP
// with a PAT, `--at` reads and cleanup. They need `cargo build -p yoneda-cli --release`
// (`--cli-bin` names another directory). Prints a pass/fail table and writes evidence to
// .local/staging/. Credentials come only from 0600 files in ~/.config/yonedarepo/:
//   staging.env       OWNER_TOKEN (staging-only owner credential)
//   staging-kit.env   KIT_USERNAME / KIT_PASSWORD (created on first run)
// Model keys stay in the Secrets Store: the owner route binds them to the kit account as
// managed connections (MANAGED_PROVIDER_KEYS, staging only).
//   staging-bench.env BENCH_KEY of the staging bench client Worker
// Usage: node tools/staging-realworld.mjs [--only 1,2,5] [--skip-bursts] [--project <id> --run <a> --run-b <b>]
//        node tools/staging-realworld.mjs --only 12,13,14,15,16,17 [--api <platform origin>] [--cli-bin <dir>]
//        node tools/staging-realworld.mjs --agent-smoke [--smoke-provider zai|mimo] [--smoke-timeout <s>]
//          (= --only 0,smoke: one cheap single-agent run must reach a checked candidate)
//        node tools/staging-realworld.mjs --sandbox-smoke [--smoke-provider zai|mimo] [--smoke-timeout <s>] [--smoke-check-wait <s>]
//          (= --only 0,sandbox: the same brief on runtime sandbox-cli-v1, Claude Code in a
//          Cloudflare Sandbox; passes when the pushed commit is recorded, about 5 min, < $0.01)
//        node tools/staging-realworld.mjs --fund <username>
//        node tools/staging-realworld.mjs --cleanup-repos <prefix>   (the kit account's repos only)
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { agentSmoke } from './staging/agent-smoke.mjs';
import { sandboxSmoke } from './staging/sandbox-smoke.mjs';
import { accountMcp, cleanupRepos, cliCleanup, revokePat, serverReads } from './staging/cli-account-flow.mjs';
import { cliConcurrency, cliLoginRepo, cliTransactional } from './staging/cli-flow.mjs';
import { CliKit } from './staging/cli-tools.mjs';
import { Recorder, Session, accountSession, kitCredentials, readEnvFile } from './staging/client.mjs';
import { externalAgent } from './staging/mcp-flow.mjs';
import { cloneMatchesApi, containerCheck, manyRepoBurst } from './staging/platform-flow.mjs';
import { BRIEFS, bindManagedProviders, createProject, deleteProject, ensureAllowance, fundAccount, publish, refreshMerge, spend, startCompare, waitCompare } from './staging/project-flow.mjs';

const { values } = parseArgs({
  options: {
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    platform: { type: 'string', default: 'https://yonedarepo-staging-platform.mlong-f01.workers.dev' },
    client: { type: 'string', default: 'https://yonedarepo-staging-bench.mlong-f01.workers.dev' },
    // The platform API's own host, for the CLI items (yoneda::<api>/<repo> remotes, account MCP).
    api: { type: 'string', default: 'https://api.dev.yonedarepo.com' },
    'cli-bin': { type: 'string' },
    'cleanup-repos': { type: 'string' },
    only: { type: 'string' },
    // Resume items 3-4 on an existing project and finished compare run (ids from evidence).
    // Fund a person's own staging account (managed models + $5) and exit; no kit items run.
    fund: { type: 'string' },
    project: { type: 'string' },
    run: { type: 'string' },
    'run-b': { type: 'string' },
    'skip-bursts': { type: 'boolean', default: false },
    // The post-deploy agent smoke alone (items 0 and smoke); `--only smoke` also selects it.
    'agent-smoke': { type: 'boolean', default: false },
    // The sandbox-cli-v1 smoke alone (items 0 and sandbox).
    'sandbox-smoke': { type: 'boolean', default: false },
    'smoke-provider': { type: 'string', default: 'zai' },
    'smoke-timeout': { type: 'string' },
    // How long the sandbox smoke waits for the pushed commit's checks (default 180 s).
    'smoke-check-wait': { type: 'string' },
  },
});
const root = fileURLToPath(new URL('../', import.meta.url));
const only = values['agent-smoke']
  ? new Set(['0', 'smoke'])
  : values['sandbox-smoke']
    ? new Set(['0', 'sandbox'])
    : values.only
      ? new Set(values.only.split(','))
      : null;
// The smokes repeat item 2's coverage, so a full kit run leaves them out unless named.
const wanted = (id) => (only ? only.has(id) : !['smoke', 'sandbox'].includes(id)) && !(values['skip-bursts'] && ['8', '9', '10'].includes(id));

const { OWNER_TOKEN } = readEnvFile('staging.env');
if (values.fund) {
  const funded = await fundAccount(new Session(values.origin, { bearer: OWNER_TOKEN }), values.fund);
  console.log(`Funded ${values.fund}: managed-zai + managed-mimo, ${funded.already_funded ? 'allowance already set' : `$${funded.limit_microusd / 1e6} allowance`}`);
  process.exit(0);
}
const kit = kitCredentials();
const { BENCH_KEY } = readEnvFile('staging-bench.env', { required: false });
const owner = new Session(values.origin, { bearer: OWNER_TOKEN });
const account = await accountSession(values.origin, kit.KIT_USERNAME, kit.KIT_PASSWORD);
const platformAccount = new Session(`${values.origin}/api/v1`, { cookie: account.cookie });
if (values['cleanup-repos']) {
  const cleaned = await cleanupRepos(platformAccount, values['cleanup-repos']);
  console.log(`Deleted ${cleaned.deleted} repositories named ${cleaned.prefix}*${cleaned.failed.length ? `; ${cleaned.failed.length} failed: ${JSON.stringify(cleaned.failed)}` : ''}`);
  process.exit(cleaned.failed.length ? 1 : 0);
}
const rec = new Recorder();
const state = {};
if (values.project) state.project = await account.get(`/api/projects/${values.project}`);
const runOf = async (id) => (await account.get(`/api/repos/${values.project}/runs/${id}`)).run;
if (values.project && values.run) state.run = await runOf(values.run);
if (values.project && values['run-b']) state.runB = await runOf(values['run-b']);
const step = (id, title, run) => (wanted(id) ? rec.step(id, title, run) : null);

await step('0', 'Live revisions (/health)', async (m) => {
  m.front = (await new Session(values.origin).get('/health')).revision;
  m.platform = (await new Session(values.platform).get('/health')).revision;
});
await step('1', 'Create project (browser flow, API)', async (m) => {
  state.project = await createProject(account, `kit-${Date.now()}`, m);
  m.project = state.project.id;
});
await step('2', 'Two compare runs (A, B), cheap real models', async (m) => {
  if (!state.project) return { skip: 'No project (item 1)' };
  await bindManagedProviders(owner, kit.KIT_USERNAME);
  await ensureAllowance(account, owner, kit.KIT_USERNAME);
  // Both start on the same main, so B's pick is stale once A is published (item 4).
  const [a, b] = [await startCompare(account, state.project.id, BRIEFS.a), await startCompare(account, state.project.id, BRIEFS.b)];
  const [ma, mb] = [{}, {}];
  [state.run, state.runB] = await Promise.all([waitCompare(account, state.project.id, a, ma), waitCompare(account, state.project.id, b, mb)]);
  Object.assign(m, { run_a: ma.run, a: ma.comparison, run_b: mb.run, b: mb.comparison, spend_usd: (Number(ma.spend_usd) + Number(mb.spend_usd)).toFixed(4) });
});
await step('3', 'Owner publish ff-only + readback', async (m) => {
  if (!state.run) return { skip: 'No compare run (item 2)' };
  state.published = await publish(account, state.project.id, state.run, m);
});
await step('4', "Refresh B's pick onto the new main, publish B (N8 step 12)", async (m) => {
  if (!state.published || !state.runB) return { skip: 'Needs A published and run B (items 2-3)' };
  await refreshMerge(account, state.project.id, state.runB, m);
});
await step('5', 'External agent via remote MCP', async (m) => {
  if (!state.project) return { skip: 'No project (item 1)' };
  await externalAgent(account, state.project, m);
});
await step('smoke', 'Agent smoke: one cheap agent to a checked candidate', (m) =>
  agentSmoke({ account, owner, username: kit.KIT_USERNAME, provider: values['smoke-provider'], timeoutMs: Number(values['smoke-timeout'] ?? 360) * 1000 }, m),
);
await step('sandbox', 'Sandbox smoke: Claude Code in a Cloudflare Sandbox pushes a checked commit', (m) =>
  sandboxSmoke({ account, owner, username: kit.KIT_USERNAME, provider: values['smoke-provider'], timeoutMs: Number(values['smoke-timeout'] ?? 300) * 1000, checkWaitMs: Number(values['smoke-check-wait'] ?? 180) * 1000 }, m),
);
await step('6', 'git clone protected main = API tree (bytes)', (m) => cloneMatchesApi(platformAccount, m));
await step('7', 'Check run in a container, 0 left after', (m) => containerCheck(platformAccount, m));

const execFileAsync = promisify(execFile);
async function fanout(writers, m) {
  if (!BENCH_KEY) return { skip: 'BENCH_KEY not in staging-bench.env' };
  const env = { ...process.env, YONEDA_USERNAME: kit.KIT_USERNAME, YONEDA_PASSWORD: kit.KIT_PASSWORD, BENCH_KEY };
  const args = ['tools/platform-fanout-bench.mjs', '--url', values.platform, '--client', values.client, '--writers', String(writers)];
  const { stdout } = await execFileAsync(process.execPath, args, { cwd: root, env, maxBuffer: 64 << 20, timeout: 30 * 60_000 });
  const { result } = JSON.parse(stdout);
  Object.assign(m, {
    lands_ok: result.land.ok,
    reads_ok: result.read.correct,
    elapsed_s: (result.elapsed_ms / 1000).toFixed(1),
    lands_per_s: (result.land.ok / (result.elapsed_ms / 1000)).toFixed(1),
    land_p95_ms: result.land.client.p95_ms,
    commit_p95_ms: result.commit.client.p95_ms,
  });
  if (result.land.ok !== writers || result.read.correct !== writers) throw new Error(`${result.land.ok}/${writers} landed, ${result.read.correct}/${writers} read back`);
}
await step('8', '100-writer burst (platform API)', (m) => fanout(100, m));
await step('9', '1000-writer burst (platform API)', (m) => fanout(1000, m));
await step('10', 'Many-repo burst (20 repos x 10 writers)', (m) =>
  BENCH_KEY ? manyRepoBurst(platformAccount, { client: values.client, key: BENCH_KEY, target: values.platform }, m) : { skip: 'BENCH_KEY not in staging-bench.env' },
);
await step('11', 'Delete test project, token revoked', async (m) => {
  if (!state.project) return { skip: 'No project (item 1)' };
  // Read the run's settled spend first: a deleted project's history is gone (410).
  const runSpend = async (run) => (run ? spend((await account.get(`/api/repos/${state.project.id}/runs/${run.id}`)).run) : 0);
  if (state.run) state.spend = (await runSpend(state.run)) + (await runSpend(state.runB));
  await deleteProject(account, state.project, m);
});

if (['12', '13', '14', '15', '16', '17'].some(wanted)) {
  const cli = new CliKit({ api: values.api, bin: values['cli-bin'] ?? resolve(root, 'target/release'), platformAccount });
  const repo = {};
  try {
    await step('12', 'CLI: device login, repo create, clone, push, exact ids', (m) => cliLoginRepo(cli, repo, m));
    await step('13', 'CLI: concurrent pushes (server merge, same-line conflict)', (m) => cliConcurrency(cli, repo, m));
    await step('14', 'CLI: atomic push with a stale branch, killed push', (m) => cliTransactional(cli, repo, m));
    await step('15', 'Account MCP with a PAT (round trip, allowlist)', (m) => accountMcp(cli, repo, m));
    await step('16', 'Server-side reads at a version (log, grep, blame --at)', (m) => serverReads(cli, repo, m));
    await step('17', 'Delete kit repos via yoneda, 404 after, PAT revoked', (m) => cliCleanup(cli, m));
  } finally {
    // Never leave a live token behind; leftover repos: --cleanup-repos kit-cli / kit-mcp.
    await revokePat(cli).catch((e) => console.error(`Revoking the kit PAT failed: ${e.message}`));
    if (cli.repos.length) console.error(`Left repositories: ${cli.repos.map((r) => r.name).join(', ')}`);
    cli.dispose();
  }
}

// A failed run still spent money: its last observed spend is in item 2's metrics.
const itemSpend = (id) => Number(rec.items.find((i) => i.id === id)?.metrics.spend_usd ?? 0);
const modelSpend = (state.spend ?? itemSpend('2')) + itemSpend('smoke') + itemSpend('sandbox');
const evidence = { schema: 1, origin: values.origin, platform: values.platform, recorded_at: new Date().toISOString(), model_spend_usd: modelSpend, items: rec.items };
await mkdir(resolve(root, '.local/staging'), { recursive: true });
// Smoke-only evidence keeps its own name: the prod guard reads the newest realworld*.json.
const smoke = ['smoke', 'sandbox'].find((id) => only?.has(id) && [...only].every((i) => ['0', id].includes(i)));
const file = resolve(root, `.local/staging/${smoke === 'smoke' ? 'agent-smoke' : smoke === 'sandbox' ? 'sandbox-smoke' : 'realworld'}-${Date.now()}.json`);
await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\n${rec.table()}\n\nModel spend: $${modelSpend.toFixed(4)}. Evidence: ${file}`);
process.exitCode = rec.items.some((i) => i.status === 'fail') ? 1 : 0;
