// Stock Git for the enterprise checks (dev-checks.mjs): nothing of the user's configuration or
// credentials, a token through the environment only, scratch clones in the run's own folder and
// failures with secrets scrubbed. Every call answers `{ ok, ... }`, because a refused clone is
// what several checks want to see.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitConfigEnv } from '../own-traffic.mjs';
import { scrub } from './dev-checks-lib.mjs';

/** A full clone's own limit, above the platform's 15 minutes. */
const CLONE_MS = 20 * 60_000;

export function gitTools({ api, scratch, secrets, clock = { now: Date.now } }) {
  mkdirSync(scratch, { recursive: true });
  const config = join(scratch, 'gitconfig');
  writeFileSync(config, '[user]\n\tname = Dev checks\n\temail = dev-checks@yonedarepo.invalid\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n');
  const remote = (repo) => `${api}/git/${repo.id}.git`;
  const run = (args, { cwd = scratch, token, timeoutMs = CLONE_MS, env = {} } = {}) =>
    new Promise((done) => {
      const child = spawn('git', args, {
        cwd,
        timeout: timeoutMs,
        // Scoped to the API: presigned R2 URLs must not receive the token.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, ...gitConfigEnv({ token, origin: api }), ...env },
      });
      const out = [];
      const err = [];
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => err.push(d));
      child.on('close', (code) => {
        const stdout = Buffer.concat(out).toString().trim();
        const error = scrub(Buffer.concat(err).toString().trim(), secrets).slice(-400);
        done({ ok: code === 0, stdout, error });
      });
    });
  const required = async (args, options) => {
    const answer = await run(args, options);
    if (!answer.ok) throw new Error(`git ${args[0]}: ${answer.error}`);
    return answer.stdout;
  };
  const fresh = (label) => mkdtempSync(join(scratch, `${label}-`));
  const hashes = async (dir) => {
    const files = (await required(['ls-files'], { cwd: dir })).split('\n').filter(Boolean);
    return Object.fromEntries(files.map((path) => [path, createHash('sha256').update(readFileSync(join(dir, path))).digest('hex')]));
  };
  return {
    /** Whether a clone goes through; a refused one is `{ ok: false, error }`. */
    clone: (repo, token) => run(['clone', '-q', '--depth', '1', remote(repo), fresh('refused')], { token, timeoutMs: 60_000 }),
    /** A working clone to push from later. */
    async work(repo, token) {
      const dir = fresh('work');
      await required(['clone', '-q', remote(repo), dir], { token });
      return dir;
    },
    /** Commits `path` on main and pushes it. */
    async pushFile(dir, token, path, text) {
      writeFileSync(join(dir, path), text);
      await required(['add', path], { cwd: dir });
      await required(['commit', '-q', '-m', `Dev check: ${path}`], { cwd: dir });
      return run(['push', '-q', 'origin', 'HEAD:main'], { cwd: dir, token });
    },
    /** Adds a 1 MiB LFS file to main. */
    async pushLfs(dir, token) {
      await required(['lfs', 'install', '--local'], { cwd: dir });
      await required(['lfs', 'track', '*.bin'], { cwd: dir });
      writeFileSync(join(dir, 'dev-check.bin'), randomBytes(1024 * 1024));
      await required(['add', '.gitattributes', 'dev-check.bin'], { cwd: dir });
      await required(['commit', '-q', '-m', 'Dev check: an LFS file'], { cwd: dir });
      await required(['push', '-q', 'origin', 'HEAD:main'], { cwd: dir, token });
    },
    /** What a fresh clone holds: commits, tree, and every file's bytes, LFS files' too. */
    async fingerprint(repo, token) {
      const dir = fresh('look');
      await required(['clone', '-q', remote(repo), dir], { token, env: { GIT_LFS_SKIP_SMUDGE: '1' } });
      await required(['lfs', 'install', '--local'], { cwd: dir });
      await required(['lfs', 'pull'], { cwd: dir, token });
      return {
        head: await required(['rev-parse', 'HEAD'], { cwd: dir }),
        tree: await required(['rev-parse', 'HEAD^{tree}'], { cwd: dir }),
        commits: Number(await required(['rev-list', '--count', 'HEAD'], { cwd: dir })),
        files: await hashes(dir),
      };
    },
    /** One whole clone, for the stored pack it leaves behind. */
    async fullClone(repo, token) {
      const started = clock.now();
      const dir = fresh('full');
      const answer = await run(['clone', '-q', '--bare', remote(repo), dir], { token });
      if (!answer.ok) return answer;
      return { ok: true, ms: clock.now() - started, head: await required(['rev-parse', 'refs/heads/main'], { cwd: dir }) };
    },
    /** Pushes `commit` of the bare `source` as main. Files over 8 MiB go whole. */
    pushAt: (source, repo, commit, token) =>
      run(['-c', 'core.bigFileThreshold=8m', 'push', '-q', remote(repo), `${commit}:refs/heads/main`], { cwd: source, token, timeoutMs: 30 * 60_000 }),
  };
}
