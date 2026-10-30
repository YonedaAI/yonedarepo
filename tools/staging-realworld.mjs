#!/usr/bin/env node
// Real-world test kit for the dev stack (dev.yonedarepo.com): the source platform used as a
// person, an agent and a script would, with no agent runs. Items: live revisions (0), a git
// clone checked byte for byte against the API (6), a check run in a container (7),
// 100/1000-writer and many-repo bursts (8-10), big clones over Git protocol v2 (19: partial
// with lazy blobs, shallow, deepen, fsck), and the CLI items 12-18: `yoneda login` by
// device flow, `yoneda repo`, plain git through git-remote-yoneda (concurrent pushes,
// conflicts, atomic and killed pushes), the account MCP with a PAT, `--at` reads, a change
// request (18: open, comment, approve, land), a server-side rebase (21: linear in a clone,
// a conflict refused with its paths), cleanup, and log compaction (20: 20,000 versions, a
// bounded SQL tail, `log --at 5` from the R2 segment), and annotated tags and releases (23:
// `git push` of a `git tag -a`, a fresh clone holding the tag object, a release asset whose
// download matches its sha256), and Git LFS (25: `git lfs track`, a --lfs-mb file pushed
// straight to R2, a fresh clone's sha256, a read-only token's upload refused; needs git-lfs).
// The CLI items need
// `cargo build -p yoneda-cli --release` (`--cli-bin` names another directory). Prints a
// pass/fail table and writes evidence to .local/staging/. Credentials come only from 0600
// files in ~/.config/yonedarepo/:
//   staging-kit.env   KIT_USERNAME / KIT_PASSWORD (created on first run)
//   staging-bench.env BENCH_KEY of the dev bench client Worker (yonedarepo-dev-bench)
// Git over SSH (26, opt-in with --ssh: tools/staging/ssh-flow.mjs, through the platform's
// cloudflared ssh_config on the tunnel front door, else at --ssh-host; skipped while /health
// says SSH is off).
// Usage: node tools/staging-realworld.mjs [--only 0,6,7] [--skip-bursts] [--big-files N]
//        node tools/staging-realworld.mjs --only 12,13,14,15,16,18,21,17 [--api <platform origin>] [--cli-bin <dir>]
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
//        node tools/staging-realworld.mjs --forks
//          (= --only 0,22: the second kit account forks a repository it reads, pushes a branch
//          to the fork with stock Git, opens a change on the parent; the owner lands it and a
//          fresh clone of the parent holds the commit; the parent is deleted after the fork)
//        node tools/staging-realworld.mjs --orgs
//          (= --only 0,24: an organization with team "devs" owns a repository granted to the
//          team; the second kit account pushes through the team with an org-limited token and
//          is refused within the 1 s access bound once removed from the team)
//        node tools/staging-realworld.mjs --reads-sessions
//          (= --only 0,reads: stock Git over smart HTTP; a push declaring a read that changed
//          meanwhile is refused as a read conflict, lands after git pull, and its session
//          record reads back; zero model spend)
//        node tools/staging-realworld.mjs --browser [--headed]
//          (= --only 0,browser: headless system Chrome signs the kit account in through the
//          login form, opens a new repository's pages, approves and lands a change request on
//          its Change page, publishes a release with an asset, forks and opens a change on the
//          parent, and creates an org with a team and an org-owned repository; zero model spend. Needs Google Chrome; screenshots in
//          .local/staging/browser-<ts>/. Also part of the full kit)
//        node tools/staging-realworld.mjs --only 0,20 [--compaction-versions 20000]
//          (log compaction: grow a repository's log through POST /refs/batch, compact with the
//          owner's POST /compact until nothing is due, check the bound and reads at version 5)
//        node tools/staging-realworld.mjs --lfs [--lfs-mb 200]
//          (= --only 0,25: Git LFS with stock git-lfs; the file size is --lfs-mb MiB)
//        node tools/staging-realworld.mjs --ssh [--ssh-host ssh.dev.yonedarepo.com] [--ssh-port 22]
//          (= --only 0,26: Git over SSH with stock git and OpenSSH; needs the second account)
//        node tools/staging-realworld.mjs --git-semantics [--ssh]
//          (= --only 0,12,13,18,21,23,27,17 [+26]: L1 of the agent e2e strategy, no model; 27 is
//          tools/staging/git-semantics-flow.mjs, the rest the existing items it builds on)
//        node tools/staging-realworld.mjs --agent-hooks
//          (= --only 0,12,28,17: L2, the Claude Code and opencode plugin hooks against the
//          platform with recorded-shape payloads, no model: tools/staging/agent-hooks-flow.mjs)
//        node tools/staging-realworld.mjs --agents 4 [--agents-wave2 2] [--agent-model <provider/model>]
//          [--agent-timeout 600] [--agent-budget 2]
//          (= --only 0,12,29,17: L3, real opencode agents in parallel, paid, each in its own
//          Docker sandbox; needs Docker and the host opencode's stored credential for the
//          model's provider: tools/staging/agent-run-flow.mjs)
//        node tools/staging-realworld.mjs --visibility
//          (= --only 0,31: a public repository cloned by stock Git with no credentials at all,
//          read through the API and its page without a session, listed by /explore; made
//          private, anonymous reads and fetches are refused within the 1 s access bound:
//          tools/staging/visibility-flow.mjs)
//        node tools/staging-realworld.mjs --cleanup-repos <prefix>   (the kit account's repos only)
//        set -a; . ~/.config/yonedarepo/dev-owner.env; set +a
//        node tools/staging-realworld.mjs --realuser [--realuser-repo claude-code] [--import <name>=<https url|path>]...
//          [--import-defaults] [--realuser-agents N] [--agent-repos a,b] [--realuser-tag]   (--dogfood: alias)
//          (item 30, dev only: the owner's own account (DEV_OWNER_USERNAME / DEV_OWNER_PASSWORD from
//          the environment, never the kit files) on open-source test repositories, never the
//          yonedarepo codebase: imports, clones, everyday Git, a change, reads and sandboxed agents
//          on several repositories at once, on `realuser/<ts>-*` scratch branches only, cleaned up
//          afterwards: tools/staging/realuser-flow.mjs)
//        node tools/staging-realworld.mjs --agent-tools [--agent-tools-repo oss-commander] [--headed]
//          (item 30.6 alone, dev only, the owner's account as for --realuser, which also runs it after
//          30.4: an authored contract read back over MCP, REST, `yoneda context` and turned stale by a
//          change; a pin through branch deletion and a vacuum, then released; a bisect over six scratch
//          commits naming the breaking one (one tiny container check per step, check minutes
//          recorded); Agents -> contracts, pins and bisects in Chrome. Needs the CLI build and Chrome:
//          tools/staging/realuser-agent-tools.mjs)
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { bigClone } from './staging/big-clone-flow.mjs';
import { browserFlow } from './staging/browser-flow.mjs';
import { compactionFlow } from './staging/compaction-flow.mjs';
import { cliChangeRequest } from './staging/change-flow.mjs';
import { accountMcp, cleanupRepos, cliCleanup, revokePat, serverReads } from './staging/cli-account-flow.mjs';
import { cliConcurrency, cliLoginRepo, cliTransactional } from './staging/cli-flow.mjs';
import { CliKit } from './staging/cli-tools.mjs';
import { Recorder, Session, accountSession, kitCredentials, readEnvFile, secondAccount } from './staging/client.mjs';
import { agentHooks } from './staging/agent-hooks-flow.mjs';
import { agentRun } from './staging/agent-run-flow.mjs';
import { forkFlow } from './staging/fork-flow.mjs';
import { gitSemantics } from './staging/git-semantics-flow.mjs';
import { lfsFlow } from './staging/lfs-flow.mjs';
import { sshFlow } from './staging/ssh-flow.mjs';
import { membersFlow } from './staging/members-flow.mjs';
import { modelCheck } from './staging/model-check-flow.mjs';
import { orgsFlow } from './staging/orgs-flow.mjs';
import { readsSessionsFlow } from './staging/reads-sessions-flow.mjs';
import { realuser } from './staging/realuser-flow.mjs';
import { cliRebase } from './staging/rebase-flow.mjs';
import { releasesFlow } from './staging/releases-flow.mjs';
import { visibilityFlow } from './staging/visibility-flow.mjs';
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
    // Item 19's big checkout: files in the one commit a partial clone then checks out.
    'big-files': { type: 'string', default: '12000' },
    'cleanup-repos': { type: 'string' },
    only: { type: 'string' },
    'skip-bursts': { type: 'boolean', default: false },
    // Item 20's log length (the bound is 10,000 versions plus a 1,024-version segment).
    'compaction-versions': { type: 'string', default: '20000' },
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
    // The forks gate alone (items 0 and 22), which needs the second account too.
    forks: { type: 'boolean', default: false },
    // The organizations gate alone (items 0 and 24).
    orgs: { type: 'boolean', default: false },
    // The Git LFS gate alone (items 0 and 25), and item 25's file size in MiB.
    lfs: { type: 'boolean', default: false },
    'lfs-mb': { type: 'string', default: '200' },
    // The Git over SSH gate alone (items 0 and 26), at the SSH front door's host (default: the
    // target environment's) and port.
    ssh: { type: 'boolean', default: false },
    'ssh-host': { type: 'string' },
    'ssh-port': { type: 'string', default: '22' },
    // The declared-reads and session-records gate alone (items 0 and reads).
    'reads-sessions': { type: 'boolean', default: false },
    // Agent e2e gates: L1 Git semantics (27 with the items it builds on), L2 plugin hooks (28),
    // L3 real opencode agents (29: --agents N first-wave agents, then --agents-wave2 more).
    'git-semantics': { type: 'boolean', default: false },
    'agent-hooks': { type: 'boolean', default: false },
    agents: { type: 'string' },
    'agents-wave2': { type: 'string', default: '2' },
    'agent-model': { type: 'string', default: 'zai-coding-plan/glm-5.3' },
    'agent-timeout': { type: 'string', default: '600' },
    'agent-budget': { type: 'string', default: '2' },
    // The browser gate alone (items 0 and browser); --headed shows the Chrome window.
    browser: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    // The public/private repositories gate alone (items 0 and 31).
    visibility: { type: 'boolean', default: false },
    // Item 30: the owner's account on open-source test repositories (no kit account or files).
    realuser: { type: 'boolean', default: false },
    dogfood: { type: 'boolean', default: false },
    'realuser-repo': { type: 'string', default: 'claude-code' },
    'realuser-agents': { type: 'string', default: '0' },
    // Agents' repositories (default: --realuser-repo and the default imports the owner has).
    'agent-repos': { type: 'string' },
    import: { type: 'string', multiple: true },
    'import-defaults': { type: 'boolean', default: false },
    // Tags cannot be deleted on the platform: pushing one leaves realuser/<ts>-tag for good.
    'realuser-tag': { type: 'boolean', default: false },
    // Item 30.6 alone (with the owner's sign-in, repository lookup and cleanup), and its
    // repository: one with Rust, TypeScript or JavaScript functions for the contracts.
    'agent-tools': { type: 'boolean', default: false },
    'agent-tools-repo': { type: 'string', default: 'oss-commander' },
  },
});
const root = fileURLToPath(new URL('../', import.meta.url));
const only = values['git-semantics']
  ? new Set(['0', '12', '13', '18', '21', '23', '27', '17', ...(values.ssh ? ['26'] : [])])
  : values['agent-hooks']
  ? new Set(['0', '12', '28', '17'])
  : values.agents
  ? new Set(['0', '12', '29', '17'])
  : values.ssh
  ? new Set(['0', '26'])
  : values.visibility
  ? new Set(['0', '31'])
  : values.orgs
  ? new Set(['0', '24'])
  : values.lfs
  ? new Set(['0', '25'])
  : values['model-check']
  ? new Set(['0', 'model'])
  : values.webhooks
    ? new Set(['0', 'hooks'])
    : values.members
      ? new Set(['0', 'members'])
      : values.forks
        ? new Set(['0', '22'])
      : values['reads-sessions']
        ? new Set(['0', 'reads'])
        : values.browser
          ? new Set(['0', 'browser'])
          : values.only
            ? new Set(values.only.split(','))
            : null;
