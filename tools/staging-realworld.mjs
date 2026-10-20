#!/usr/bin/env node
// Real-world test kit for the staging stack (dev.yonedarepo.com). An explicit, separate
// command that spends real (cheap) model money and creates projects and repositories:
// project creation, a compare run, owner publish + readback, refresh, an external MCP
// agent, an Artifacts clone checked byte for byte, a container check, 100/1000-writer and
// many-repo bursts, and project deletion. Prints a pass/fail table and writes evidence to
// .local/staging/. Credentials come only from 0600 files in ~/.config/yonedarepo/:
//   staging.env       OWNER_TOKEN (staging-only owner credential)
//   staging-kit.env   KIT_USERNAME / KIT_PASSWORD (created on first run), ZAI_KEY and
//                     MIMO_KEY (placed by the owner; the compare items skip without them)
//   staging-bench.env BENCH_KEY of the staging bench client Worker
// Usage: node tools/staging-realworld.mjs [--only 1,2,5] [--skip-bursts]
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { Recorder, Session, accountSession, kitCredentials, readEnvFile } from './staging/client.mjs';
import { externalAgent } from './staging/mcp-flow.mjs';
import { cloneMatchesApi, containerCheck, manyRepoBurst } from './staging/platform-flow.mjs';
import { CHEAP, compareRun, connectCheapProviders, createProject, deleteProject, ensureAllowance, publish, refreshOther, spend } from './staging/project-flow.mjs';

const { values } = parseArgs({
  options: {
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    platform: { type: 'string', default: 'https://yonedarepo-staging-platform.mlong-f01.workers.dev' },
    client: { type: 'string', default: 'https://yonedarepo-staging-bench.mlong-f01.workers.dev' },
    only: { type: 'string' },
    'skip-bursts': { type: 'boolean', default: false },
  },
});
const root = fileURLToPath(new URL('../', import.meta.url));
const only = values.only ? new Set(values.only.split(',')) : null;
const wanted = (id) => (!only || only.has(id)) && !(values['skip-bursts'] && ['8', '9', '10'].includes(id));

const { OWNER_TOKEN } = readEnvFile('staging.env');
const kit = kitCredentials();
const { BENCH_KEY } = readEnvFile('staging-bench.env', { required: false });
const owner = new Session(values.origin, { bearer: OWNER_TOKEN });
const account = await accountSession(values.origin, kit.KIT_USERNAME, kit.KIT_PASSWORD);
const platformAccount = new Session(`${values.origin}/api/v1`, { cookie: account.cookie });
const keysPresent = CHEAP.every((c) => kit[c.key]);
const rec = new Recorder();
const state = {};
const step = (id, title, run) => (wanted(id) ? rec.step(id, title, run) : null);

await step('0', 'Live revisions (/health)', async (m) => {
  m.front = (await new Session(values.origin).get('/health')).revision;
  m.platform = (await new Session(values.platform).get('/health')).revision;
});
await step('1', 'Create project (browser flow, API)', async (m) => {
  state.project = await createProject(account, `kit-${Date.now()}`, m);
  m.project = state.project.id;
});
await step('2', 'Compare run, cheap real models', async (m) => {
  if (!keysPresent) return { skip: 'ZAI_KEY / MIMO_KEY not in staging-kit.env' };
  if (!state.project) return { skip: 'No project (item 1)' };
  await connectCheapProviders(account, kit);
  await ensureAllowance(account, owner, kit.KIT_USERNAME);
  state.run = await compareRun(account, state.project.id, m);
});
await step('3', 'Owner publish ff-only + readback', async (m) => {
  if (!state.run) return { skip: 'No compare run (item 2)' };
  state.published = await publish(account, state.project.id, state.run, m);
});
await step('4', 'Refresh other result onto new main', async (m) => {
  if (!state.published) return { skip: 'Nothing published (item 3)' };
  return refreshOther(account, state.project.id, state.run, state.published, m);
});
await step('5', 'External agent via remote MCP', async (m) => {
  if (!state.project) return { skip: 'No project (item 1)' };
  await externalAgent(account, state.project, m);
});
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
  await deleteProject(account, state.project, m);
});

const modelSpend = state.run ? spend((await account.get(`/api/repos/${state.project.id}/runs/${state.run.id}`)).run) : 0;
const evidence = { schema: 1, origin: values.origin, platform: values.platform, recorded_at: new Date().toISOString(), model_spend_usd: modelSpend, items: rec.items };
await mkdir(resolve(root, '.local/staging'), { recursive: true });
const file = resolve(root, `.local/staging/realworld-${Date.now()}.json`);
await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\n${rec.table()}\n\nModel spend: $${modelSpend.toFixed(4)}. Evidence: ${file}`);
process.exitCode = rec.items.some((i) => i.status === 'fail') ? 1 : 0;
