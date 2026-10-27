// Write latency of stock `git push` over HTTPS: pushes one commit of 1, 10 and 100 new
// small files to main of a fresh repository and prints, per push, the wall time and the
// platform's Server-Timing phases for the receive-pack request (read from Git's own
// `GIT_TRACE_CURL` output, so nothing but stock Git talks to the platform).
//
//   YONEDA_TOKEN=<PAT or owner token> node tools/staging/push-timing.mjs [--origin URL]
//     [--rounds N] [--sizes 1,10,100]
//
// The token travels in the environment only: Git reads it through a credential helper
// that prints it from the environment, and it is never printed. A PAT is used for Git
// as is; any other token mints a repository token for the run. The repository is deleted
// at the end.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Session } from './client.mjs';

const { values: args } = parseArgs({
  options: {
    origin: { type: 'string', default: process.env.YONEDA_ORIGIN ?? 'https://api.dev.yonedarepo.com' },
    rounds: { type: 'string', default: '3' },
    sizes: { type: 'string', default: '1,10,100' },
  },
});
const token = process.env.YONEDA_TOKEN;
assert.ok(token, 'Set YONEDA_TOKEN (a PAT, or the owner token locally) in the environment');
const origin = args.origin.replace(/\/$/, '');
const sizes = args.sizes.split(',').map(Number);
const rounds = Number(args.rounds);
const api = new Session(`${origin}/api/v1`, { bearer: token });
const author = { name: 'Push timing', email: 'push-timing@yonedarepo.invalid' };
const scrub = (text) => text.split(token).join('[token]');

const dir = mkdtempSync(join(tmpdir(), 'yoneda-push-timing-'));
chmodSync(dir, 0o700);
// Prints the token from the environment on `get`; stores and erases nothing.
const helper = join(dir, 'credential-helper.sh');
writeFileSync(
  helper,
  '#!/bin/sh\n[ "$1" = get ] && printf \'username=git\\npassword=%s\\n\' "$PUSH_TIMING_TOKEN"\n',
  { mode: 0o700 },
);
const gitConfig = join(dir, 'gitconfig');
writeFileSync(
  gitConfig,
  `[user]\n\tname = Push timing\n\temail = push-timing@yonedarepo.invalid\n[init]\n\tdefaultBranch = main\n[credential]\n\thelper = ${helper}\n`,
);

function run(cwd, gitArgs, env = {}) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        PUSH_TIMING_TOKEN: gitToken,
        ...env,
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code, out: scrub(out), err: scrub(err), ms: performance.now() - started }),
    );
  });
}

async function git(cwd, ...gitArgs) {
  const done = await run(cwd, gitArgs);
  assert.equal(done.code, 0, `git ${gitArgs.join(' ')}: ${done.err.slice(-400)}`);
  return done;
}

/** Server-Timing of each request in a `GIT_TRACE_CURL` log, by request line. */
function timings(trace) {
  const found = [];
  let request = null;
  for (const line of trace.split('\n')) {
    const sent = /=> Send header: ((?:GET|POST) \S+)/.exec(line);
    if (sent) request = sent[1].replace(/^(\w+) .*\/(info\/refs|git-[a-z-]+).*$/, '$1 $2');
    const header = /<= Recv header: server-timing: (.*)$/i.exec(line);
    if (header && request) found.push({ request, phases: phases(header[1]) });
  }
  return found;
}

function phases(header) {
  return header.split(/,\s*/).flatMap((part) => {
    const match = /^([^;]+);dur=([\d.]+)(?:;desc="(\d+)")?/.exec(part.trim());
    return match ? [{ name: match[1], ms: Number(match[2]), n: Number(match[3] ?? 1) }] : [];
  });
}

const pad = (text, width) => String(text).padEnd(width);
const num = (value, width) => String(value).padStart(width);

let repo = null;
let gitToken = token;
try {
  const name = `push-timing-${Date.now()}`;
  const created = await api.post('/repos', {
    name,
    policy: { approvals: 0, required_checks: [] },
    files: [{ path: 'README.md', content_b64: Buffer.from('push timing\n').toString('base64') }],
    author,
  });
  repo = { id: created.id, name };
  if (!/^(yrp|ypat)_/.test(token)) {
    const minted = await api.post(`/repos/${repo.id}/tokens`, {
      name: 'push-timing',
      scopes: ['read', 'write', 'land'],
    });
    gitToken = minted.token;
  }
  const remote = `${origin}/git/${repo.id}.git`;
  const clone = await git(dir, 'clone', '-q', remote, 'work');
  const work = join(dir, 'work');
  console.log(`origin ${origin}  repo ${repo.id}  clone ${clone.ms.toFixed(0)} ms\n`);
  const summary = [];
  for (let round = 0; round < rounds; round++) {
    for (const size of sizes) {
      const folder = join(work, `r${round}-n${size}`);
      mkdirSync(folder, { recursive: true });
      for (let i = 0; i < size; i++)
        writeFileSync(join(folder, `f${i}.txt`), `round ${round} file ${i} of ${size}\n`);
      await git(work, 'add', '-A');
      await git(work, 'commit', '-q', '-m', `push timing: ${size} files`);
      const pushed = await run(work, ['push', '-q', 'origin', 'HEAD:main'], {
        GIT_TRACE_CURL: '1',
        GIT_TRACE_CURL_NO_DATA: '1',
      });
      assert.equal(pushed.code, 0, `push of ${size} files failed: ${pushed.err.slice(-600)}`);
      const requests = timings(pushed.err);
      const receive = requests.find((r) => r.request === 'POST git-receive-pack');
      const refs = requests.filter((r) => r.request === 'GET info/refs').pop();
      const total = (r) => r?.phases.find((p) => p.name === 'total')?.ms ?? NaN;
      summary.push({ size, wall: pushed.ms, refs: total(refs), receive: total(receive) });
      console.log(
        `${size} files, round ${round + 1}: wall ${pushed.ms.toFixed(0)} ms, info/refs ${total(refs).toFixed(0)} ms, receive-pack ${total(receive).toFixed(0)} ms`,
      );
      for (const p of (receive?.phases ?? []).sort((a, b) => b.ms - a.ms))
        console.log(`  ${pad(p.name, 34)}${num(p.ms.toFixed(1), 9)} ms${num(p.n, 6)}x`);
      console.log('');
    }
  }
  console.log(`${pad('files', 7)}${pad('wall p50', 11)}${pad('info/refs', 11)}receive-pack (ms, p50)`);
  for (const size of sizes) {
    const rows = summary.filter((s) => s.size === size);
    const median = (key) => {
      const sorted = rows.map((r) => r[key]).sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)].toFixed(0);
    };
    console.log(`${pad(size, 7)}${pad(median('wall'), 11)}${pad(median('refs'), 11)}${median('receive')}`);
  }
} finally {
  if (repo) {
    const gone = await api.raw('DELETE', `/repos/${repo.id}?confirm=${encodeURIComponent(repo.name)}`);
    if (!gone.ok)
      console.warn(`could not delete ${repo.id}: ${gone.status} ${gone.body?.error?.code ?? ''}`);
  }
  rmSync(dir, { recursive: true, force: true });
}