// The model check needs the platform's review key, the webhook gate a receiver and the
// members, forks (22) and orgs (24) gates a second account, and real agents (29) spend on a
// model, so a full kit run leaves them out unless named.
const wanted = (id) => (only ? only.has(id) : !['model', 'hooks', 'members', 'reads', '22', '24', '26', '29'].includes(id)) && !(values['skip-bursts'] && ['8', '9', '10'].includes(id));

if (values.prod)
  Object.assign(values, {
    origin: 'https://yonedarepo.com',
    api: 'https://api.yonedarepo.com',
    platform: 'https://yonedarepo-prod-platform.mlong-f01.workers.dev',
  });
values['ssh-host'] ??= values.prod ? 'ssh.yonedarepo.com' : 'ssh.dev.yonedarepo.com';
if (values.realuser || values.dogfood || values['agent-tools']) {
  assert.ok(!values.prod, '--realuser runs on dev only');
  const code = await realuser(values, root);
  await new Promise((done) => process.stdout.write('', done));
  process.exit(code);
}
const kit = kitCredentials();
const { BENCH_KEY } = readEnvFile('staging-bench.env', { required: false });
const account = await accountSession(values.origin, kit.KIT_USERNAME, kit.KIT_PASSWORD);
// The kit account's name and the identifier that signs it in: its username, or (an account
// made after email-only sign-up) its test address, whose handle the platform chose.
Object.assign(kit, { KIT_ACCOUNT: account.name, KIT_LOGIN: account.identifier });
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
await step('22', 'Forks: a reader forks, pushes to the fork, opens a change on the parent; it lands and clones', (m) =>
  forkFlow({ origin: values.origin, api: values.api, kit, platform: platformAccount }, m),
);
await step('24', 'Orgs: a team member pushes to an org repository; removal from the team refuses within 1 s', (m) =>
  orgsFlow({ origin: values.origin, api: values.api, kit, platform: platformAccount }, m),
);
await step('reads', 'Declared reads: a stale read is refused on a plain git push; session records', (m) =>
  readsSessionsFlow({ origin: values.origin, api: values.api, platform: platformAccount }, m),
);
await step('browser', 'Browser: sign in, source pages, a change landed, releases, forks and orgs in the UI', (m) =>
  browserFlow({ origin: values.origin, api: values.api, kit, root, headed: values.headed }, m),
);
await step('31', 'Visibility: anonymous stock-Git clone and page of a public repository; private refuses within 1 s', (m) =>
  visibilityFlow({ origin: values.origin, api: values.api, platform: platformAccount }, m),
);
await step('6', 'git clone protected main = API tree (bytes)', (m) => cloneMatchesApi(platformAccount, m));
await step('7', 'Check run in a container, 0 left after', (m) => containerCheck(platformAccount, m));
await step('19', 'Big clone: partial (blob:none, lazy blobs, < 10% of full), shallow, deepen, fsck', (m) =>
  bigClone({ api: values.api, platform: platformAccount, bigFiles: Number(values['big-files']) }, m),
);
await step('model', 'Model check: vulnerable commit fails and cannot land, the fix passes and lands', (m) => modelCheck(platformAccount, m));
await step('20', 'Log compaction: 20k versions, bounded SQL tail, log --at 5 from R2', (m) =>
  compactionFlow(platformAccount, m, { versions: Number(values['compaction-versions']) }),
);
await step('23', 'Annotated tag push + fresh clone (cat-file -t = tag), release with an asset (sha256)', (m) =>
  releasesFlow({ origin: values.origin, api: values.api, platform: platformAccount }, m),
);
await step('25', `Git LFS: track *.bin, push ${values['lfs-mb']} MiB to R2, fresh clone sha256 matches, read-only upload refused`, (m) =>
  lfsFlow({ api: values.api, platform: platformAccount, mb: Number(values['lfs-mb']) }, m),
);
await step('26', `Git over SSH at ${values['ssh-host']}:${values['ssh-port']}: v2, partial and shallow clones, push, delete, refusals, removal stops an open session`, async (m) => {
  const health = await new Session(values.platform).get('/health');
  if (!health.ssh) return { skip: 'Git over SSH is off on this platform (SSH_FRONT_DOOR)' };
  // The tunnel front door: the flow uses the platform's ssh_config, whose ProxyCommand is cloudflared.
  if (health.ssh === 'tunnel' && spawnSync('cloudflared', ['--version']).status !== 0)
    return { skip: 'cloudflared is not installed (brew install cloudflared); the tunnel front door needs it' };
  const { session: other } = await secondAccount(values.origin, kit);
  return sshFlow({ platform: platformAccount, other, sshHost: values['ssh-host'], sshPort: Number(values['ssh-port']) }, m);
});

