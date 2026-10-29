#!/usr/bin/env node
// Check setup benchmark: how long a check container spends receiving and writing a commit's
// files before the command runs, and how many bytes cross the wire, for the JSON form
// (base64 content) against the streamed form (raw frames), with and without a sparse scope.
// Runs the release `yoneda-runtime check-server` locally with the command `true`, so the
// measured time is setup. Test data must be a pure repository (an imported open-source
// one), never this codebase.
//
//   node tools/check-setup-bench.mjs <git dir> [--rev HEAD] [--runs 3] [--scope a,b]...
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const repo = args[0];
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at > 0 ? args[at + 1] : fallback;
};
const scopes = args.flatMap((a, i) => (a === '--scope' ? [args[i + 1].split(',')] : []));
const rev = option('rev', 'HEAD');
const runs = Number(option('runs', 3));
const runtime = resolve(option('runtime', 'target/release/yoneda-runtime'));
if (!repo) throw new Error('usage: check-setup-bench.mjs <git dir> [--rev R] [--runs N] [--scope a,b]');

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 1 << 30 });
const roots = (dir) => execFileSync('git', ['-C', dir, 'rev-list', '--max-parents=0', 'HEAD']).toString().trim();
if (roots(repo) === roots(new URL('..', import.meta.url).pathname))
  throw new Error('Refusing to benchmark this codebase: use a pure repository');

/** The commit's files (gitlinks left out) with their content, as the platform lists them. */
function treeFiles() {
  const types = { 100644: 'blob', 100755: 'exec', 120000: 'symlink' };
  const listed = git('ls-tree', '-r', '-z', '--full-tree', rev)
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      const [mode, , id] = meta.split(' ');
      return { path, type: types[mode], id };
    })
    .filter((f) => f.type);
  const batch = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: listed.map((f) => f.id).join('\n') + '\n',
    maxBuffer: 1 << 30,
  });
  let at = 0;
  for (const f of listed) {
    const end = batch.indexOf(10, at);
    const size = Number(batch.subarray(at, end).toString().split(' ')[2]);
    f.data = new Uint8Array(batch.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  return listed.sort((a, b) => (a.path < b.path ? -1 : 1));
}
const inScope = (scope, path) => !scope?.length || scope.some((p) => path === p || path.startsWith(`${p}/`));

const job = (files) => ({ command: ['true'], timeout_seconds: 60, files });
const jsonBody = (j) =>
  JSON.stringify({
    ...j,
    files: j.files.map((f) => ({ path: f.path, type: f.type, data_b64: Buffer.from(f.data).toString('base64') })),
  });
/** The streamed body as the Worker builds it (cloudflare/worker/check-stream.ts). */
function* frames(j) {
  const header = Buffer.from(JSON.stringify({ command: j.command, timeout_seconds: j.timeout_seconds }));
  const start = Buffer.alloc(10);
  start.write('YCHK1\n');
  start.writeUInt32BE(header.length, 6);
  yield start;
  yield header;
  const kinds = { blob: 1, exec: 2, symlink: 3 };
  for (const f of j.files) {
    const path = Buffer.from(f.path);
    const head = Buffer.alloc(7 + path.length);
    head[0] = kinds[f.type];
    head.writeUInt16BE(path.length, 1);
    path.copy(head, 3);
    head.writeUInt32BE(f.data.length, 3 + path.length);
    yield head;
    if (f.data.length) yield f.data;
  }
  yield Buffer.from([0]);
}

async function server() {
  const secret = randomBytes(24).toString('hex');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const root = mkdtempSync(join(tmpdir(), 'check-bench-'));
  const child = spawn(runtime, ['check-server'], {
    env: { PATH: process.env.PATH, CHECK_TOKEN: secret, CHECK_LISTEN: `127.0.0.1:${port}`, YONEDA_CHECK_ROOT: root },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const stop = () => {
    child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  };
  return { url: `http://127.0.0.1:${port}`, secret, stop };
}

/** One check through `form`; the clock starts before the body is built, as in the Worker. */
async function once(form, files) {
  const s = await server();
  try {
    const started = performance.now();
    let sent = 0;
    let response;
    if (form === 'json') {
      const body = jsonBody(job(files));
      sent = Buffer.byteLength(body);
      response = await fetch(`${s.url}/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.secret}` },
        body,
      });
    } else {
      const parts = frames(job(files));
      const body = new ReadableStream({
        pull(c) {
          const next = parts.next();
          if (next.done) return c.close();
          sent += next.value.length;
          c.enqueue(next.value);
        },
      });
      response = await fetch(`${s.url}/check/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/vnd.yoneda.check-stream', authorization: `Bearer ${s.secret}` },
        body,
        duplex: 'half',
      });
    }
    const result = await response.json();
    if (result.outcome !== 'pass') throw new Error(`check did not pass: ${JSON.stringify(result).slice(0, 300)}`);
    return { wall: performance.now() - started, setup: result.setup_ms, sent };
  } finally {
    s.stop();
  }
}

const all = treeFiles();
const commit = git('rev-parse', rev).toString().trim();
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return `${s[0].toFixed(0)}/${s[Math.floor(s.length / 2)].toFixed(0)}/${s.at(-1).toFixed(0)}`;
};
const mib = (n) => (n / 1048576).toFixed(2);
console.log(`repo ${repo} commit ${commit} files ${all.length} content ${mib(all.reduce((n, f) => n + f.data.length, 0))} MiB, ${runs} runs (min/median/max)`);
console.log('| form | scope | files | content MiB | wire MiB | wall ms | server setup ms |');
console.log('|---|---|---|---|---|---|---|');
const cases = [
  ['json', null],
  ['stream', null],
  ...scopes.map((scope) => ['stream', scope]),
];
for (const [form, scope] of cases) {
  const files = all.filter((f) => inScope(scope, f.path));
  const results = [];
  for (let i = 0; i < runs; i++) results.push(await once(form, files));
  const content = files.reduce((n, f) => n + f.data.length, 0);
  console.log(
    `| ${form} | ${scope ? scope.join(',') : '(whole tree)'} | ${files.length} | ${mib(content)} | ${mib(results[0].sent)} | ${stats(results.map((r) => r.wall))} | ${stats(results.map((r) => r.setup))} |`,
  );
}
