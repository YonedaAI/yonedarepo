// The harness runner: one review per container. `POST /run` clones the change lazily through
// git-remote-yoneda, reads the repository's review rules at the diff base, and runs the chosen
// CLI agent on the composed prompt; `GET /status` reports progress and, once done, the CLI's
// structured result and a transcript tail. Every network call leaves through the managed
// Worker's outbound handlers, which hold the credentials; nothing here has one.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { buildCommand, composePrompt, extractResult, finalMessage, PLACEHOLDER_KEY } from './commands.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const HOME = process.env.HOME ?? '/home/agent';
const CHECKOUT = '/work/repo';
const TRANSCRIPT_MAX = 1024 * 1024;
const RULE_FILES = ['REVIEW.md', 'AGENTS.md', 'CLAUDE.md'];
const RULE_MAX = 20_000;

let job = null;

/** Runs `argv`, collecting output (capped); rejects on a non-zero exit or the deadline. */
function run(argv, { cwd, env, stdin, deadline, log }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      // Lazy clones fetch file contents on demand, so every process gets the helper's token
      // placeholder (the Worker's outbound handler swaps in the real, read-only one).
      env: { PATH: process.env.PATH, HOME, YONEDA_TOKEN: `yrp_${PLACEHOLDER_KEY}`, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const keep = (chunk) => {
      const text = chunk.toString();
      out = (out + text).slice(-TRANSCRIPT_MAX);
      log(text);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', (chunk) => log(chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1000, deadline - Date.now()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(signal ? `${argv[0]} stopped (${signal})` : `${argv[0]} exited with ${code}`));
    });
    child.stdin.end(stdin ?? '');
  });
}

async function review(spec, state) {
  const deadline = Date.now() + spec.timeout_ms;
  const log = (text) => {
    state.transcript = (state.transcript + text).slice(-TRANSCRIPT_MAX);
  };
  const git = (args) => run(['git', ...args], { cwd: CHECKOUT, env: {}, deadline, log });
  state.phase = 'cloning';
  await run(['yoneda', 'clone', spec.repo, CHECKOUT, '--origin', spec.platform_origin], {
    cwd: '/work',
    env: {},
    deadline,
    log,
  });
  await git(['fetch', 'origin', `refs/heads/${spec.branch}`]);
  await git(['checkout', '--detach', spec.head]);
  const rules = [];
  for (const path of RULE_FILES) {
    const text = await git(['show', `${spec.base}:${path}`]).catch(() => '');
    rules.push({ path, text: text.slice(0, RULE_MAX) });
  }
  const prompt = composePrompt({
    instructions: spec.instructions,
    contract: spec.contract,
    context: spec.context,
    rules,
  });
  const command = buildCommand({ ...spec, prompt });
  for (const [path, text] of Object.entries(command.files)) {
    const file = join(HOME, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text, { mode: 0o600 });
  }
  state.phase = 'running';
  const stdout = await run(command.argv, {
    cwd: CHECKOUT,
    env: { ...command.env, ...(command.env.OPENCODE_CONFIG ? { OPENCODE_CONFIG: join(HOME, command.env.OPENCODE_CONFIG) } : {}) },
    stdin: command.stdin,
    deadline,
    log,
  });
  const fileText = command.resultFile ? await readFile(command.resultFile, 'utf8').catch(() => null) : null;
  const result = extractResult(finalMessage(spec.harness, stdout, fileText).slice(-200_000));
  if (!result) throw new Error('The agent finished without a result object');
  return result;
}

function respond(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

export function serve(port = PORT) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://runner');
    if (req.method === 'GET' && url.pathname === '/health') return respond(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/status') {
      if (!job) return respond(res, 200, { phase: 'idle' });
      const { phase, result, error, transcript, started_at, finished_at } = job;
      return respond(res, 200, { phase, result, error, transcript, started_at, finished_at });
    }
    if (req.method === 'POST' && url.pathname === '/run') {
      if (job) return respond(res, 409, { error: 'A review already ran in this container' });
      let spec;
      try {
        spec = await body(req);
      } catch {
        return respond(res, 400, { error: 'invalid JSON' });
      }
      job = { phase: 'starting', transcript: '', result: null, error: null, started_at: Date.now(), finished_at: null };
      const state = job;
      review(spec, state)
        .then((result) => {
          state.result = result;
          state.phase = 'done';
        })
        .catch((e) => {
          state.error = String(e?.message ?? e).slice(0, 500);
          state.phase = 'failed';
        })
        .finally(() => {
          state.finished_at = Date.now();
        });
      return respond(res, 202, { phase: state.phase });
    }
    respond(res, 404, { error: 'not found' });
  }).listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) serve();
