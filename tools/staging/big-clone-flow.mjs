// Big-clone item (19) of the staging kit, with stock Git over smart HTTP (protocol version
// 2, Git's default): a repository of 200 files and 10 commits pushed from a clone, then a
// partial clone (`--filter=blob:none`) whose checkout fetches main's files lazily by id and
// whose packs must be under 10% of a full clone's, a shallow clone (`--depth 1`) deepened by
// 5 and unshallowed, and `git fsck` clean on each. The repository is deleted afterwards,
// pass or fail. The repository token reaches Git only through the environment
// (http.extraHeader), never an argument. Zero model spend.
//
// Usage: node tools/staging-realworld.mjs --only 0,19 [--origin <front>] [--api <platform host>]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { b64 } from './client.mjs';
import { withRepos } from './platform-flow.mjs';

const FILES = 200;
const ROUNDS = 10;

/** `n` bytes of hex text from `seed`: about as compressible as source is not. */
function text(seed, n = 4096) {
  const mask = (1n << 64n) - 1n;
  let state = ((BigInt(seed) * 0x9e3779b97f4a7c15n) & mask) | 1n;
  let out = '';
  for (let i = 0; i < n; i++) {
    state ^= (state << 13n) & mask;
    state ^= state >> 7n;
    state ^= (state << 17n) & mask;
    out += i % 64 === 63 ? '\n' : '0123456789abcdef'[Number(state % 16n)];
  }
  return out;
}

/** Bytes of the packs a clone holds. */
function packBytes(dir) {
  const packs = join(dir, '.git/objects/pack');
  return readdirSync(packs)
    .filter((f) => f.endsWith('.pack'))
    .reduce((n, f) => n + statSync(join(packs, f)).size, 0);
}

export const bigClone = ({ api, platform }, metrics) =>
  withRepos(platform, async (newRepo) => {
    const repo = await newRepo('kit-bigclone', { required_checks: [], approvals: 0 }, [{ path: 'README.md', content_b64: b64('# big clone\n') }]);
    const minted = await platform.post(`/repos/${repo.id}/tokens`, { name: 'kit-git', scopes: ['read', 'write', 'land'] });
    const dir = mkdtempSync(join(tmpdir(), 'yoneda-bigclone-'));
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${minted.token}`,
    };
    // No background repack after a fetch: it races `git fsck` on the packs.
    writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Staging kit\n\temail = kit@yonedarepo.invalid\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n');
    const git = (args, cwd = dir) => {
      try {
        return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
      } catch (e) {
        throw new Error(`git ${args.join(' ')}: ${`${e.stdout ?? ''}${e.stderr ?? e.message}`.slice(-600)}`);
      }
    };
    const count = (cwd) => Number(git(['rev-list', '--count', 'HEAD'], cwd));
    const fsck = (cwd) => git(['fsck', '--no-progress'], cwd);
    const timed = (key, run) => {
      const started = performance.now();
      const value = run();
      metrics[key] = Math.round(performance.now() - started);
      return value;
    };
    try {
      const remote = `${api}/git/${repo.id}.git`;
      git(['clone', '-q', remote, 'src']);
      const src = join(dir, 'src');
      // 200 files of 4 KiB in 10 directories, then 9 commits each rewriting 20 of them.
      for (let round = 0; round < ROUNDS; round++) {
        for (let i = 0; i < FILES; i++) {
          if (round > 0 && i % ROUNDS !== round) continue;
          const path = join(src, `d${i % 10}`, `f${i}.txt`);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text(round * FILES + i));
        }
        git(['add', '-A'], src);
        git(['commit', '-q', '-m', `round ${round}`], src);
      }
      timed('push_ms', () => git(['push', '-q', 'origin', 'main'], src));
      const head = git(['rev-parse', 'HEAD'], src);
      const history = ROUNDS + 1; // and the seed commit

      timed('full_clone_ms', () => git(['clone', '-q', '--no-checkout', remote, 'full']));
      metrics.full_bytes = packBytes(join(dir, 'full'));
      fsck(join(dir, 'full'));

      const partial = join(dir, 'partial');
      timed('partial_clone_ms', () => git(['clone', '-q', '--filter=blob:none', '--no-checkout', remote, 'partial']));
      metrics.partial_bytes = packBytes(partial);
      metrics.partial_pct = Number(((100 * metrics.partial_bytes) / metrics.full_bytes).toFixed(1));
      assert.ok(metrics.partial_bytes * 10 < metrics.full_bytes, `partial clone ${metrics.partial_bytes} B is not < 10% of full ${metrics.full_bytes} B`);
      assert.equal(count(partial), history, 'partial clone history');
      timed('lazy_checkout_ms', () => git(['checkout', '-q', 'main'], partial));
      for (const i of [0, 57, 199]) {
        const path = `d${i % 10}/f${i}.txt`;
        assert.equal(readFileSync(join(partial, path), 'utf8'), readFileSync(join(src, path), 'utf8'), `lazily fetched ${path}`);
      }
      const missing = git(['rev-list', '--objects', '--all', '--missing=print'], partial);
      assert.ok(missing.split('\n').some((l) => l.startsWith('?')), 'older blobs stay on the server');
      assert.equal(git(['show', 'HEAD~9:d3/f3.txt'], partial), text(3).trimEnd(), 'an old version fetched by id');
      fsck(partial);

      const shallow = join(dir, 'shallow');
      timed('shallow_clone_ms', () => git(['clone', '-q', '--depth', '1', remote, 'shallow']));
      assert.equal(count(shallow), 1, 'depth 1');
      assert.equal(git(['rev-parse', 'HEAD'], shallow), head, 'shallow HEAD is main');
      fsck(shallow);
      timed('deepen_ms', () => git(['fetch', '-q', '--deepen', '5'], shallow));
      assert.equal(count(shallow), 6, 'deepened by 5');
      fsck(shallow);
      git(['fetch', '-q', '--unshallow'], shallow);
      assert.equal(count(shallow), history, 'unshallowed');
      fsck(shallow);
      metrics.repo = repo.id;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
