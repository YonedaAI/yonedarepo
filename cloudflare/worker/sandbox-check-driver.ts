// The policy checks of a sandbox run's candidate, in a fresh check sandbox on a real disk, as
// plain steps (one per Durable Object alarm):
//   starting → cloning → setup → checks → site → reporting → done.
// The clone is verified against the candidate's exact commit and tree before anything runs,
// and a mismatch fails closed. Each command runs as the evaluator container runs it (same argv,
// repository-root cwd, timeout and cleared environment) and its observation keeps the
// evaluator's report format, so ledger validation, evidence and publish gating are unchanged.
// No wall-clock kill beyond each command's own timeout, plus one generous overall cap. This
// module holds no Cloudflare API: `CheckPort` is the sandbox and the ledger.
// A check whose sandbox cannot start for lack of container capacity is given back to the
// ledger (deferred, then claimed again into a fresh check sandbox), never failed.
import { capacityUnavailable } from './container-capacity';
import type { CommandResult } from './sandbox-driver';

export type CommandSpec = { name: string; argv: string[]; timeout_seconds: number };
/** One command's observation in the evaluator container's format. */
export type CommandOutput = { exit: number | null; [field: string]: unknown };
export type Observation = { name: string; output: CommandOutput };
export type SiteCapture = { captured: true } | { captured: false; diagnostic: unknown };

/** What a check sandbox needs: the frozen candidate and the owner-approved commands. */
export type CheckAttempt = {
  repo: string;
  job_id: string;
  epoch: number;
  owner: string;
  platform_repo: string;
  platform_origin: string;
  candidate: { id: string; repository: string; commit: string; tree: string };
  suite: string;
  environment: string;
  setup: CommandSpec[];
  checks: CommandSpec[];
  static_dir: string | null;
};

export type CheckPhase =
  | 'starting'
  | 'cloning'
  | 'setup'
  | 'checks'
  | 'site'
  | 'reporting'
  | 'done';
export type CheckState = {
  phase: CheckPhase;
  startedAt: number;
  setup: Observation[];
  commands: Observation[];
  site?: SiteCapture;
  errors: number;
};

export interface CheckPort {
  now(): number;
  /** False once the ledger cancelled, failed or superseded this check attempt. */
  attemptActive(): Promise<boolean>;
  prepare(): Promise<void>;
  /** Clones the platform repository read-only and checks out the candidate commit detached. */
  clone(): Promise<CommandResult>;
  /** The checkout's HEAD commit and its tree. */
  revision(): Promise<{ head: string; tree: string }>;
  run(spec: CommandSpec): Promise<CommandOutput>;
  captureSite(directory: string): Promise<SiteCapture>;
  report(report: Record<string, unknown>): Promise<void>;
  fail(reason: string): Promise<void>;
  /** Gives the claim back to be retried later: no container could be allocated yet. */
  defer(): Promise<void>;
  destroy(): Promise<void>;
}

export const CHECK_LIMITS = {
  /** Generous: policy commands total at most 90 s; this only ends a stuck check attempt. */
  capMs: 15 * 60 * 1000,
  retryMs: 10_000,
  maxErrors: 3,
};

/** The evaluator container's timeout observation, field for field. */
const TIMED_OUT: CommandOutput = {
  exit: null,
  timeout: true,
  stdout: '',
  stderr: 'Command exceeded approved timeout',
};

/**
 * One command's observation from the check script's status line (`exit <code> <stdout bytes>
 * <stderr bytes>` or `timeout <stdout bytes> <stderr bytes>`) and the tails it kept.
 */
export function commandOutput(
  status: string,
  stdout: string,
  stderr: string,
  limit = 65_536,
): CommandOutput {
  const [kind, ...fields] = status.trim().split(' ');
  const numbers = fields.map((n) => (/^\d{1,15}$/.test(n) ? Number(n) : Number.NaN));
  const valid = !numbers.some(Number.isNaN);
  if (kind === 'timeout' && valid && numbers.length === 2) return { ...TIMED_OUT };
  if (kind !== 'exit' || !valid || numbers.length !== 3)
    throw new Error(`Unreadable check status: ${status.slice(0, 100)}`);
  const [code, outBytes, errBytes] = numbers;
  return {
    exit: code,
    signal: null,
    stdout,
    stderr,
    stdout_truncated: outBytes > limit,
    stderr_truncated: errBytes > limit,
  };
}

