// What stock Git prints of each way the platform can refuse it, from a real `git` against a
// stand-in server (cloudflare/worker/repo-git-retry.ts rests on this). Git retries nothing, a
// 503 on `info/refs` shows its text, a 503 on a POST shows none of it, an ERR line in a 200 does,
// and of a push only a per-ref report tells the person why.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const TIP = '1'.repeat(40);
const BUSY = 'OVERLOADED: The repository is busy right now; try again in a few seconds';
const pkt = (s) => `${(Buffer.byteLength(s) + 4).toString(16).padStart(4, '0')}${s}`;
const band = (n, text) => {
  const data = Buffer.concat([Buffer.from([n]), Buffer.from(text)]);
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
};
const PLAIN = { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' };
const RESULT = { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache', 'retry-after': '1' };
const REPORT = { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' };
const ADVERTISED = { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' };
const v2 = `${pkt('# service=git-upload-pack\n')}0000${pkt('version 2\n')}${pkt('agent=test\n')}${pkt('ls-refs=unborn\n')}${pkt('fetch=shallow\n')}${pkt('object-format=sha1\n')}0000`;
const v0 = `${pkt('# service=git-upload-pack\n')}0000${pkt(`${TIP} HEAD\0multi_ack_detailed side-band-64k symref=HEAD:refs/heads/main agent=test\n`)}${pkt(`${TIP} refs/heads/main\n`)}0000`;
const receiving = `${pkt('# service=git-receive-pack\n')}0000${pkt(`${TIP} refs/heads/main\0report-status side-band-64k agent=test\n`)}0000`;
const listed = `${pkt(`${TIP} HEAD symref-target:refs/heads/main\n`)}${pkt(`${TIP} refs/heads/main\n`)}0000`;

const dir = mkdtempSync(join(tmpdir(), 'git-refusals-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A one-repository server: `answer` for the request it is told to refuse, else a normal one. */
async function serve({ get, list, fetch, push, version = v2 }) {
  const posts = { list: 0, fetch: 0, push: 0 };
  const server = createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const send = ([status, headers, body]) => {
        res.writeHead(status, headers);
        res.end(body);
      };
      if (req.method === 'GET') {
        if (get) return send(get);
        if (req.url.includes('git-receive-pack')) return send([200, { ...ADVERTISED, 'content-type': 'application/x-git-receive-pack-advertisement' }, receiving]);
        return send([200, ADVERTISED, version]);
      }
      if (req.url.endsWith('git-receive-pack')) {
        posts.push++;
        return send(push);
      }
      if (Buffer.concat(parts).includes('command=ls-refs')) {
        posts.list++;
        return send(list ?? [200, RESULT, listed]);
      }
      posts.fetch++;
      return send(fetch);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, posts, url: `http://user:pass@127.0.0.1:${server.address().port}/git/r.git` };
}

const CLEAN = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' };
/** Runs Git without blocking the server in this process. */
const git = (args, cwd = dir) =>
  new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, ...CLEAN } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

let clones = 0;
async function clone(refusals, ...options) {
  const stand = await serve(refusals);
  const result = await git([...options, 'clone', stand.url, join(dir, `clone-${clones++}`)]);
  stand.server.close();
  return { ...result, posts: stand.posts };
}

test('a 503 on info/refs shows its plain text', async () => {
  const { code, out } = await clone({ get: [503, PLAIN, `${BUSY}\n`] });
  assert.notEqual(code, 0);
  assert.match(out, new RegExp(`remote: ${BUSY}`));
});

test('a 503 on a POST shows none of its text, and Git does not retry it', async () => {
  for (const refused of [{ fetch: [503, PLAIN, `${BUSY}\n`] }, { fetch: [503, RESULT, pkt(`ERR ${BUSY}\n`)] }]) {
    const { code, out, posts } = await clone(refused);
    assert.notEqual(code, 0);
    assert.match(out, /RPC failed; HTTP 503/);
    assert.match(out, /expected 'packfile'/);
    assert.doesNotMatch(out, /busy/);
    assert.equal(posts.fetch, 1);
  }
});

test('an ERR line in a 200 is what Git prints of a POST, in protocol versions 0 and 2', async () => {
  const err = [200, RESULT, pkt(`ERR ${BUSY}\n`)];
  for (const answer of [
    await clone({ list: err }),
    await clone({ fetch: err }),
    await clone({ fetch: err, version: v0 }, '-c', 'protocol.version=0'),
  ]) {
    assert.notEqual(answer.code, 0);
    assert.match(answer.out, new RegExp(`fatal: remote error: ${BUSY}`));
  }
});

test('of a push, a 503 says nothing and a per-ref refusal says why', async () => {
  const work = join(dir, 'work');
  spawnSync('git', ['init', '-q', '-b', 'main', work], { env: { ...process.env, ...CLEAN } });
  writeFileSync(join(work, 'a'), 'a\n');
  await git(['add', 'a'], work);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'a'], work);
  const push = async (answer) => {
    const stand = await serve({ push: answer });
    const result = await git(['push', stand.url, 'main:refs/heads/topic'], work);
    stand.server.close();
    return result;
  };
  const bare = await push([503, PLAIN, `${BUSY}\n`]);
  assert.notEqual(bare.code, 0);
  assert.match(bare.out, /RPC failed; HTTP 503/);
  assert.doesNotMatch(bare.out, /busy/);

  const body = Buffer.concat([band(1, `${pkt('unpack ok\n')}${pkt(`ng refs/heads/topic ${BUSY}\n`)}0000`), Buffer.from('0000')]);
  const refused = await push([200, REPORT, body]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, new RegExp(`\\[remote rejected\\] +main -> topic \\(${BUSY}\\)`));
});
