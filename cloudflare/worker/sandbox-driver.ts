// The sandbox attempt as plain steps, one per Durable Object alarm:
//   starting → cloning → running → finalizing → recording → done.
// A team member lands instead of recording: finalizing → landing → done; a conflict there
// resumes the CLI's session once (landing → resolving → running → finalizing → landing).
// No wall-clock kill: the CLI runs until it exits. Only a generous safety cap stops it, and
// then what exists is still committed and pushed. A live but silent CLI is reported idle,
// never stopped. This module holds no Cloudflare API: `SandboxPort` is the sandbox, the
// platform and the ledger, so the step logic is tested with a fake.
import {
  type Activity,
  type CliOutcome,
  parseActivity,
  resultOutcome,
  sessionId,
} from './sandbox-activity';

export type Phase =
  | 'starting'
  | 'cloning'
  | 'running'
  | 'finalizing'
  | 'landing'
  | 'resolving'
  | 'recording'
  | 'done';
export type TaskState =
  | { state: 'running' }
  | { state: 'exited'; exitCode: number }
  | { state: 'lost' };
export type PushResult = { pushed: true } | { pushed: false; reason: 'unchanged' };
export type CommandResult = { exitCode: number; stdout: string; stderr: string };
/** A team member's commit on the team branch: landed (and the branch head), or conflicting. */
export type LandOutcome =
  | { landed: true; commit: string; teamCommit: string; version: number | null }
  | { landed: false; paths: string[] };

export interface SandboxPort {
  now(): number;
  /** False once the ledger cancelled, failed or superseded this attempt. */
  attemptActive(): Promise<boolean>;
  prepare(): Promise<void>;
  clone(): Promise<CommandResult>;
  startAgent(): Promise<void>;
  task(): Promise<TaskState>;
  /** Complete stdout lines after `offset` bytes, and how many bytes they used. */
  readOutput(offset: number): Promise<{ consumed: number; lines: string[] }>;
  stderrTail(): Promise<string>;
  stopAgent(): Promise<void>;
  /** `keepHistory`: push HEAD as is (a resumed member's merge), not one commit on the base. */
  commitAndPush(message: string, keepHistory: boolean): Promise<PushResult>;
  record(summary: string): Promise<void>;
  /** A team member: its commit lands on the team branch instead of becoming a candidate. */
  readonly team: boolean;
  /** Lands the pushed commit on the team branch (the trusted side, never the sandbox). */
  land(): Promise<LandOutcome>;
  /** Records the landing; for a conflict, whether the member gets its one resume. */
  reportLanding(outcome: LandOutcome, round: number): Promise<{ resume: boolean }>;
  /** Fetches the team branch into the sandbox and resumes the CLI's session on `paths`. */
  resumeAgent(sessionId: string, paths: string[]): Promise<void>;
  fail(reason: string): Promise<void>;
  progress(activity: {
    phase: Exclude<Phase, 'done'>;
    last_activity_at: number;
    summary: string;
    idle_ms: number;
  }): Promise<void>;
  appendActivity(at: number, entries: Activity[]): Promise<void>;
  destroy(): Promise<void>;
}

export type DriverState = {
  phase: Phase;
  agentStartedAt?: number;
  lastActivityAt: number;
  offset: number;
  summary: string;
  /** The agent's own last activity line; phase summaries never replace it. */
  agentSummary?: string;
  outcome?: CliOutcome;
  /** The CLI session to resume after a team conflict. */
  sessionId?: string;
  /** A team member's landing round: 1 once it was resumed after a conflict. */
  round?: number;
  /** The paths a resumed member resolves. */
  conflict?: string[];
  capped?: boolean;
  errors: number;
  reportedAt?: number;
  reportedSummary?: string;
};

export const LIMITS = {
  pollMs: 10_000,
  /** Generous: the owner's tasks run for minutes; this only ends a runaway attempt. */
  safetyCapMs: 2 * 60 * 60 * 1000,
  idleMs: 10 * 60 * 1000,
  reportMs: 30_000,
  retryMs: 30_000,
  maxErrors: 5,
};

export const initialState = (now: number): DriverState => ({
  phase: 'starting',
  lastActivityAt: now,
  offset: 0,
  summary: 'Starting the sandbox',
  errors: 0,
});

export type Step = { state: DriverState; next: number | null };

/** Runs the current phase once and says when to run again (`null`: finished). */
export async function step(input: DriverState, port: SandboxPort): Promise<Step> {
  const state = { ...input };
  if (state.phase === 'done') return { state, next: null };
  try {
    if (!(await port.attemptActive())) return await finish(state, port);
    const next = await advance(state, port);
    return { state, next };
  } catch (failure) {
    state.errors += 1;
    const message = failure instanceof Error ? failure.message : String(failure);
    if (state.errors < LIMITS.maxErrors) return { state, next: port.now() + LIMITS.retryMs };
    await port.fail(`Sandbox ${state.phase} failed: ${message}`.slice(0, 1000)).catch(() => {});
    return await finish(state, port);
  }
}

async function finish(state: DriverState, port: SandboxPort): Promise<Step> {
  await port.destroy();
  state.phase = 'done';
  return { state, next: null };
}

/** Moves to `phase`, reports it and clears the retry count. */
async function enter(
  state: DriverState,
  port: SandboxPort,
  phase: Exclude<Phase, 'done'>,
  summary: string,
) {
  state.phase = phase;
  state.summary = summary;
  state.errors = 0;
  await report(state, port, true);
}