const execFileAsync = promisify(execFile);
/** `<what>_errors` and `<what>_failures` of a bench section, when it has any. */
const failureMetrics = (what, section) =>
  section.errors?.length ? { [`${what}_errors`]: Object.fromEntries(section.errors), [`${what}_failures`]: section.failures } : {};
async function fanout(writers, m) {
  if (!BENCH_KEY) return { skip: 'BENCH_KEY not in staging-bench.env' };
  const env = { ...process.env, YONEDA_USERNAME: kit.KIT_LOGIN, YONEDA_PASSWORD: kit.KIT_PASSWORD, BENCH_KEY };
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
    read_p95_ms: result.read.client.p95_ms,
    read_max_ms: result.read.client.max_ms,
    // Where the slowest correct reads waited (their Server-Timing `read.*` phases).
    read_slowest: result.read.slowest,
    // So a failed run explains itself: each failure kind counted (`<status> <code>:
    // <message>`), the first failures with when they started, how long they took and their
    // Server-Timing, and the phases of the failed reads.
    ...failureMetrics('commit', result.commit),
    ...failureMetrics('land', result.land),
    ...failureMetrics('read', result.read),
    read_failed_phases: Object.fromEntries(Object.entries(result.read.failed_phases ?? {}).map(([k, v]) => [k, `${v.p50_ms}/${v.max_ms}`])),
  });
  if (result.land.ok !== writers || result.read.correct !== writers) throw new Error(`${result.land.ok}/${writers} landed, ${result.read.correct}/${writers} read back`);
}
await step('8', '100-writer burst (platform API)', (m) => fanout(100, m));
await step('9', '1000-writer burst (platform API)', (m) => fanout(1000, m));
await step('10', 'Many-repo burst (20 repos x 10 writers)', (m) =>
  BENCH_KEY ? manyRepoBurst(platformAccount, { client: values.client, key: BENCH_KEY, target: values.platform }, m) : { skip: 'BENCH_KEY not in staging-bench.env' },
);
if (['12', '13', '14', '15', '16', '17', '18', '21', '27', '28', '29'].some(wanted)) {
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
    await step('21', 'CLI: server-side rebase (linear in a clone, conflict refused, repo deleted)', (m) => cliRebase(cli, m));
    await step('27', 'Git semantics (L1): v2/partial/shallow clones, branch, rebase, merge, cherry-pick, revert, tag, conflict, change, MCP, LFS', (m) =>
      gitSemantics(cli, { platform: platformAccount }, m),
    );
    await step('28', 'Agent hooks (L2): Claude Code and opencode plugins start with context, record reads and sessions', (m) => agentHooks(cli, m));
    await step('29', `Real agents (L3): ${values.agents ?? 0} + ${values['agents-wave2']} opencode agents (${values['agent-model']}) in parallel on one repository`, (m) =>
      agentRun(
        cli,
        {
          root,
          agents: Number(values.agents),
          wave2: Number(values['agents-wave2']),
          model: values['agent-model'],
          timeoutS: Number(values['agent-timeout']),
          budgetUsd: Number(values['agent-budget']),
        },
        m,
      ),
    );
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
const smoke = ['model', 'hooks', 'members', 'reads', 'browser', '22', '24', '25', '26', '31'].find((id) => only?.has(id) && [...only].every((i) => ['0', id].includes(i)));
const gate = values['git-semantics'] ? 'git-semantics-gate' : values['agent-hooks'] ? 'agent-hooks-gate' : values.agents ? 'agents-gate' : null;
const prefix = gate ?? { model: 'model-check', hooks: 'webhook-gate', members: 'members-gate', reads: 'reads-gate', browser: 'browser-gate', 22: 'forks-gate', 24: 'orgs-gate', 25: 'lfs-gate', 31: 'visibility-gate' }[smoke] ?? (values.prod ? 'prod-smoke' : 'realworld');
const file = resolve(root, `.local/staging/${prefix}-${Date.now()}.json`);
await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\n${rec.table()}\n\nEvidence: ${file}`);
process.exitCode = rec.items.some((i) => i.status === 'fail') ? 1 : 0;
