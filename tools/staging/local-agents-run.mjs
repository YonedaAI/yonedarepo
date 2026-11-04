// Step 6 of the local repository plan (docs/local-repository-future.md): two real agents,
// each in its own sandbox container (agent-sandbox.mjs: only its clone mounted, a throwaway
// HOME, no host Git config or credentials, egress only to the model API and the service),
// landing on one clone's local service (`yoneda-local serve`), which syncs with dev.
//
// A small open-source repository is cloned fresh into a temporary directory (never this
// codebase), set up with `yoneda-local init` (pairing creates `local-sync-test-agents-<ts>` on
// dev through the stored login) and served on loopback. Each agent gets its own local token
// (`yoneda-local token create`) and its own stock Git clone whose only remote is the service at
// host.docker.internal. Scenario a: same base, disjoint files, both push their branch and then
// main. Scenario b: same base, the same line of one file, each pushes once and does not retry.
// Before and after, the host checkouts and their remotes are snapshotted (hostState); any
// change fails the run. Evidence in .local/staging/local-agents-<ts>/ (tokens scrubbed).
//
//   node tools/staging/local-agents-run.mjs --bin <yoneda-local> [--model zai-coding-plan/glm-5.3]
//     [--repo https://github.com/spf13/pflag] [--timeout 600] [--budget 2]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitConfigEnv } from '../own-traffic.mjs';
import { opencodeArgs, printable } from './agent-run-plan.mjs';
import { hostProblems, runAgent, spendBudget } from './agent-run-flow.mjs';
import { clientEnv, egressAllowlist, IMAGE, sandboxArgs, sandboxEnv } from './agent-sandbox.mjs';
import { hostState, modelCredential, startEgress } from './agent-sandbox-host.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const BIN = arg('bin');
const MODEL = arg('model', 'zai-coding-plan/glm-5.3');
const REPO = arg('repo', 'https://github.com/spf13/pflag');
const TIMEOUT_S = Number(arg('timeout', '600'));
const BUDGET = Number(arg('budget', '2'));
if (!BIN) throw new Error('--bin <path to yoneda-local> is required');

const ts = Date.now();
const root = realpathSync(new URL('../..', import.meta.url).pathname);
const main = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).stdout.trim().replace(/\/\.git$/, '');
const evidence = join(main, '.local/staging', `local-agents-${ts}`);
mkdirSync(evidence, { recursive: true });
const work = realpathSync(mkdtempSync(join(tmpdir(), 'local-agents-')));
const secrets = new Set();
const scrub = (text) => [...secrets].reduce((t, s) => t.split(s).join('<token>'), String(text));
const note = (line) => {
  console.log(scrub(line));
  writeFileSync(join(evidence, 'run.log'), `${scrub(line)}\n`, { flag: 'a' });
};

function sh(cmd, args, { cwd, env = {}, ok = true } = {}) {
  const done = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 1 << 26 });
  if (ok && done.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${scrub(done.stderr || done.stdout).slice(-600)}`);
  return { code: done.status, out: (done.stdout ?? '').trim(), err: (done.stderr ?? '').trim() };
}
const git = (cwd, args, env, ok) => sh('git', args, { cwd, env, ok });
const local = (cwd, args) => sh(BIN, args, { cwd });

/** The repository under test: a fresh clone, trunk renamed to main, its GitHub remote gone. */
function prepare() {
  const dir = join(work, `local-sync-test-agents-${ts}`);
  git(work, ['clone', '-q', REPO, dir]);
  const trunk = git(dir, ['symbolic-ref', '--short', 'HEAD']).out;
  if (trunk !== 'main') git(dir, ['branch', '-m', trunk, 'main']);
  git(dir, ['remote', 'remove', 'origin']);
  return dir;
}

function serve(dir) {
  const child = spawn(BIN, ['serve'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(evidence, 'serve.pid'), String(child.pid));
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start: ${scrub(log)}`)), 20_000);
    child.stdout.on('data', () => log.includes('listening on') && (clearTimeout(timer), resolve()));
  });
  return { child, ready, log: () => scrub(log) };
}