async function report(state: DriverState, port: SandboxPort, force = false) {
  const now = port.now();
  if (state.phase === 'done') return;
  if (
    !force &&
    state.summary === state.reportedSummary &&
    now - (state.reportedAt ?? 0) < LIMITS.reportMs
  )
    return;
  await port.progress({
    phase: state.phase,
    last_activity_at: Math.min(state.lastActivityAt, now),
    summary: state.summary,
    idle_ms: Math.max(0, now - state.lastActivityAt),
  });
  state.reportedAt = now;
  state.reportedSummary = state.summary;
}

/** Reads new CLI output into the activity log and remembers the CLI's verdict. */
async function drain(state: DriverState, port: SandboxPort) {
  const { consumed, lines } = await port.readOutput(state.offset);
  if (consumed === 0) return;
  const now = port.now();
  const entries = lines.flatMap(parseActivity);
  for (const line of lines) {
    state.outcome = resultOutcome(line) ?? state.outcome;
    state.sessionId ??= sessionId(line) ?? undefined;
  }
  if (entries.length) {
    await port.appendActivity(now, entries);
    state.summary = entries[entries.length - 1].text;
    state.agentSummary = state.summary;
  }
  state.offset += consumed;
  state.lastActivityAt = now;
}

const agentResult = (state: DriverState) =>
  (state.outcome?.ok ? state.outcome.result : state.agentSummary) ?? 'Agent change';

async function advance(state: DriverState, port: SandboxPort): Promise<number | null> {
  const now = port.now();
  switch (state.phase) {
    case 'starting':
      await port.prepare();
      await enter(state, port, 'cloning', 'Cloning the repository');
      return now;
    case 'cloning': {
      const cloned = await port.clone();
      if (cloned.exitCode !== 0) {
        await port.fail(
          `Clone failed: ${cloned.stderr.trim().slice(-500) || `exit ${cloned.exitCode}`}`,
        );
        await finish(state, port);
        return null;
      }
      await port.startAgent();
      state.agentStartedAt = port.now();
      state.lastActivityAt = state.agentStartedAt;
      await enter(state, port, 'running', 'Agent started');
      return port.now() + LIMITS.pollMs;
    }
    case 'running':
      return running(state, port);
    case 'finalizing': {
      const message = state.capped
        ? 'Agent work at the two-hour safety cap'
        : `Agent change: ${agentResult(state)}`;
      const pushed = await port.commitAndPush(message.slice(0, 500), (state.round ?? 0) > 0);
      if (!pushed.pushed) {
        await port.fail(
          state.capped
            ? 'The safety cap stopped the agent before it changed any file'
            : 'The agent finished without changing any file',
        );
        await finish(state, port);
        return null;
      }
      if (port.team) {
        await enter(state, port, 'landing', 'Landing on the team branch');
        return port.now();
      }
      await enter(state, port, 'recording', 'Recording the pushed commit');
      return port.now();
    }
    case 'landing':
      return landing(state, port);
    case 'resolving':
      await port.resumeAgent(state.sessionId ?? '', state.conflict ?? []);
      state.offset = 0;
      state.outcome = undefined;
      state.lastActivityAt = port.now();
      await enter(state, port, 'running', 'Agent resumed to resolve the conflict');
      return port.now() + LIMITS.pollMs;
    case 'recording':
      await port.record(
        state.capped ? `Stopped at the safety cap: ${agentResult(state)}` : agentResult(state),
      );
      await finish(state, port);
      return null;
    default:
      return null;
  }
}

/** Lands a team member's commit; one conflict resumes it, a second fails it. */
async function landing(state: DriverState, port: SandboxPort): Promise<number | null> {
  const round = state.round ?? 0;
  const outcome = await port.land();
  const { resume } = await port.reportLanding(outcome, round);
  if (outcome.landed) {
    await finish(state, port);
    return null;
  }
  const paths = outcome.paths.join(', ');
  if (!resume || round > 0 || !state.sessionId) {
    await port.fail(
      round > 0
        ? `Conflicts with the team branch on ${paths} after one resume`
        : `Conflicts with the team branch on ${paths}; the agent session cannot be resumed`,
    );
    await finish(state, port);
    return null;
  }
  state.round = 1;
  state.conflict = outcome.paths;
  await enter(state, port, 'resolving', `Conflict on ${paths}: resuming the agent`);
  return port.now();
}

async function running(state: DriverState, port: SandboxPort): Promise<number | null> {
  await drain(state, port);
  const task = await port.task();
  if (task.state === 'running') {
    if (port.now() - (state.agentStartedAt ?? port.now()) >= LIMITS.safetyCapMs) {
      await port.stopAgent();
      await drain(state, port);
      state.capped = true;
      await enter(state, port, 'finalizing', 'Safety cap reached: committing the work so far');
      return port.now();
    }
    await report(state, port);
    return port.now() + LIMITS.pollMs;
  }
  if (task.state === 'lost') {
    await port.fail('The sandbox stopped before the agent finished');
    await finish(state, port);
    return null;
  }
  // Exited: read the tail first, then decide from the CLI's own result event.
  await drain(state, port);
  const outcome = state.outcome;
  if (!outcome?.ok) {
    const reason = outcome
      ? outcome.error
      : `exited with ${task.exitCode}: ${(await port.stderrTail()).trim().slice(-800) || 'no output'}`;
    await port.fail(`Claude Code failed: ${reason}`);
    await finish(state, port);
    return null;
  }
  await enter(state, port, 'finalizing', 'Committing and pushing the change');
  return port.now();
}
