import { execFileSync } from 'node:child_process';

/** Local Git only. Ignore user signing/hooks/config and never interpolate a shell command. */
export function git(cwd, args, options = {}) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Source benchmark fixture',
      '-c',
      'user.email=source-fixture@example.invalid',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        ...options.env,
      },
      input: options.input,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    },
  ).trim();
}

export function commit(cwd, message, index) {
  const timestamp = new Date(Date.UTC(2000, 0, 1, 0, 0, index)).toISOString();
  git(cwd, ['add', '--all']);
  git(cwd, ['commit', '-m', message], {
    env: { GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp },
  });
}
