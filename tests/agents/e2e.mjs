// The agent e2e gates without a model, locally: `wrangler dev` serves the platform Worker
// (tests/ssh/wrangler.jsonc), a fresh account gets a personal token, and the kit's items run
// against it with this checkout's `yoneda` build: 27 (Git semantics: stock git, the CLI and
// MCP) and 28 (the Claude Code and opencode plugin hooks); with --fake-agents N, item 29's
// parallel-agent run with tests/agents/fake-opencode.mjs as `opencode` (scripted agents, the
// real yoneda plugin, no model), each in the agent sandbox container like a real agent (needs
// Docker; the image is built from this checkout); with --memory-stub N, the memory test's dry
// run: N blocks of tests/agents/fake-memory-agent.mjs in all three arms on fixture repositories
// named as the real ones. 32 is the change page's session evidence (API half; the browser half
// needs the front Worker, so the live kit runs it). No provider keys; LFS is left to the live
// kit (its uploads go to presigned R2 URLs).
// Usage: cargo build -p yoneda-cli && node tests/agents/e2e.mjs [--only 27,28,32] [--fake-agents 4]
//          [--memory-stub 5] [--cli-bin <dir>]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agentHooks } from '../../tools/staging/agent-hooks-flow.mjs';
import { agentRun } from '../../tools/staging/agent-run-flow.mjs';
import { CliKit, PAT_SCOPES } from '../../tools/staging/cli-tools.mjs';
import { Recorder, Session, sleep } from '../../tools/staging/client.mjs';
import { gitSemantics } from '../../tools/staging/git-semantics-flow.mjs';
import { memoryRun, report } from '../../tools/staging/memory-flow.mjs';
import { memoryPage } from '../../tools/staging/memory-page-flow.mjs';
import { anchoredFiles, TRAPS } from '../../tools/staging/memory-traps.mjs';
import { scrubber } from '../../tools/staging/realuser-plan.mjs';
import { Workspace } from '../../tools/staging/realuser-git.mjs';

const { values } = parseArgs({ options: { only: { type: 'string' }, 'cli-bin': { type: 'string' }, 'fake-agents': { type: 'string' }, 'memory-stub': { type: 'string' } } });
const root = fileURLToPath(new URL('../../', import.meta.url));
const config = join(root, 'tests/ssh/wrangler.jsonc');
const wrangler = join(root, 'node_modules/.bin/wrangler');
const fakeAgents = Number(values['fake-agents'] ?? 0);
const memoryStub = Number(values['memory-stub'] ?? 0);
const wanted = (id) => (id === '29' ? fakeAgents > 0 : !values.only || values.only.split(',').includes(id));

/** The memory test's dry run on small repositories with the real ones' names and its files. */
async function memoryStubRun(account, origin) {
  for (const trap of TRAPS) {
    const files = anchoredFiles(trap).map((path) => ({ path, content_b64: Buffer.from(`${path} of the fixture\n`).toString('base64') }));
    await account.post('/repos', { name: trap.repo, policy: { required_checks: [], approvals: 1 }, files, author: { name: 'Dry run', email: 'kit@yonedarepo.invalid' } });
  }
  const secrets = new Set();
  const ws = new Workspace({ api: origin, bin: values['cli-bin'] ?? join(root, 'target/debug'), scrub: scrubber(secrets) });
  try {
    const summary = await memoryRun({ owner: account, ws, root, ts: String(Date.now()), secrets }, { runs: memoryStub, parallel: 2, model: 'fake/scripted', timeoutS: 120, fake: true });
    const code = report(summary, { root, fill: false });
    const { answer, avoided, delivered, invalid } = summary.verdict;
    const reached = delivered.memory.trap.yes === delivered.memory.trap.n && delivered.context.context.yes === delivered.context.context.n && delivered.context.trap.yes + delivered.plain.context.yes + delivered.plain.trap.yes === 0;
    if (code || answer !== 'memory helped' || !reached || invalid.plain + invalid.context + invalid.memory) throw new Error(`dry run: ${answer}, ${JSON.stringify({ avoided, delivered, invalid })}`);
  } finally {
    ws.dispose();
  }
}

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const dir = mkdtempSync(join(tmpdir(), 'yoneda-agents-e2e-'));
let server;
let log = '';
let failed = true;
try {
  const port = await freePort();
  const state = join(dir, 'state');
  execFileSync(wrangler, ['d1', 'migrations', 'apply', 'yoneda-ssh-e2e-index', '--local', '-c', config, '--persist-to', state], { cwd: root, stdio: 'ignore', env: { ...process.env, CI: '1' } });
  server = spawn(wrangler, ['dev', '-c', config, '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state, '--show-interactive-dev-session=false'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; !(await fetch(`${origin}/health`).then((r) => r.ok, () => false)); i++) {
    if (i > 300) throw new Error('wrangler dev did not come up');
    await sleep(300);
  }
  const signup = await fetch(`${origin}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `agents_e2e_${Date.now().toString(36)}@example.com`, password: 'local agents e2e password' }),
  });
  if (!signup.ok) throw new Error(`signup: ${signup.status} ${await signup.text()}`);
  const account = new Session(`${origin}/api/v1`, { cookie: (signup.headers.get('set-cookie') ?? '').split(';')[0] });
  const kit = new CliKit({ api: origin, bin: values['cli-bin'] ?? join(root, 'target/debug'), platformAccount: account });
  kit.token = (await account.post('/tokens', { name: 'agents-e2e', scopes: PAT_SCOPES, repos: null, expires_days: 1 })).token;
  const rec = new Recorder();
  try {
    if (wanted('27')) await rec.step('27', 'Git semantics: stock git, yoneda CLI and MCP', (m) => gitSemantics(kit, { lfs: false }, m));
    if (wanted('28')) await rec.step('28', 'Agent hooks: Claude Code and opencode plugins, sessions API', (m) => agentHooks(kit, m));
    if (wanted('32')) await rec.step('32', 'Change page evidence: session record, transcript and context delivery', (m) => memoryPage(kit, {}, m));
    if (wanted('29'))
      await rec.step('29', `Parallel agents (scripted, no model, sandboxed): ${fakeAgents} + 2`, (m) => agentRun(kit, { root, agents: fakeAgents, wave2: 2, model: 'fake/scripted', timeoutS: 120, fake: true }, m));
    if (memoryStub) await rec.step('memory', `Memory test dry run (scripted, no model, sandboxed): ${memoryStub} blocks`, () => memoryStubRun(account, origin));
  } finally {
    kit.dispose();
  }
  console.log(rec.table());
  failed = rec.items.some((i) => i.status === 'fail');
} catch (e) {
  console.error(e);
} finally {
  server?.kill('SIGTERM');
  if (failed) console.error(`\nwrangler dev log (tail):\n${log.slice(-3000)}`);
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}
