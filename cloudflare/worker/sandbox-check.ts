// The agent layer's side of a check sandbox: which claimed evaluation it serves, what it needs,
// and the CheckPort over a sandbox container and the ledger. A check sandbox is a separate,
// fresh AgentSandbox instance (same image, its own name, `check` role), never the agent's, so
// the agent cannot touch the checks. Its egress reads the project repository only.
import { revisionProject } from './agents-platform';
import {
  type CheckAttempt,
  type CheckPort,
  type CheckState,
  type CommandSpec,
  checkStep,
  commandOutput,
  initialCheckState,
  type SiteCapture,
} from './sandbox-check-driver';
import type { CommandResult } from './sandbox-driver';
import type { CheckEgress, OutboundProps } from './sandbox-outbound';
import {
  bundleInstallScript,
  checkDirectory,
  checkOutputDirectory,
  checkScript,
  checkTailBytes,
  cloneScript,
  revisionScript,
  siteScript,
  testBundleDirectory,
  trustEnv,
} from './sandbox-shell';
import { ledger, object } from './storage';
import { approvedBundle } from './test-bundle';
import type { Env, Json } from './types';

/** What the check port needs from the Durable Object that owns the container. */
export interface SandboxHost {
  ensure(props: OutboundProps, start: boolean): Promise<void>;
  /** `stdin`, when given, is the command's whole input. */
  run(
    command: string[],
    cwd: string,
    env: Record<string, string>,
    stdin?: string,
  ): Promise<CommandResult>;
  destroy(): Promise<void>;
}

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
const hex = (value: unknown) =>
  typeof value === 'string' && /^([a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

/** One check sandbox per evaluation attempt; never the agent's sandbox name. */
export const checkName = (repo: string, job: string, epoch: number) =>
  `${repo}/check/${job}/${epoch}`;

/** Stores the check attempt in its Durable Object once and wakes it; an agent object refuses. */
export function startCheck(ctx: DurableObjectState, check: CheckAttempt) {
  return ctx.blockConcurrencyWhile(async (): Promise<'started' | 'running'> => {
    const current = ctx.storage.kv.get<CheckAttempt>('check');
    if (current?.job_id === check.job_id && current.epoch === check.epoch) return 'running';
    if (current || ctx.storage.kv.get('attempt'))
      throw Object.assign(new Error('Sandbox holds another attempt'), { code: 'FENCED' });
    ctx.storage.kv.put('check', check);
    ctx.storage.kv.put('checkState', initialCheckState(Date.now()));
    await ctx.storage.setAlarm(Date.now());
    return 'started';
  });
}

/** Runs one check step when this object is a check sandbox; false when it is not. */
export async function checkAlarm(ctx: DurableObjectState, env: Env, host: SandboxHost) {
  const check = ctx.storage.kv.get<CheckAttempt>('check');
  const state = ctx.storage.kv.get<CheckState>('checkState');
  if (!check || !state) return false;
  const { state: next, next: at } = await checkStep(state, check, checkPort(env, host, check));
  ctx.storage.kv.put('checkState', next);
  if (at !== null) await ctx.storage.setAlarm(at);
  return true;
}

function commands(value: unknown): CommandSpec[] {
  if (!Array.isArray(value) || value.length > 12)
    return fail('INVALID_INPUT', 'Invalid check list');
  return value.map((spec: Json) => {
    const argv = spec?.argv;
    if (
      typeof spec?.name !== 'string' ||
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((arg: unknown) => typeof arg === 'string' && !arg.includes('\0')) ||
      !Number.isInteger(spec.timeout_seconds) ||
      spec.timeout_seconds < 1 ||
      spec.timeout_seconds > 90
    )
      return fail('INVALID_INPUT', 'Invalid check command');
    return { name: spec.name, argv, timeout_seconds: spec.timeout_seconds };
  });
}

/** The claimed evaluation as a check sandbox needs it; anything unexpected fails closed. */
export async function checkAttempt(env: Env, repo: string, job: Json): Promise<CheckAttempt> {
  const payload = job.payload ?? {};
  const candidate = payload.candidate ?? {};
  const policy = payload.policy ?? {};
  const build = policy.build ?? {};
  const integrity = payload.source_integrity ?? {};
  if (build.app) fail('NOT_SUPPORTED', 'These checks run in the evaluator container');
  const bundle = build.test_bundle ?? null;
  if (bundle !== null && !/^[a-f0-9]{64}$/.test(String(bundle.digest)))
    fail('INVALID_INPUT', 'Invalid test bundle digest');
  if (
    typeof candidate.id !== 'string' ||
    !hex(candidate.revision?.commit) ||
    !hex(candidate.tree) ||
    revisionProject(candidate.revision?.repository) !== repo ||
    integrity.candidate_id !== candidate.id ||
    integrity.revision?.commit !== candidate.revision.commit ||
    !Array.isArray(integrity.protected_changes) ||
    !integrity.protected_changes.every((path: unknown) => typeof path === 'string') ||
    // Only a bundle protects paths; the report carries what the candidate changed in them.
    (bundle === null && integrity.protected_changes.length !== 0)
  )
    fail('INVALID_INPUT', 'Check candidate differs from its source integrity record');
  const repository = await ledger(env, repo, { op: 'repository_status' });
  if (!repository.platform_repo || !env.SANDBOX_PLATFORM_ORIGIN)
    fail('INVALID_INPUT', 'Check sandbox needs a platform repository');
  return {
    repo,
    job_id: String(job.id),
    epoch: Number(job.epoch),
    owner: String(repository.workspace),
    platform_repo: String(repository.platform_repo),
    platform_origin: new URL(String(env.SANDBOX_PLATFORM_ORIGIN)).origin,
    candidate: {
      id: candidate.id,
      repository: candidate.revision.repository,
      commit: candidate.revision.commit,
      tree: candidate.tree,
    },
    suite: String(policy.suite),
    environment: String(policy.environment),
    setup: commands(build.setup ?? []),
    checks: commands(build.checks),
    static_dir: typeof build.static_dir === 'string' ? build.static_dir : null,
    test_bundle: bundle && {
      digest: String(bundle.digest),
      protected_changes: integrity.protected_changes,
    },
  };
}

/** Starts (or re-finds) the evaluation's check sandbox; repeated delivery starts nothing twice. */
export async function beginCheck(env: Env, repo: string, job: Json): Promise<void> {
  const namespace = env.AGENT_SANDBOX;
  if (!namespace) return fail('SANDBOX_UNAVAILABLE', 'Sandbox checks are not deployed here');
  const check = await checkAttempt(env, repo, job);
  await namespace.getByName(checkName(repo, check.job_id, check.epoch)).beginCheck(check);
}

export const checkEgress = (check: CheckAttempt): CheckEgress => ({
  role: 'check',
  project: check.repo,
  owner: check.owner,
  platformRepo: check.platform_repo,
  platformOrigin: check.platform_origin,
});

const tail = (path: string) => [
  '/bin/sh',
  '-c',
  'tail -c "$1" "$2" 2>/dev/null',
  'tail',
  String(checkTailBytes),
  path,
];

/** The check driver's port: the container through `host`, the report through the ledger. */
export function checkPort(env: Env, host: SandboxHost, check: CheckAttempt): CheckPort {
  const egress = checkEgress(check);
  const identity = { job_id: check.job_id, epoch: check.epoch };
  const run = async (
    command: string[],
    cwd = '/',
    vars: Record<string, string> = {},
    stdin?: string,
  ) => {
    await host.ensure(egress, false);
    return host.run(command, cwd, vars, stdin);
  };
  return {
    now: () => Date.now(),
    attemptActive: async () => {
      const job = await ledger(env, check.repo, { op: 'job_status', id: check.job_id });
      return job.status === 'running' && Number(job.epoch) === check.epoch;
    },
    prepare: () => host.ensure(egress, true),
    clone: () =>
      run(
        [
          '/bin/sh',
          '-c',
          cloneScript,
          'clone',
          check.platform_origin,
          check.platform_repo,
          check.candidate.commit,
          checkDirectory,
        ],
        '/workspace',
        { ...trustEnv, YONEDA_TOKEN: 'provided-by-worker' },
      ),
    revision: async () => {
      const result = await run(['/bin/sh', '-c', revisionScript, 'revision', checkDirectory]);
      const [head = '', tree = ''] = result.stdout.trim().split('\n');
      if (result.exitCode !== 0)
        throw new Error(`git rev-parse failed: ${result.stderr.slice(-300)}`);
      return { head, tree };
    },
    installBundle: async (digest) => {
      // The digest-checked bundle, as the broker hands it to the evaluator container.
      const { encoded } = await approvedBundle(env, digest);
      const result = await run(
        ['node', '-e', bundleInstallScript, testBundleDirectory],
        '/',
        {},
        encoded,
      );
      if (result.exitCode !== 0)
        throw new Error(`Test bundle install failed: ${result.stderr.slice(-300)}`);
      return result.stdout.trim();
    },
    run: async (spec) => {
      const status = await run([
        '/bin/sh',
        '-c',
        checkScript,
        'check',
        checkDirectory,
        checkOutputDirectory,
        String(spec.timeout_seconds),
        ...spec.argv,
      ]);
      if (status.exitCode !== 0)
        throw new Error(`Check script failed: ${status.stderr.slice(-300)}`);
      const stdout = await run(tail(`${checkOutputDirectory}/stdout`));
      const stderr = await run(tail(`${checkOutputDirectory}/stderr`));
      return commandOutput(status.stdout, stdout.stdout, stderr.stdout, checkTailBytes);
    },
    captureSite: async (directory): Promise<SiteCapture> => {
      const result = await run(['node', '-e', siteScript, checkDirectory, directory]);
      if (result.exitCode !== 0)
        throw new Error(`Static capture failed: ${result.stderr.slice(-300)}`);
      const captured = JSON.parse(result.stdout);
      if (!captured.files) return { captured: false, diagnostic: captured.error ?? null };
      // The manifest the evaluator container's broker stores for `/site`.
      const manifest = {
        repo: check.repo,
        candidate: check.candidate.id,
        revision: { repository: check.candidate.repository, commit: check.candidate.commit },
        files: captured.files,
      };
      const stored = await object(env, JSON.stringify(manifest), 12 * 1024 * 1024);
      await ledger(env, check.repo, {
        op: 'register_site',
        ...identity,
        digest: stored.digest,
        files: captured.files,
      });
      return { captured: true };
    },
    report: async (report) => {
      // As the broker does for the evaluator container: the report is the evidence.
      const stored = await object(env, JSON.stringify(report));
      await ledger(env, check.repo, {
        op: 'verify_finish',
        ...identity,
        report,
        evidence: stored.digest,
      });
    },
    fail: async (reason) => {
      await ledger(env, check.repo, {
        op: 'fail',
        ...identity,
        error: reason.slice(0, 2000),
        retryable: false,
      });
    },
    defer: async () => {
      await ledger(env, check.repo, { op: 'defer_job', ...identity, reason: 'container_capacity' });
    },
    destroy: () => host.destroy(),
  };
}
