#!/usr/bin/env node
// Real-world test kit for the dev stack (dev.yonedarepo.com): the source platform used as a
// person, an agent and a script would, with no agent runs. Items: live revisions (0), a git
// clone checked byte for byte against the API (6), a check run in a container (7),
// 100/1000-writer and many-repo bursts (8-10), and the CLI items 12-18: `yoneda login` by
// device flow, `yoneda repo`, plain git through git-remote-yoneda (concurrent pushes,
// conflicts, atomic and killed pushes), the account MCP with a PAT, `--at` reads, a change
// request (18: open, comment, approve, land) and cleanup. They need
// `cargo build -p yoneda-cli --release` (`--cli-bin` names another directory). Prints a
// pass/fail table and writes evidence to .local/staging/. Credentials come only from 0600
// files in ~/.config/yonedarepo/:
//   staging-kit.env   KIT_USERNAME / KIT_PASSWORD (created on first run)
//   staging-bench.env BENCH_KEY of the dev bench client Worker (yonedarepo-dev-bench)
// Usage: node tools/staging-realworld.mjs [--only 0,6,7] [--skip-bursts]
//        node tools/staging-realworld.mjs --only 12,13,14,15,16,18,17 [--api <platform origin>] [--cli-bin <dir>]
//        node tools/staging-realworld.mjs --prod --only 0,browser,12,13,14,15,16,17   (prod smoke)
//        node tools/staging-realworld.mjs --model-check
//          (= --only 0,model: a `security` model runner fails a seeded SQL-injection commit and
//          refuses its landing, then passes and lands the fix; one platform AI check call
//          each, < $0.01; needs the platform's REVIEW_MODEL_KEY)
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
//        node tools/staging-realworld.mjs --browser [--headed]
//          (= --only 0,browser: headless system Chrome signs the kit account in through the
//          login form, opens a new repository's pages, and approves and lands a change request
//          on its Change page; zero model spend. Needs Google Chrome; screenshots in
//          .local/staging/browser-<ts>/. Also part of the full kit)
//        node tools/staging-realworld.mjs --cleanup-repos <prefix>   (the kit account's repos only)
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { browserFlow } from './staging/browser-flow.mjs';
import { cliChangeRequest } from './staging/change-flow.mjs';
import { accountMcp, cleanupRepos, cliCleanup, revokePat, serverReads } from './staging/cli-account-flow.mjs';
import { cliConcurrency, cliLoginRepo, cliTransactional } from './staging/cli-flow.mjs';
import { CliKit } from './staging/cli-tools.mjs';
import { Recorder, Session, accountSession, kitCredentials, readEnvFile } from './staging/client.mjs';
import { membersFlow } from './staging/members-flow.mjs';
import { modelCheck } from './staging/model-check-flow.mjs';
import { readsSessionsFlow } from './staging/reads-sessions-flow.mjs';
import { webhookFlow } from './staging/webhook-flow.mjs';
import { cloneMatchesApi, containerCheck, manyRepoBurst } from './staging/platform-flow.mjs';

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
    'skip-bursts': { type: 'boolean', default: false },
    // Prod smoke: prod hosts, evidence prod-smoke-*.json (never realworld*, the prod deploy
    // guard's dev evidence). Pass --only with the items.
    prod: { type: 'boolean', default: false },
    // The model check gate alone (items 0 and model).
    'model-check': { type: 'boolean', default: false },
    // The webhook gate alone (items 0 and hooks), against a receiver origin serving
    // /hooks/<box> (tools/fanout-bench/worker.js) that the platform may call.
    webhooks: { type: 'boolean', default: false },
    receiver: { type: 'string' },
    // The members gate alone (items 0 and members).
    members: { type: 'boolean', default: false },
    // The declared-reads and session-records gate alone (items 0 and reads).
    'reads-sessions': { type: 'boolean', default: false },
    // The browser gate alone (items 0 and browser); --headed shows the Chrome window.
    browser: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
  },
});
const root = fileURLToPath(new URL('../', import.meta.url));
const only = values['model-check']
  ? new Set(['0', 'model'])
  : values.webhooks
    ? new Set(['0', 'hooks'])
    : values.members
      ? new Set(['0', 'members'])
      : values['reads-sessions']
        ? new Set(['0', 'reads'])
        : values.browser
          ? new Set(['0', 'browser'])
          : values.only
            ? new Set(values.only.split(','))
            : null;
// The model check needs the platform's review key, the webhook gate a receiver and the
// members gate a second account, so a full kit run leaves them out unless named.
const wanted = (id) => (only ? only.has(id) : !['model', 'hooks', 'members', 'reads'].includes(id)) && !(values['skip-bursts'] && ['8', '9', '10'].includes(id));