/** An agent's own clone of local main, its token as Git's header (environment only), then
 * pointed at the service as the container sees it. */
function agentClone(name, url, inside, token, scenario) {
  const dir = join(work, `${scenario}-${name}`);
  const origin = url.split('/git/')[0];
  git(work, ['clone', '-q', url, dir], gitConfigEnv({ token, origin }));
  git(dir, ['config', 'user.name', `Local agent ${name}`]);
  git(dir, ['config', 'user.email', `${name}@local-agents.invalid`]);
  git(dir, ['switch', '-q', '-c', `${scenario}-${name}`]);
  git(dir, ['remote', 'set-url', 'origin', inside]);
  return dir;
}

const TASKS = {
  a: (name) =>
    `You are in a Git clone of a Go library at /work. Create a new file docs/${name}.md containing one short paragraph that describes what the library does (read README.md first). Commit it with the message "Add docs/${name}.md". Then run exactly: git push origin HEAD:refs/heads/a-${name} and then git push origin HEAD:refs/heads/main. Do not change any other file. Report the output of both pushes.`,
  b: (name) =>
    `You are in a Git clone at /work. Replace the first line of README.md with exactly this line: "# pflag (edited by ${name})". Change nothing else. Commit with the message "Retitle README for ${name}". Then run exactly: git push origin HEAD:refs/heads/b-${name} and then git push origin HEAD:refs/heads/main once. If the push to main is refused, do not pull, merge, rebase or retry: stop and report the refusal text exactly.`,
};

async function scenario(id, ctx) {
  const { url, inside, tokens, egress, credential, budget } = ctx;
  const base = git(ctx.dir, ['rev-parse', 'refs/heads/main']).out;
  const runs = ['agent-a', 'agent-b'].map((name) => {
    const dir = agentClone(name, url, inside, tokens[name], id);
    const env = sandboxEnv({ origin: inside.split('/git/')[0], token: tokens[name], remote: inside, credential, proxy: egress.address, plain: true });
    const container = `yoneda-local-${id}-${name}-${ts.toString(36)}`;
    const command = ['opencode', ...opencodeArgs({ model: MODEL, title: `local ${id} ${name}`, text: TASKS[id](name) })];
    const args = sandboxArgs({ name: container, clone: dir, env, command, network: egress.network, image: IMAGE });
    writeFileSync(join(evidence, `${id}-${name}.command.txt`), `${printable(['docker', ...args])}\n`);
    return runAgent({ task: { agent: `${id}-${name}` }, name: container, cwd: work, env: clientEnv(process.env, env), credential, scrub, args, evidence, timeoutMs: TIMEOUT_S * 1000, budget });
  });
  const outcomes = await Promise.all(runs);
  const store = join(ctx.dir, '.git/yoneda/local/store.git');
  const ref = (r) => git(store, ['rev-parse', '-q', '--verify', r], {}, false).out || null;
  const events = (name) => readFileSync(join(evidence, `${id}-${name}.events.jsonl`), 'utf8');
  const pushLines = (name) => [...new Set((events(name).match(/(?:! \[[^\]]+\][^\\"]*|error: [^\\"]*|To http[^\\"]*|-> main[^\\"]*)/g) ?? []).map((l) => l.trim()))].slice(0, 12);
  return {
    scenario: id,
    base,
    main: ref('refs/heads/main'),
    branches: Object.fromEntries(['agent-a', 'agent-b'].map((n) => [n, ref(`refs/heads/${id}-${n}`)])),
    outcomes: outcomes.map((o) => ({ agent: o.agent, exit: o.killed ?? o.code, ms: o.ms, cost_usd: o.cost, push_output: pushLines(o.agent.slice(2)), stderr: o.stderr })),
  };
}

