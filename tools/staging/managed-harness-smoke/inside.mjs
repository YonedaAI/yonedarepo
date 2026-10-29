// Runs inside the harness image (managed-harness-smoke.mjs pipes it to `node -`, once per
// SMOKE_CASE=harness/provider/model), with no
// network: a fake AI Gateway on 127.0.0.1 answers Anthropic Messages and OpenAI Responses with a
// fixed review result, and each pinned CLI is driven exactly as the runner drives it
// (commands.mjs). It checks that every CLI starts, sends its model traffic to the gateway base
// URL with the placeholder key, and that the runner's extraction finds the result. No real model
// is called and no key exists here.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { buildCommand, extractResult, finalMessage, PLACEHOLDER_KEY } from '/opt/yoneda/harness/commands.mjs';

const RESULT = JSON.stringify({ summary: 'Smoke review.', findings: [{ path: 'a.js', line: 1, severity: 'low', title: 'Smoke', why: 'Fixture.' }] });
const seen = [];

function anthropicStream(model) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_smoke', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: RESULT } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

function responsesStream(model) {
  const item = { id: 'msg_smoke', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: RESULT, annotations: [] }] };
  const response = (status, output) => ({ id: 'resp_smoke', object: 'response', model, status, output, usage: { input_tokens: 10, output_tokens: 40, total_tokens: 50, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
  const events = [
    ['response.created', { type: 'response.created', response: response('in_progress', []) }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_smoke', output_index: 0, content_index: 0, delta: RESULT }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    ['response.completed', { type: 'response.completed', response: response('completed', [item]) }],
  ];
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify({ ...d, sequence_number: 0 })}\n\n`).join('');
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {}
  const key = req.headers['x-api-key'] ?? req.headers.authorization ?? req.headers['api-key'] ?? '';
  seen.push({ method: req.method, url: req.url, model: body.model, key: String(key) });
  if (req.method !== 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"data":[]}');
  }
  const openai = req.url.includes('/responses');
  if (!body.stream && !openai) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'msg_smoke', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: RESULT }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 40 } }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(openai ? responsesStream(body.model) : anthropicStream(body.model));
});
await new Promise((r) => server.listen(8787, '127.0.0.1', r));

const gateway = { base: 'http://127.0.0.1:8787/v1/acct/gw', slugs: { claude: 'anthropic', codex: 'openai', zai: 'custom-zai', mimo: 'custom-mimo' } };
// One case per container, as in production (one CLI run per harness container).
const cases = [String(process.env.SMOKE_CASE ?? '').split('/')];
/** Runs a CLI without blocking this process's event loop, which serves the fake gateway. */
function runCli(argv, { cwd, env, input, timeout }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.end(input ?? '');
  });
}

const work = '/tmp/smoke-repo';
mkdirSync(work, { recursive: true });
spawnSync('git', ['init', '-q', work]);
writeFileSync(join(work, 'a.js'), 'export const a = 1;\n');
let failed = 0;
for (const [harness, provider, model] of cases) {
  const before = seen.length;
  const command = buildCommand({ harness, provider, model, reasoning: 'low', prompt: 'Review a.js and reply with the JSON result.', gateway });
  const home = `/tmp/home-${harness}-${provider}`;
  for (const [path, text] of Object.entries(command.files)) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  const env = { PATH: process.env.PATH, HOME: home, ...command.env };
  if (env.OPENCODE_CONFIG) env.OPENCODE_CONFIG = join(home, env.OPENCODE_CONFIG);
  const run = await runCli(command.argv, { cwd: work, env, input: command.stdin, timeout: 120_000 });
  let fileText = null;
  try {
    fileText = command.resultFile ? readFileSync(command.resultFile, 'utf8') : null;
  } catch {}
  const result = extractResult(finalMessage(harness, run.stdout ?? '', fileText));
  const calls = seen.slice(before).filter((s) => s.method === 'POST');
  const prefix = `/v1/acct/gw/${gateway.slugs[provider]}`;
  const ok =
    result?.summary === 'Smoke review.' &&
    calls.length > 0 &&
    calls.every((c) => c.url.startsWith(prefix) && c.key.includes(PLACEHOLDER_KEY));
  if (!ok) failed++;
  console.log(
    JSON.stringify({
      harness,
      provider,
      model,
      ok,
      exit: run.status,
      calls: calls.map((c) => `${c.url} ${c.model}`),
      stderr: ok ? undefined : String(run.stderr ?? '').slice(-1500),
      stdout: ok ? undefined : String(run.stdout ?? '').slice(-800),
    }),
  );
}
server.close();
process.exit(failed ? 1 : 0);