export const initialCheckState = (now: number): CheckState => ({
  phase: 'starting',
  startedAt: now,
  setup: [],
  commands: [],
  errors: 0,
});

/** The report `verify_finish` validates, as the evaluator container builds it. */
export function checkReport(check: CheckAttempt, state: CheckState): Record<string, unknown> {
  const report: Record<string, unknown> = {
    setup: state.setup,
    commands: state.commands,
    environment: check.environment,
    suite: check.suite,
    // No immutable test bundle (those policies stay with the evaluator container).
    test_bundle_digest: null,
    protected_changes: [],
    test_bundle_policy_digest: null,
  };
  if (state.site && !state.site.captured) {
    report.static_error = 'Static output missing, unsafe or exceeds limits';
    report.static_export_diagnostic = state.site.diagnostic;
  }
  return report;
}

export type CheckStep = { state: CheckState; next: number | null };

/** Runs the current phase once and says when to run again (`null`: finished). */
export async function checkStep(
  input: CheckState,
  check: CheckAttempt,
  port: CheckPort,
): Promise<CheckStep> {
  const state = { ...input };
  if (state.phase === 'done') return { state, next: null };
  try {
    if (!(await port.attemptActive())) return await finish(state, port);
    if (port.now() - state.startedAt >= CHECK_LIMITS.capMs) {
      await port.fail(
        `The checks did not finish within the ${CHECK_LIMITS.capMs / 60_000}-minute cap`,
      );
      return await finish(state, port);
    }
    const done = await advance(state, check, port);
    state.errors = 0;
    return done ? await finish(state, port) : { state, next: port.now() };
  } catch (failure) {
    if (state.phase === 'starting' && capacityUnavailable(failure)) {
      const deferred = await port.defer().then(
        () => true,
        () => false,
      );
      if (deferred) return await finish(state, port);
    }
    state.errors += 1;
    const message = failure instanceof Error ? failure.message : String(failure);
    if (state.errors < CHECK_LIMITS.maxErrors)
      return { state, next: port.now() + CHECK_LIMITS.retryMs };
    await port
      .fail(`Check sandbox ${state.phase} failed: ${message}`.slice(0, 1000))
      .catch(() => {});
    return await finish(state, port);
  }
}

async function finish(state: CheckState, port: CheckPort): Promise<CheckStep> {
  await port.destroy().catch(() => {});
  state.phase = 'done';
  return { state, next: null };
}

const afterCommands = (check: CheckAttempt): CheckPhase =>
  check.static_dir ? 'site' : 'reporting';

/** One action of the current phase; true when the attempt is over. */
async function advance(state: CheckState, check: CheckAttempt, port: CheckPort): Promise<boolean> {
  switch (state.phase) {
    case 'starting':
      await port.prepare();
      state.phase = 'cloning';
      return false;
    case 'cloning': {
      const cloned = await port.clone();
      if (cloned.exitCode !== 0) {
        await port.fail(
          `Check sandbox clone failed: ${cloned.stderr.trim().slice(-500) || `exit ${cloned.exitCode}`}`,
        );
        return true;
      }
      const { head, tree } = await port.revision();
      const { commit, tree: expected } = check.candidate;
      if (head !== commit || tree !== expected) {
        await port.fail(
          `Check checkout differs from the candidate: HEAD ${head} tree ${tree}, expected ${commit} tree ${expected}`,
        );
        return true;
      }
      state.phase = 'setup';
      return false;
    }
    case 'setup': {
      const spec = check.setup[state.setup.length];
      if (!spec) {
        state.phase = 'checks';
        return false;
      }
      const output = await port.run(spec);
      state.setup = [...state.setup, { name: spec.name, output }];
      // The evaluator runs no check after a failed setup command.
      if (output.exit !== 0) state.phase = afterCommands(check);
      return false;
    }
    case 'checks': {
      const spec = check.checks[state.commands.length];
      if (!spec) {
        state.phase = afterCommands(check);
        return false;
      }
      const output = await port.run(spec);
      state.commands = [...state.commands, { name: spec.name, output }];
      return false;
    }
    case 'site':
      state.site = await port.captureSite(String(check.static_dir));
      state.phase = 'reporting';
      return false;
    case 'reporting':
      await port.report(checkReport(check, state));
      return true;
    default:
      return true;
  }
}