async function waitSynced(dir, secs) {
  for (let i = 0; i < secs; i++) {
    const s = JSON.parse(local(dir, ['status', '--json']).out);
    if (s.sync.state === 'synced' && s.sync.cloud?.main === s.main) return s;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return JSON.parse(local(dir, ['status', '--json']).out);
}

/** Dev's main read back with the stored login (environment only): its head and files. */
function devReadback(origin, repo) {
  const login = JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME, '.config'), 'yoneda/credentials'), 'utf8'));
  if (login.origin !== origin) throw new Error(`the stored login is for ${login.origin}, not ${origin}`);
  secrets.add(login.token);
  const into = join(work, 'dev-readback');
  const env = { ...gitConfigEnv({ token: login.token, origin }), GIT_CONFIG_GLOBAL: '/dev/null' };
  git(work, ['-c', 'credential.helper=', 'clone', '-q', `${origin}/git/${repo}.git`, into], env);
  return { main: git(into, ['rev-parse', 'HEAD']).out, files: git(into, ['ls-tree', '-r', '--name-only', 'HEAD', 'docs', 'README.md']).out.split('\n'), readme: git(into, ['show', 'HEAD:README.md']).out.split('\n')[0] };
}

async function run() {
  const watched = [main, root, process.cwd()];
  const before = await hostState(watched);
  note(`work ${work}; evidence ${evidence}`);
  const dir = prepare();
  note(`repository ${REPO} → ${dir}`);
  note(local(dir, ['init']).out);
  const server = serve(dir);
  try {
    await server.ready;
    await withService(dir, server, before, watched);
  } finally {
    // The service this run started, by its own handle (PID in serve.pid), never by name.
    if (server.child.exitCode === null) server.child.kill('SIGINT');
  }
}

async function withService(dir, server, before, watched) {
  const status = JSON.parse(local(dir, ['status', '--json']).out);
  if (!status.sync.cloud?.paired) throw new Error(`init did not pair with the cloud: ${JSON.stringify(status.sync)}`);
  const url = status.url;
  const inside = url.replace('127.0.0.1', 'host.docker.internal');
  const tokens = {};
  for (const name of ['agent-a', 'agent-b']) {
    tokens[name] = local(dir, ['token', 'create', name]).out;
    secrets.add(tokens[name]);
  }
  const credential = await modelCredential(MODEL, work);
  secrets.add(credential);
  const egress = await startEgress({ image: IMAGE, allow: egressAllowlist({ origin: inside.split('/git/')[0], model: MODEL }), run: `local-${ts.toString(36)}` });
  const budget = spendBudget(BUDGET);
  const record = { recorded_at: new Date().toISOString(), model: MODEL, repo: REPO, budget_usd: BUDGET, timeout_s: TIMEOUT_S, cloud: status.sync.cloud, scenarios: [] };
  try {
    const ctx = { dir, url, inside, tokens, egress, credential, budget };
    record.scenarios.push(await scenario('a', ctx));
    record.scenarios.push(await scenario('b', ctx));
  } finally {
    record.egress = await egress.stop();
  }
  record.fsck = git(join(dir, '.git/yoneda/local/store.git'), ['fsck', '--strict'], {}, false);
  record.log = local(dir, ['log']).out.split('\n').slice(-8);
  record.synced = await waitSynced(dir, 120);
  record.dev = devReadback(status.sync.cloud.origin, record.synced.sync.cloud.repo);
  record.cost_usd = budget.total();
  record.serve_log = server.log().split('\n').slice(-10);
  record.host_problems = await hostProblems(before, watched);
  writeFileSync(join(evidence, 'result.json'), scrub(`${JSON.stringify(record, null, 2)}\n`));
  note(`result: ${join(evidence, 'result.json')}`);
  note(`host problems: ${record.host_problems.length ? record.host_problems.join('; ') : 'none'}`);
}

run().catch((e) => {
  note(`failed: ${e.stack ?? e.message}`);
  process.exitCode = 1;
});
