// Kit item 29's agent sandbox, the pure half (no processes, unit-tested in
// tests/runtime/agent-sandbox.test.mjs). Every agent runs in its own container of the image
// tools/staging/agent-sandbox/Dockerfile builds: the only host path it sees is its clone (at
// /work), its environment is the allowlist below (nothing of the host's), the model credential
// arrives on stdin, and egress goes only to the model provider's API and the platform: the
// container sits on an internal Docker network with no route out, and its one way out is an
// egress proxy (agent-sandbox/egress-proxy.mjs) that forwards to those hosts by exact name;
// the container refuses to start an agent unless that holds (egress-check.mjs). Before and
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
/** The egress proxy's port (egress-proxy.mjs PORT). Agents reach it by its address on their
 * network, never by a name: a name depends on Docker's DNS, and on 2026-10-28 the name went
 * with a crashed proxy, so every client failed with "getaddrinfo EAI_AGAIN egress". */
export const EGRESS_PORT = 3128;
export const EGRESS_LABEL = 'yoneda.agent-sandbox-egress=1';
/** Where each model provider's API is (opencode provider id → `host:port`). A provider not
 * listed here is refused: add its API host after checking where opencode sends it. */
export const PROVIDER_HOSTS = {
  'zai-coding-plan': ['api.z.ai:443'],
  anthropic: ['api.anthropic.com:443'],
  openai: ['api.openai.com:443'],
};

/** Where an agent reaches the platform at `api`: a platform on the host's loopback (wrangler
 * dev) through Docker's host gateway (which the egress proxy reaches). */
export function sandboxOrigin(api) {
  const url = new URL(api);
  if (LOOPBACK.has(url.hostname)) url.hostname = 'host.docker.internal';
  return { origin: url.toString().replace(/\/$/, '') };
}

/** The `host:port` targets the egress proxy forwards to: the platform at `origin` and, for a
 * real model (`provider/model`; none for the scripted stand-in), its provider's API. */
export function egressAllowlist({ origin, model }) {
  const url = new URL(origin);
  const allow = [`${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`];
  if (model) {
    const provider = model.split('/')[0];
    const hosts = PROVIDER_HOSTS[provider];
    if (!hosts) throw new Error(`no egress host is known for model provider ${provider} (agent-sandbox.mjs PROVIDER_HOSTS)`);
    allow.push(...hosts);
  }
  return [...new Set(allow)].sort();
}

/** The model credential for `model` (`provider/model`) out of `opencode auth export`'s JSON:
 * that provider's entries only, as the JSON `opencode auth import` reads; `null` when none. */
export function credentialFor(exported, model) {
  const provider = model.split('/')[0];
  const entries = (Array.isArray(exported) ? exported : []).filter((e) => e?.integrationID === provider);
  return entries.length ? JSON.stringify(entries) : null;
}

/** The container's whole environment (names and values); nothing else of the host reaches it.
 * Every client in it (opencode, git, the `yoneda` remote helper) reads the proxy variables,
 * which name the egress proxy at `proxy` (`startEgress`'s IPv4 `address:port`); the egress
 * check probes exactly that proxy and refuses to start an agent whose variables differ. */
export function sandboxEnv({ origin, token, remote, credential, proxy }) {
  if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(proxy ?? '')) throw new Error(`the egress proxy must be an IPv4 address:port, not ${proxy}`);
  const proxyUrl = `http://${proxy}`;
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
    SANDBOX_EGRESS_PROXY: proxy,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
    ...(credential ? { SANDBOX_CREDENTIAL: 'stdin' } : {}),
  };
}

/** `docker run` arguments for one agent on `network` (the internal one `egressArgs`'s proxy
 * serves). Environment values never appear here (`-e NAME` takes the docker client's value),
 * so the printed command holds no secret. */
export function sandboxArgs({ name, clone, env, command, network, image = IMAGE }) {
  if (!clone.startsWith('/') || /[,\n]/.test(clone)) throw new Error(`unusable clone path for a bind mount: ${clone}`);
  if (!network) throw new Error('an agent runs only on the egress-limited network');
  return [
    'run',
    '--rm',
    '-i',
    '--init',
    '--name',
    name,
    '--network',
    network,
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

/** `docker run` arguments for the egress proxy: the sandbox image's proxy, on Docker's default
 * bridge (the internet, and the host gateway for a loopback platform), with nothing mounted,
 * no capabilities and the allowlist (`SANDBOX_EGRESS_ALLOW` in the client's environment). It
 * joins the agents' internal network afterwards. Not `--rm`: should it exit, its log (what it
 * refused, why it died) must outlive it; `startEgress`'s stop removes it. */
export function egressArgs({ name, image = IMAGE }) {
  return [
    'run',
    '-d',
    '--init',
    '--name',
    name,
    '--label',
    EGRESS_LABEL,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '1000:1000',
    '--memory',
    '256m',
    '--pids-limit',
    '128',
    '--add-host',
    'host.docker.internal:host-gateway',
    '-e',
    'SANDBOX_EGRESS_ALLOW',
    '--entrypoint',
    'node',
    image,
    '/opt/yoneda/egress-proxy.mjs',
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
