// Real Git from this machine: the one client here that isn't a request form. Every command runs
// in a throwaway directory with no host configuration, and the token reaches Git through the
// environment only. `tools/staging/clone-probe.mjs` breaks a clone down further.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitConfigEnv } from '../own-traffic.mjs';

/** A scratch directory and `git(args, cwd)`, answering `{ok, ms, tail}` without throwing. */
export function gitSession(token, origin) {
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-real-use-'));
  const config = join(dir, 'gitconfig');
  writeFileSync(config, '[user]\n\tname = Real use\n\temail = bench@yonedarepo.invalid\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
  const env = { ...process.env, HOME: dir, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, ...gitConfigEnv({ token, origin }) };
  const git = (args, cwd = dir) =>
    new Promise((resolve) => {
      const started = performance.now();
      const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
      let tail = '';
      child.stderr.on('data', (chunk) => (tail = `${tail}${chunk}`.slice(-400)));
      child.on('close', (code) => resolve({ ok: code === 0, ms: Math.round(performance.now() - started), tail: tail.split(token).join('<token>') }));
    });
  return { dir, git, close: () => rmSync(dir, { recursive: true, force: true }) };
}
