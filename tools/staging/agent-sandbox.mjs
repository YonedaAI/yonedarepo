// Kit item 29's agent sandbox, the pure half (no processes, unit-tested in
// tests/runtime/agent-sandbox.test.mjs). Every agent runs in its own container of the image
// tools/staging/agent-sandbox/Dockerfile builds: the only host path it sees is its clone (at
// /work), its environment is the allowlist below (nothing of the host's), the model credential
// arrives on stdin, and egress reaches the internet but not the host or the LAN. Before and
// after the agents, the kit snapshots the host checkouts and their remotes; `hostDrift` is
// what changed.
// Why: on 2026-10-28 real agents spawned with `cwd` = their clone worked in the operator's
// checkout instead, because `opencode run` takes its project directory from $PWD (inherited
// from the kit), and pushed to the operator's GitHub remote with the operator's credentials.

export const IMAGE = 'yoneda-agent-sandbox:local';
export const IMAGE_LABEL = 'yoneda.agent-sandbox=1';
export const WORKDIR = '/work';
/** The plugin and the scripted stand-in for opencode, as the image installs them. */
export const PLUGIN = '/opt/yoneda/plugin';
export const FAKE_OPENCODE = ['node', '/opt/yoneda/fake/tests/agents/fake-opencode.mjs'];
/** Inside the clone's Git directory, so the clone stays the container's only mount. */
export const HOOK_LOG = `${WORKDIR}/.git/yoneda-hooks.jsonl`;
export const GUARD_EXIT = 97;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Where an agent reaches the platform at `api`: a platform on the host's loopback (wrangler
 * dev) through Docker's host gateway, and `hostPort` the one host port egress allows. */
export function sandboxOrigin(api) {
  const url = new URL(api);
  if (!LOOPBACK.has(url.hostname)) return { origin: api.replace(/\/$/, ''), hostPort: null };
  const hostPort = url.port || (url.protocol === 'https:' ? '443' : '80');
  url.hostname = 'host.docker.internal';
  return { origin: url.toString().replace(/\/$/, ''), hostPort };
}

/** The model credential for `model` (`provider/model`) out of `opencode auth export`'s JSON:
 * that provider's entries only, as the JSON `opencode auth import` reads; `null` when none. */
export function credentialFor(exported, model) {
  const provider = model.split('/')[0];
  const entries = (Array.isArray(exported) ? exported : []).filter((e) => e?.integrationID === provider);
  return entries.length ? JSON.stringify(entries) : null;
}

/** The container's whole environment (names and values); nothing else of the host reaches it. */
export function sandboxEnv({ origin, token, remote, hostPort, credential }) {
  return {
    YONEDA_ORIGIN: origin,
    YONEDA_TOKEN: token,
    YONEDA_HOOK_LOG: HOOK_LOG,
    YONEDA_AGENT_WORKDIR: WORKDIR,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [{ package: PLUGIN }] }),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // The bind mount's owner is not the container's agent user, and Docker Desktop's file
    // sharing reports unstable ctimes and inodes: with full stat checks Git takes tracked files
    // for modified and refuses `pull --rebase` ("local changes would be overwritten").
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: WORKDIR,
    GIT_CONFIG_KEY_1: 'core.checkStat',
    GIT_CONFIG_VALUE_1: 'minimal',
    GIT_CONFIG_KEY_2: 'core.trustctime',
    GIT_CONFIG_VALUE_2: 'false',
    SANDBOX_EXPECTED_ORIGIN: remote,
    ...(hostPort ? { SANDBOX_HOST_PORT: hostPort } : {}),
    ...(credential ? { SANDBOX_CREDENTIAL: 'stdin' } : {}),
  };
}

/** `docker run` arguments for one agent. Environment values never appear here (`-e NAME`
 * takes the docker client's value), so the printed command holds no secret. */
export function sandboxArgs({ name, clone, env, command, image = IMAGE }) {
  if (!clone.startsWith('/') || /[,\n]/.test(clone)) throw new Error(`unusable clone path for a bind mount: ${clone}`);
  return [
    'run',
    '--rm',
    '-i',
    '--init',
    '--name',
    name,
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=1g',
    '--tmpfs',
    '/run:rw,nosuid,nodev,size=16m',
    '--tmpfs',
    '/home/agent:rw,nosuid,nodev,size=1g,uid=1000,gid=1000,mode=0700',
    // Root only until sandbox-init has installed the egress rules and dropped to `agent`.
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_ADMIN',
    '--cap-add',
    'SETUID',
    '--cap-add',
    'SETGID',
    '--cap-add',
    'SETPCAP',
    '--security-opt',
    'no-new-privileges',
    '--sysctl',
    'net.ipv6.conf.all.disable_ipv6=1',
    '--memory',
    '4g',
    '--cpus',
    '2',
    '--pids-limit',
    '1024',
    '--mount',
    `type=bind,source=${clone},target=${WORKDIR}`,
    '--workdir',
    WORKDIR,
    ...Object.keys(env)
      .sort()
      .flatMap((n) => ['-e', n]),
    image,
    ...command,
  ];
}

/** The docker client's own environment: what it needs to reach the daemon, plus `env`'s values
 * for its `-e NAME` flags. */
export function clientEnv(host, env) {
  const keep = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];
  return { ...Object.fromEntries(keep.filter((n) => host[n] !== undefined).map((n) => [n, host[n]])), ...env };
}

const short = (text) => (text.length > 60 ? `${text.slice(0, 57)}…` : text) || '(empty)';
const lines = (text) => new Set(text.split('\n').filter(Boolean));

function setDiff(label, before, after) {
  const was = lines(before);
  const now = lines(after);
  const added = [...now].filter((l) => !was.has(l));
  const gone = [...was].filter((l) => !now.has(l));
  return added.length || gone.length ? [`${label}: ${[...added.map((l) => `+${l}`), ...gone.map((l) => `-${l}`)].slice(0, 6).join(', ')}`] : [];
}

/**
 * What changed on the host between two snapshots `{ checkouts: { top: { head, branch, status,
 * main, nested } }, remotes: { url: ls-remote output } }` ([] when nothing): any change is
 * an agent that escaped its sandbox, or someone working in the checkout during the run.
 */
export function hostDrift(before, after) {
  const problems = [];
  for (const [top, was] of Object.entries(before.checkouts)) {
    const now = after.checkouts[top];
    if (!now) {
      problems.push(`host checkout ${top} could not be read after the run`);
      continue;
    }
    for (const key of ['head', 'branch', 'main'])
      if (was[key] !== now[key]) problems.push(`host checkout ${top}: ${key} ${short(was[key])} → ${short(now[key])}`);
    problems.push(...setDiff(`host checkout ${top}: status`, was.status, now.status));
    problems.push(...setDiff(`host checkout ${top}: worktrees inside it`, was.nested, now.nested));
  }
  for (const [url, was] of Object.entries(before.remotes)) {
    const now = after.remotes[url];
    if (now === undefined) problems.push(`host remote ${url} could not be read after the run`);
    else problems.push(...setDiff(`host remote ${url}: refs`, was, now));
  }
  return problems;
}
