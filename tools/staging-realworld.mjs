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
//   staging-bench.env BENCH_KEY of the dev bench client Worker (yonedarepo-dev-bench)
// Usage: node tools/staging-realworld.mjs [--only 1,2,5] [--skip-bursts] [--project <id> --run <a> --run-b <b>]
//        node tools/staging-realworld.mjs --only 12,13,14,15,16,17 [--api <platform origin>] [--cli-bin <dir>]
//        node tools/staging-realworld.mjs --agent-smoke [--smoke-provider zai|mimo] [--smoke-timeout <s>]
//          (= --only 0,smoke: one cheap single-agent run must reach a checked candidate)
//        node tools/staging-realworld.mjs --sandbox-smoke [--smoke-provider zai|mimo] [--agents 1|2] [--smoke-timeout <s>] [--smoke-check-wait <s>]
//          (= --only 0,sandbox: the same brief on runtime sandbox-cli-v1, Claude Code in a
//          Cloudflare Sandbox; passes when the pushed commit is recorded, about 5 min, < $0.01;
//          --agents 2: one compare run, GLM and MiMo each in a sandbox, both must be checked)
//        node tools/staging-realworld.mjs --sandbox-smoke --cli claude|codex|opencode|mimo [...]
//          (every agent runs that stock CLI; codex uses the kit account's saved OpenAI connection)
//        node tools/staging-realworld.mjs --sandbox-smoke --team | --team-conflict | --team-four [...]
//          (an owner-written two-task team: both members land on the team branch through the
//          platform merge and its candidate is eligible; or two tasks on one line: one resume;
//          or four tasks, one pair on one line: landings, server merges, conflicts, resumes)
//        node tools/staging-realworld.mjs --proof tokens|p9 [--trials 3] [--smoke-provider zai|mimo] [--cli ...] [--dry-run]
//          (= --only 0,proof, plan wave 6: tokens = one task with and without the platform's
//          read tools (B10c, C13 P2); p9 = dependency-coupled tasks together vs in git_plan
//          stages, plus a control (C13 P9). Prints an estimate first and stops starting runs at
//          $0.50 metered; --dry-run prints the plan and estimate without credentials or network)
//        node tools/staging-realworld.mjs --model-check
//          (= --only 0,model: a `security` model runner fails a seeded SQL-injection commit and
//          refuses its landing, then passes and lands the fix; one GLM call each, < $0.01;
//          needs the staging platform's REVIEW_MODEL_KEY)
//        node tools/staging-realworld.mjs --webhooks --receiver <origin>
//          (= --only 0,hooks: a hook's signed deliveries to the bench Worker's /hooks/<box>,
//          one scripted failure retried, log order, refusal of an unsafe target, delete)
//        node tools/staging-realworld.mjs --members
//          (= --only 0,members: a second kit account reads, pushes and lands by role with
//          stock Git and REST, and is refused at once when removed)
//        node tools/staging-realworld.mjs --reads-sessions
//          (= --only 0,reads: stock Git over smart HTTP; a push declaring a read that changed
//          meanwhile is refused as a read conflict, lands after git pull, and its session
//          record reads back; zero model spend)
//        node tools/staging-realworld.mjs --fund <username>
//        node tools/staging-realworld.mjs --cleanup-repos <prefix>   (the kit account's repos only)
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { agentSmoke } from './staging/agent-smoke.mjs';
import { proof, proofPlan } from './staging/proof-flow.mjs';
import { sandboxSmoke } from './staging/sandbox-smoke.mjs';
import { accountMcp, cleanupRepos, cliCleanup, revokePat, serverReads } from './staging/cli-account-flow.mjs';
import { cliConcurrency, cliLoginRepo, cliTransactional } from './staging/cli-flow.mjs';
import { CliKit } from './staging/cli-tools.mjs';
import { Recorder, Session, accountSession, kitCredentials, readEnvFile } from './staging/client.mjs';
import { externalAgent } from './staging/mcp-flow.mjs';
import { membersFlow } from './staging/members-flow.mjs';
import { modelCheck } from './staging/model-check-flow.mjs';
import { readsSessionsFlow } from './staging/reads-sessions-flow.mjs';
import { webhookFlow } from './staging/webhook-flow.mjs';
import { cloneMatchesApi, containerCheck, manyRepoBurst } from './staging/platform-flow.mjs';
import { BRIEFS, bindManagedProviders, createProject, deleteProject, ensureAllowance, fundAccount, publish, refreshMerge, spend, startCompare, waitCompare } from './staging/project-flow.mjs';

