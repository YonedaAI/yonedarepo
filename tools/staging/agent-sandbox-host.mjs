// Kit item 29's agent sandbox, the host half (agent-sandbox.mjs is the pure half): building the
// image, the model credential out of the host's opencode store (kept in memory, written only to
// a container's stdin) and the snapshots of the host checkouts and remotes that must not change
// while agents run. Asynchronous throughout: blocking the event loop for a build or an
// ls-remote leaves the kit's HTTP client to reuse a keep-alive socket the platform closed.
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { credentialFor, EGRESS_LABEL, EGRESS_PORT, egressArgs, IMAGE, IMAGE_LABEL } from './agent-sandbox.mjs';

const run = promisify(execFile);
/** `{ ok, out, err }` of a command; never rejects. */
const exec = (cmd, args, options) =>
  run(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...options }).then(
    ({ stdout, stderr }) => ({ ok: true, out: stdout.trim(), err: stderr.trim() }),
    (e) => ({ ok: false, out: (e.stdout ?? '').trim(), err: (e.stderr ?? e.message ?? '').trim() }),
  );

/** Whether a Docker daemon answers. */
export function dockerAvailable() {
  return spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' }).status === 0;
}

/** Builds the sandbox image from this checkout (cached layers make an unchanged build quick),
 * removes the builds it replaced, and returns its image id and opencode version. */
export async function buildSandbox(root) {
  const built = await exec('docker', ['build', '-q', '-f', join(root, 'tools/staging/agent-sandbox/Dockerfile'), '-t', IMAGE, root]);
  if (!built.ok) throw new Error(`docker build of the agent sandbox: ${built.err.slice(-800)}`);
  await exec('docker', ['image', 'prune', '-f', '--filter', `label=${IMAGE_LABEL}`]);
  const version = await exec('docker', ['run', '--rm', '--entrypoint', 'opencode', built.out, '--version']);
  return { image: built.out, opencode: version.out };
}

/**
 * The agents' network and its egress proxy for one run: an internal Docker network (no route
 * out) and the proxy container, on the default bridge and joined to that network, forwarding
 * to `allow` (`host:port` list) alone; `address` is its IPv4 `address:port` on that network,
 * what agents' proxy variables name (`sandboxEnv`). `stop()` removes both and answers
 * `{ refused, died }`: the targets the proxy refused (what agents tried to reach beyond the
 * allowlist), and `null` or how the proxy ended when it did not outlive the run.
 */
export async function startEgress({ image, allow, run }) {
  const network = `yoneda-sandbox-${run}`;
  const proxy = `yoneda-egress-${run}`;
  const must = async (args, env) => {
    const done = await exec('docker', args, env ? { env: { ...process.env, ...env } } : undefined);
    if (!done.ok) throw new Error(`docker ${args.slice(0, 3).join(' ')}: ${done.err.slice(-400)}`);
    return done.out;
  };
  const stop = async () => {
    const state = await exec('docker', ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', proxy]);
    const logs = await exec('docker', ['logs', proxy]);
    await exec('docker', ['rm', '-f', proxy]);
    await exec('docker', ['network', 'rm', network]);
    const [status, code] = state.out.split(' ');
    const died = status === 'running' ? null : `${status || 'gone'} (exit ${code ?? '?'}): ${logs.err.split('\n').filter(Boolean).slice(-6).join(' | ').slice(-600)}`;
    const refused = `${logs.out}\n${logs.err}`
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((e) => e?.event === 'egress.refused')
      .map((e) => `${e.method} ${e.target}`);
    return { refused, died };
  };
  let address;
  try {
    await must(['network', 'create', '--internal', '--label', EGRESS_LABEL, network]);
    await must(egressArgs({ name: proxy, image }), { SANDBOX_EGRESS_ALLOW: allow.join(',') });
    await must(['network', 'connect', network, proxy]);
    const ip = await must(['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, proxy]);
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`the egress proxy has no IPv4 address on ${network}: ${ip || '(none)'}`);
    address = `${ip}:${EGRESS_PORT}`;
    let listening = false;
    for (let i = 0; i < 50 && !listening; i++) {
      listening = (await exec('docker', ['logs', proxy])).out.includes('egress.listening');
      if (!listening) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!listening) throw new Error(`the egress proxy ${proxy} did not start listening`);
  } catch (e) {
    await stop();
    throw e;
  }
  return { network, proxy, address, stop };
}

/** The host opencode's stored credential for `model`'s provider, as `opencode auth import`
 * JSON. Run from `dir` (with PWD = dir) so opencode never opens the operator's checkout. */
export async function modelCredential(model, dir) {
  const provider = model.split('/')[0];
  const exported = await exec('opencode', ['auth', 'export', provider, '--standalone'], { cwd: dir, env: { ...process.env, PWD: dir } });
  let parsed = null;
  try {
    parsed = JSON.parse(exported.out);
  } catch {}
  const credential = credentialFor(parsed, model);
  if (!credential) throw new Error(`the host opencode has no stored credential for ${provider} (opencode auth login)`);
  return credential;
}

const git = (cwd, ...args) => exec('git', args, { cwd, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });

/**
 * The host state agents must not touch, for every checkout in `dirs` (the kit's root, its cwd
 * and $PWD): HEAD, branch, `status`, local main and worktrees nested inside it (Claude Code's
 * own .claude/worktrees aside), and each remote's refs (`ls-remote`, with the host's
 * credentials; the agents never see them). Throws when something cannot be read: the kit must
 * not start agents it cannot check afterwards.
 */
export async function hostState(dirs) {
  const tops = new Set();
  for (const dir of dirs.filter(Boolean)) {
    const top = await git(dir, 'rev-parse', '--show-toplevel');
    if (top.ok) tops.add(top.out);
  }
  const checkouts = {};
  const remotes = {};
  for (const top of tops) {
    const must = async (...args) => {
      const done = await git(top, ...args);
      if (!done.ok) throw new Error(`git ${args.join(' ')} in ${top}: ${done.err}`);
      return done.out;
    };
    const nested = (await must('worktree', 'list', '--porcelain'))
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length))
      .filter((p) => p.startsWith(`${top}/`) && !p.startsWith(`${top}/.claude/worktrees/`));
    checkouts[top] = {
      head: await must('rev-parse', 'HEAD'),
      branch: (await git(top, 'symbolic-ref', '-q', 'HEAD')).out || '(detached)',
      main: (await git(top, 'rev-parse', '-q', '--verify', 'refs/heads/main')).out,
      status: await must('status', '--porcelain'),
      nested: nested.join('\n'),
    };
    for (const name of (await must('remote')).split('\n').filter(Boolean)) {
      const url = await must('remote', 'get-url', name);
      remotes[url] ??= await must('ls-remote', name);
    }
  }
  return { checkouts, remotes };
}
