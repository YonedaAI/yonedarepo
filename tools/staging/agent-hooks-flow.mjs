// Item 28 of the staging kit (L2 of the agent e2e strategy, no model): the agent plugins'
// wiring against a live platform, driven by recorded-shape hook payloads in temporary clones.
// A seeded opencode session is recorded on a pushed commit; then a Claude Code session
// (`yoneda hook claude-*`, the plugins/yoneda hooks) starts with a context naming the seed's
// summary and exports its session id, records a read, is refused a plain smart-HTTP push
// while reads are pending, pushes through yoneda:: with the read declared, and records its
// session at Stop; then the real opencode plugin (plugins/opencode/yoneda/index.ts, with a
// stand-in opencode context) starts a session whose context names both earlier summaries,
// records a read, refuses the smart-HTTP push, and records its session when the run ends.
// The sessions API reads every record back, newest first, with its session id.
// Continuous memory: a memory added before the Claude session is in its start context and
// is not repeated when the anchored file is read; one added after the start comes back once
// on the next read of that file; one matching the prompt's words comes back on the prompt;
// after the session adds a memory (git_memory_add), its Stop offers the summary as a draft;
// the session's deliveries (start, read, prompt) read back. The repository is deleted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeOpencode, modelCall } from './opencode-fake.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const b64 = (text) => Buffer.from(text).toString('base64');
const MODEL = 'zai-coding-plan/glm-5.3';
const SEED = 'Seed session: added retry() with three attempts to src/net.ts.';
const CLAUDE = 'Claude session: retry() now backs off exponentially.';
const OPENCODE = 'opencode session: added jitter to the backoff in retry().';
const MEMORY_START = 'Kit memory: the land queue replays retry(), so it must stay idempotent.';
const MEMORY_READ = 'Kit memory: src/net.ts is the only module allowed to open sockets.';
const MEMORY_PROMPT = 'Kit memory: the backoff ceiling is thirty seconds, set by the gateway.';
/** The kit may itself run inside an agent session: its ids must not leak into the clones. */
const NO_SESSION = { YONEDA_SESSION_ID: '', OPENCODE_SESSION_ID: '' };

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** `yoneda hook <event>` with `payload` on stdin; `{ code, stdout, stderr }`. */
function hook(kit, event, payload, env = kit.env()) {
  return new Promise((done, fail) => {
    const child = spawn(join(kit.bin, 'yoneda'), ['hook', event], { cwd: payload.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout: kit.scrub(stdout).trim(), stderr: kit.scrub(stderr).trim() }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Runs `body` with the kit's CLI environment as this process's (the plugin spawns
 * `yoneda` with it), restoring every variable after. */
async function withEnv(env, body) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function poll(probe, what, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** 28: Claude Code and opencode hooks against the platform; asserted through the API. */
export async function agentHooks(kit, metrics) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const api = kit.pat();
  const name = `kit-hooks-${Date.now()}`;
  const files = [{ path: 'src/net.ts', content_b64: b64('export function retry() {}\n') }];
  const repo = (await api.post('/repos', { name, policy: { approvals: 0, required_checks: [] }, files, author })).id;
  kit.repos.push({ id: repo, name });
  metrics.repo = repo;
  const sessionsOf = async (sha) => (await api.get(`/repos/${repo}/commits/${sha}/sessions`)).sessions;
  const [a, h] = [kit.path('hooks-a'), kit.path('hooks-http')];
  const http = kit.env({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${kit.api}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${kit.token}`,
  });
  await kit.ok('git', ['clone', '-q', kit.remote(repo), a]);
  await kit.ok('git', ['clone', '-q', `${kit.api}/git/${repo}.git`, h], { env: http });
  /** Commits `text` to src/net.ts in clone A and pushes it with `env` (the agent's shell). */
  const commitAndPush = async (text, message, env) => {
    write(a, 'src/net.ts', text);
    await kit.gitOk(a, 'commit', '-qam', message);
    const sha = await kit.gitOk(a, 'rev-parse', 'HEAD');
    await kit.ok('git', ['push', '-q', 'origin', 'main'], { cwd: a, env: kit.env({ ...NO_SESSION, ...env }) });
    assert.equal((await api.get(`/repos/${repo}/refs`)).refs['refs/heads/main'], sha, 'main is the pushed commit');
    return sha;
  };

  // A recorded earlier session (as opencode's stop hook records one).
  const seed = await commitAndPush('export function retry(tries = 3) {}\n', 'Seed: retry three times', { OPENCODE_SESSION_ID: 'kit-seed' });
  const seeded = await hook(kit, 'opencode-stop', { sessionID: 'kit-seed', cwd: a, model: MODEL, summary: SEED, prompts: ['Add retry'] });
  assert.equal(seeded.code, 0, seeded.stderr);
  assert.deepEqual(
    (await sessionsOf(seed)).map((s) => [s.cli, s.model, s.session_id, s.summary]),
    [['opencode', MODEL, 'opencode:kit-seed', SEED]],
    'the seed session is recorded on its commit',
  );

  // A memory left before the Claude session starts, anchored to the symbol it is about.
  await kit.yonedaOk(['memory', 'add', 'gotcha', '-m', MEMORY_START, '--anchors', 'src/net.ts#retry'], { cwd: a, env: kit.env(NO_SESSION) });

  // Claude Code: SessionStart → context and session id; reads; push refusal; Stop.
  const envFile = kit.path('claude-env');
  writeFileSync(envFile, '');
  const started = await hook(kit, 'claude-start', { session_id: 'kit-claude', cwd: a, hook_event_name: 'SessionStart', source: 'startup' }, kit.env({ CLAUDE_ENV_FILE: envFile }));
  const context = JSON.parse(started.stdout || '{}').hookSpecificOutput?.additionalContext ?? '';
  assert.ok(context.includes(SEED), `the Claude session's start context lacks the seed summary: ${context.slice(0, 400)}`);
  assert.match(readFileSync(envFile, 'utf8'), /export YONEDA_SESSION_ID='claude-code:kit-claude'/);
  assert.ok(context.includes(MEMORY_START), `the start context lacks the memory: ${context.slice(0, 600)}`);
  metrics.claude_context_bytes = context.length;
  const readNet = { session_id: 'kit-claude', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(a, 'src/net.ts') }, tool_response: {}, cwd: a };
  const injected = async (event, payload) => {
    const ran = await hook(kit, event, payload);
    assert.equal(ran.code, 0, ran.stderr);
    return JSON.parse(ran.stdout || '{}').hookSpecificOutput?.additionalContext ?? '';
  };
  assert.equal(await injected('claude-read', readNet), '', 'a memory the start context showed is not repeated');
  assert.equal((await kit.yonedaOk(['reads', 'list'], { cwd: a })).stdout, 'src/net.ts', 'the read is recorded');
  await api.post(`/repos/${repo}/memories`, { kind: 'constraint', text: MEMORY_READ, anchors: [{ path: 'src/net.ts' }] });
  await api.post(`/repos/${repo}/memories`, { kind: 'howto', text: MEMORY_PROMPT });
  const onRead = await injected('claude-read', readNet);
  assert.ok(onRead.includes(MEMORY_READ) && !onRead.includes(MEMORY_PROMPT), `the read did not bring the file's new memory: ${onRead}`);
  assert.ok(onRead.length <= 1536, 'one injection stays under its cap');
  assert.equal(await injected('claude-read', readNet), '', 'a memory is injected once per session');
  const onPrompt = await injected('claude-prompt', { session_id: 'kit-claude', hook_event_name: 'UserPromptSubmit', prompt: 'What is the backoff ceiling here?', cwd: a });
  assert.ok(onPrompt.includes(MEMORY_PROMPT), `the prompt did not bring the matching memory: ${onPrompt}`);
  metrics.memory_injection_bytes = onRead.length + onPrompt.length;
  // The session adds a memory itself (the MCP tool, seen by its PostToolUse hook).
  assert.equal((await hook(kit, 'claude-memory', { session_id: 'kit-claude', hook_event_name: 'PostToolUse', tool_name: 'mcp__yoneda__git_memory_add', cwd: a })).code, 0);
  const viaHelper = await hook(kit, 'claude-bash', { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: a });
  assert.equal(viaHelper.stdout, '', 'a yoneda:: push is let through (its helper declares the reads)');
  await kit.ok(join(kit.bin, 'yoneda'), ['reads', 'add', 'src/net.ts'], { cwd: h, env: http });
  const denied = await hook(kit, 'claude-bash', { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: h }, http);
  assert.equal(JSON.parse(denied.stdout || '{}').hookSpecificOutput?.permissionDecision, 'deny', `a smart-HTTP push with reads is not denied: ${denied.stdout}`);
  const claudeCommit = await commitAndPush('export function retry(tries = 3) { /* backoff */ }\n', 'Claude: exponential backoff', { YONEDA_SESSION_ID: 'claude-code:kit-claude' });
  assert.deepEqual((await api.get(`/repos/${repo}/commits/${claudeCommit}`)).read_set, ['src/net.ts'], 'the push declared the read');
  const transcript = kit.path('claude-transcript.jsonl');
  writeFileSync(
    transcript,
    [
      { type: 'user', message: { role: 'user', content: 'Make retry back off' } },
      { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: CLAUDE }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  );
  const stopped = await hook(kit, 'claude-stop', { session_id: 'kit-claude', cwd: a, transcript_path: transcript, hook_event_name: 'Stop' });
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.deepEqual(
    (await sessionsOf(claudeCommit)).map((s) => [s.cli, s.model, s.session_id, s.summary]),
    [['claude-code', 'claude-sonnet-5-5', 'claude-code:kit-claude', CLAUDE]],
    'the Claude session is recorded on its commit',
  );
  const drafts = (await api.get(`/repos/${repo}/memories?status=draft`)).memories;
  assert.deepEqual(
    drafts.map((m) => [m.session_id, m.text]),
    [['claude-code:kit-claude', CLAUDE]],
    "the session's summary is offered as a draft memory",
  );
  const delivered = (await api.get(`/repos/${repo}/context/deliveries?session_id=claude-code:kit-claude`)).deliveries;
  assert.deepEqual(delivered.map((d) => d.trigger), ['start', 'read', 'prompt'], 'the session page reads what the session was shown');

  // opencode: the real plugin with a stand-in opencode context.
  const plugin = (await import(resolve(root, 'plugins/opencode/yoneda/index.ts'))).default;
  const env = { ...kit.env(NO_SESSION), YONEDA_BIN: join(kit.bin, 'yoneda') };
  const ocCommit = await withEnv(env, async () => {
    const messages = [
      { type: 'user', text: 'Add jitter to the backoff' },
      { type: 'assistant', model: { providerID: 'zai-coding-plan', id: 'glm-5.3' }, content: [{ type: 'text', text: OPENCODE }] },
    ];
    const oc = fakeOpencode(a, messages);
    const cleanup = await plugin.setup(oc.ctx);
    const call = modelCall('kit-oc');
    await oc.hooks['session.context'](call);
    const text = call.system[0]?.text ?? '';
    assert.ok(text.includes(SEED) && text.includes(CLAUDE), `the opencode session's context lacks the earlier summaries: ${text.slice(0, 400)}`);
    metrics.opencode_context_bytes = text.length;
    await oc.hooks['tool.execute.after']({ tool: 'read', sessionID: 'kit-oc', input: { path: 'src/net.ts' }, status: 'completed', result: { output: '…' } });
    assert.equal((await kit.yonedaOk(['reads', 'list'], { cwd: a })).stdout, 'src/net.ts', 'the opencode read is recorded');
    await oc.hooks['tool.execute.before']({ tool: 'shell', sessionID: 'kit-oc', input: { command: 'git push origin main' } });
    const viaHttp = fakeOpencode(h);
    const cleanupHttp = await plugin.setup(viaHttp.ctx);
    await assert.rejects(viaHttp.hooks['tool.execute.before']({ tool: 'shell', sessionID: 'kit-oc-http', input: { command: 'git push origin main' } }), /yoneda push/, 'a smart-HTTP push with reads is refused');
    await cleanupHttp();
    // opencode runs the session's shell commands with OPENCODE_SESSION_ID.
    const sha = await commitAndPush('export function retry(tries = 3) { /* backoff + jitter */ }\n', 'opencode: jitter', { OPENCODE_SESSION_ID: 'kit-oc' });
    oc.emit({ type: 'session.execution.succeeded', data: { sessionID: 'kit-oc' } });
    await poll(async () => (await sessionsOf(sha)).length > 0, 'the opencode session record');
    await cleanup();
    return sha;
  });
  assert.deepEqual(
    (await sessionsOf(ocCommit)).map((s) => [s.cli, s.model, s.session_id, s.summary]),
    [['opencode', MODEL, 'opencode:kit-oc', OPENCODE]],
    'the opencode session is recorded on its commit',
  );

  const recent = (await api.get(`/repos/${repo}/sessions?limit=10`)).sessions;
  assert.deepEqual(
    recent.map((s) => s.session_id),
    ['opencode:kit-oc', 'claude-code:kit-claude', 'opencode:kit-seed'],
    'the repository lists the sessions newest first',
  );
  Object.assign(metrics, { sessions: recent.length, commits: [seed, claudeCommit, ocCommit].map((c) => c.slice(0, 7)).join(',') });
}