const { values } = parseArgs({
  options: {
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    platform: { type: 'string', default: 'https://yonedarepo-dev-platform.mlong-f01.workers.dev' },
    client: { type: 'string', default: 'https://yonedarepo-dev-bench.mlong-f01.workers.dev' },
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
    'smoke-provider': { type: 'string' },
    'smoke-timeout': { type: 'string' },
    // How long the sandbox smoke waits for the pushed commit's checks (default 180 s).
    'smoke-check-wait': { type: 'string' },
    // The sandbox smoke's agents: 1 (default) or 2 (one compare run, GLM and MiMo).
    agents: { type: 'string' },
    // The model check gate alone (items 0 and model).
    'model-check': { type: 'boolean', default: false },
    // With --sandbox-smoke: a two-task team run on disjoint files, or on one line.
    team: { type: 'boolean', default: false },
    'team-conflict': { type: 'boolean', default: false },
    'team-four': { type: 'boolean', default: false },
    // A proof flow alone (items 0 and proof): tokens or p9, over --trials rounds.
    proof: { type: 'string' },
    trials: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    // With --sandbox-smoke: the stock CLI every agent runs (default: each provider's default).
    cli: { type: 'string' },
    // The webhook gate alone (items 0 and hooks), against a receiver origin serving
    // /hooks/<box> (tools/fanout-bench/worker.js) that the platform may call.
    webhooks: { type: 'boolean', default: false },
    receiver: { type: 'string' },
    // The members gate alone (items 0 and members).
    members: { type: 'boolean', default: false },
    // The declared-reads and session-records gate alone (items 0 and reads).
    'reads-sessions': { type: 'boolean', default: false },
  },
});
const root = fileURLToPath(new URL('../', import.meta.url));
if (values['dry-run']) {
  if (!values.proof) throw new Error('--dry-run needs --proof tokens|p9');
  console.log(JSON.stringify(proofPlan(values.proof, Number(values.trials ?? 3)), null, 2));
  process.exit(0);
}
const only = values.proof
  ? new Set(['0', 'proof'])
  : values['agent-smoke']
  ? new Set(['0', 'smoke'])
  : values['sandbox-smoke']
    ? new Set(['0', 'sandbox'])
    : values['model-check']
      ? new Set(['0', 'model'])
      : values.webhooks
      ? new Set(['0', 'hooks'])
      : values.members
      ? new Set(['0', 'members'])
      : values['reads-sessions']
      ? new Set(['0', 'reads'])
      : values.only
      ? new Set(values.only.split(','))
      : null;
// The smokes repeat item 2's coverage, so a full kit run leaves them out unless named; the
// model check needs the platform's review key, the webhook gate a receiver and the members
// gate a second account, so they run only when named too.
const wanted = (id) => (only ? only.has(id) : !['smoke', 'sandbox', 'model', 'hooks', 'members', 'reads', 'proof'].includes(id)) && !(values['skip-bursts'] && ['8', '9', '10'].includes(id));

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
await step('sandbox', 'Sandbox smoke: a stock CLI in a Cloudflare Sandbox pushes a checked commit', (m) =>
  sandboxSmoke({ account, owner, username: kit.KIT_USERNAME, provider: values['smoke-provider'], cli: values.cli ?? null, agents: Number(values.agents ?? 1), team: values['team-four'] ? 'four' : values['team-conflict'] ? 'conflict' : values.team ? 'disjoint' : null, timeoutMs: Number(values['smoke-timeout'] ?? (values.team || values['team-conflict'] || values['team-four'] ? 900 : 300)) * 1000, checkWaitMs: Number(values['smoke-check-wait'] ?? 180) * 1000 }, m),
);
await step('proof', `Proof ${values.proof}: stock CLIs in sandboxes as load (plan wave 6)`, (m) =>
  proof({ kind: values.proof, account, owner, username: kit.KIT_USERNAME, provider: values['smoke-provider'], cli: values.cli ?? null, trials: Number(values.trials ?? 3), timeoutMs: Number(values['smoke-timeout'] ?? 900) * 1000, checkWaitMs: Number(values['smoke-check-wait'] ?? 300) * 1000 }, m),
);
await step('hooks', 'Webhooks: signed, ordered, retried deliveries to a receiver', (m) =>
  webhookFlow(platformAccount, { receiver: values.receiver?.replace(/\/$/, ''), key: BENCH_KEY }, m),
);
await step('members', 'Members: a second account reads, pushes and lands by role, removal refuses at once', (m) =>
  membersFlow({ origin: values.origin, api: values.api, kit, platform: platformAccount }, m),
);
await step('reads', 'Declared reads: a stale read is refused on a plain git push; session records', (m) =>
  readsSessionsFlow({ origin: values.origin, api: values.api, platform: platformAccount }, m),
);
await step('6', 'git clone protected main = API tree (bytes)', (m) => cloneMatchesApi(platformAccount, m));
await step('7', 'Check run in a container, 0 left after', (m) => containerCheck(platformAccount, m));
await step('model', 'Model check: vulnerable commit fails and cannot land, the fix passes and lands', (m) => modelCheck(platformAccount, m));

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
const modelSpend = (state.spend ?? itemSpend('2')) + itemSpend('smoke') + itemSpend('sandbox') + itemSpend('model') + itemSpend('proof');
const evidence = { schema: 1, origin: values.origin, platform: values.platform, recorded_at: new Date().toISOString(), model_spend_usd: modelSpend, items: rec.items };
await mkdir(resolve(root, '.local/staging'), { recursive: true });
// Smoke-only evidence keeps its own name: the prod guard reads the newest realworld*.json.
const smoke = ['smoke', 'sandbox', 'model', 'hooks', 'members', 'reads', 'proof'].find((id) => only?.has(id) && [...only].every((i) => ['0', id].includes(i)));
const prefix = { smoke: 'agent-smoke', sandbox: 'sandbox-smoke', model: 'model-check', hooks: 'webhook-gate', members: 'members-gate', reads: 'reads-gate', proof: `proof-${values.proof}` }[smoke] ?? 'realworld';
const file = resolve(root, `.local/staging/${prefix}-${Date.now()}.json`);
await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\n${rec.table()}\n\nModel spend: $${modelSpend.toFixed(4)}. Evidence: ${file}`);
process.exitCode = rec.items.some((i) => i.status === 'fail') ? 1 : 0;