if (values.prod)
  Object.assign(values, {
    origin: 'https://yonedarepo.com',
    api: 'https://api.yonedarepo.com',
    platform: 'https://yonedarepo-prod-platform.mlong-f01.workers.dev',
  });
const kit = kitCredentials();
const { BENCH_KEY } = readEnvFile('staging-bench.env', { required: false });
const account = await accountSession(values.origin, kit.KIT_USERNAME, kit.KIT_PASSWORD);
const platformAccount = new Session(`${values.origin}/api/v1`, { cookie: account.cookie });
if (values['cleanup-repos']) {
  const cleaned = await cleanupRepos(platformAccount, values['cleanup-repos']);
  console.log(`Deleted ${cleaned.deleted} repositories named ${cleaned.prefix}*${cleaned.failed.length ? `; ${cleaned.failed.length} failed: ${JSON.stringify(cleaned.failed)}` : ''}`);
  process.exit(cleaned.failed.length ? 1 : 0);
}
const rec = new Recorder();
const step = (id, title, run) => (wanted(id) ? rec.step(id, title, run) : null);

await step('0', 'Live revisions (/health)', async (m) => {
  m.front = (await new Session(values.origin).get('/health')).revision;
  m.platform = (await new Session(values.platform).get('/health')).revision;
});
await step('hooks', 'Webhooks: signed, ordered, retried deliveries to a receiver', (m) =>
  webhookFlow(platformAccount, { receiver: values.receiver?.replace(/\/$/, ''), key: BENCH_KEY }, m),
);
await step('members', 'Members: a second account reads, pushes and lands by role, removal refuses at once', (m) =>
  membersFlow({ origin: values.origin, api: values.api, kit, platform: platformAccount }, m),
);
await step('reads', 'Declared reads: a stale read is refused on a plain git push; session records', (m) =>
  readsSessionsFlow({ origin: values.origin, api: values.api, platform: platformAccount }, m),
);
await step('browser', 'Browser: sign in, source pages, a change request approved and landed in the UI', (m) =>
  browserFlow({ origin: values.origin, api: values.api, kit, root, headed: values.headed }, m),
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
if (['12', '13', '14', '15', '16', '17', '18'].some(wanted)) {
  const cli = new CliKit({ api: values.api, bin: values['cli-bin'] ?? resolve(root, 'target/release'), platformAccount });
  const repo = {};
  try {
    await step('12', 'CLI: device login, repo create, clone, push, exact ids', (m) => cliLoginRepo(cli, repo, m));
    await step('13', 'CLI: concurrent pushes (server merge, same-line conflict)', (m) => cliConcurrency(cli, repo, m));
    await step('14', 'CLI: atomic push with a stale branch, killed push', (m) => cliTransactional(cli, repo, m));
    await step('15', 'Account MCP with a PAT (round trip, allowlist)', (m) => accountMcp(cli, repo, m));
    await step('16', 'Server-side reads at a version (log, grep, blame --at)', (m) => serverReads(cli, repo, m));
    // Before 17, whose cleanup deletes its repository too.
    await step('18', 'CLI: change request (branch, open, line comment, approve, land, landed)', (m) => cliChangeRequest(cli, kit, m));
    await step('17', 'Delete kit repos via yoneda, 404 after, PAT revoked', (m) => cliCleanup(cli, m));
  } finally {
    // Never leave a live token behind; leftover repos: --cleanup-repos kit-cli / kit-mcp.
    await revokePat(cli).catch((e) => console.error(`Revoking the kit PAT failed: ${e.message}`));
    if (cli.repos.length) console.error(`Left repositories: ${cli.repos.map((r) => r.name).join(', ')}`);
    cli.dispose();
  }
}

// Only the model check calls a model (the platform's own AI check, < $0.01).
const evidence = { schema: 1, origin: values.origin, platform: values.platform, recorded_at: new Date().toISOString(), items: rec.items };
await mkdir(resolve(root, '.local/staging'), { recursive: true });
// Smoke-only evidence keeps its own name: the prod guard reads the newest realworld*.json.
const smoke = ['model', 'hooks', 'members', 'reads', 'browser'].find((id) => only?.has(id) && [...only].every((i) => ['0', id].includes(i)));
const prefix = { model: 'model-check', hooks: 'webhook-gate', members: 'members-gate', reads: 'reads-gate', browser: 'browser-gate' }[smoke] ?? (values.prod ? 'prod-smoke' : 'realworld');
const file = resolve(root, `.local/staging/${prefix}-${Date.now()}.json`);
await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\n${rec.table()}\n\nEvidence: ${file}`);
process.exitCode = rec.items.some((i) => i.status === 'fail') ? 1 : 0;
