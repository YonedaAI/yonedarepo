// The agent e2e gates without a model, locally: `wrangler dev` serves the platform Worker
// (tests/ssh/wrangler.jsonc), a fresh account gets a personal token, and the kit's items run
// against it with this checkout's `yoneda` build: 27 (Git semantics: stock git, the CLI and
// MCP) and 28 (the Claude Code and opencode plugin hooks). No network beyond localhost, no
// provider keys; LFS is left to the live kit (its uploads go to presigned R2 URLs).
// Usage: cargo build -p yoneda-cli && node tests/agents/e2e.mjs [--only 27|28] [--cli-bin <dir>]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agentHooks } from '../../tools/staging/agent-hooks-flow.mjs';
import { CliKit, PAT_SCOPES } from '../../tools/staging/cli-tools.mjs';
import { Recorder, Session, sleep } from '../../tools/staging/client.mjs';
import { gitSemantics } from '../../tools/staging/git-semantics-flow.mjs';

const { values } = parseArgs({ options: { only: { type: 'string' }, 'cli-bin': { type: 'string' } } });
const root = fileURLToPath(new URL('../../', import.meta.url));
const config = join(root, 'tests/ssh/wrangler.jsonc');
const wrangler = join(root, 'node_modules/.bin/wrangler');
const wanted = (id) => !values.only || values.only.split(',').includes(id);

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
    body: JSON.stringify({ username: `agents_e2e_${Date.now().toString(36)}`, password: 'local agents e2e password' }),
  });
  if (!signup.ok) throw new Error(`signup: ${signup.status} ${await signup.text()}`);
  const account = new Session(`${origin}/api/v1`, { cookie: (signup.headers.get('set-cookie') ?? '').split(';')[0] });
  const kit = new CliKit({ api: origin, bin: values['cli-bin'] ?? join(root, 'target/debug'), platformAccount: account });
  kit.token = (await account.post('/tokens', { name: 'agents-e2e', scopes: PAT_SCOPES, repos: null, expires_days: 1 })).token;
  const rec = new Recorder();
  try {
    if (wanted('27')) await rec.step('27', 'Git semantics: stock git, yoneda CLI and MCP', (m) => gitSemantics(kit, { lfs: false }, m));
    if (wanted('28')) await rec.step('28', 'Agent hooks: Claude Code and opencode plugins, sessions API', (m) => agentHooks(kit, m));
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
