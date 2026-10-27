// The sandbox attempt's step logic against a fake sandbox: no container, platform or model.
import { describe, expect, it } from 'vitest';
import {
  type DriverState,
  initialState,
  LIMITS,
  type LandOutcome,
  type PushResult,
  type SandboxPort,
  step,
  type TaskState,
} from '../../cloudflare/worker/sandbox-driver';

const line = (event: unknown) => JSON.stringify(event);
const tool = (name: string, input: Record<string, string>) =>
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const result = (isError: boolean, text: string) =>
  line({ type: 'result', subtype: isError ? 'error' : 'success', is_error: isError, result: text });

class FakeSandbox implements SandboxPort {
  clock = 1_000_000;
  calls: string[] = [];
  activity: string[] = [];
  progressed: Record<string, unknown>[] = [];
  failed: string | null = null;
  recorded: string | null = null;
  destroyed = false;
  active = true;
  cloneExit = 0;
  stdout: string[] = [];
  taskState: TaskState = { state: 'running' };
  push: PushResult = { pushed: true };
  stderr = '';
  throwOn: string | null = null;
  onTick?: (sandbox: FakeSandbox) => void;
  team = false;
  /** What each landing returns, in order (then: landed). */
  landings: LandOutcome[] = [];
  reports: { outcome: LandOutcome; round: number }[] = [];
  resumed: { session: string; paths: string[] }[] = [];

  private guard(name: string) {
    this.calls.push(name);
    if (this.throwOn === name) throw new Error(`${name} unavailable`);
  }
  now = () => this.clock;
  attemptActive = async () => this.active;
  prepare = async () => this.guard('prepare');
  clone = async () => {
    this.guard('clone');
    return { exitCode: this.cloneExit, stdout: '', stderr: this.cloneExit ? 'fatal: no repo' : '' };
  };
  startAgent = async () => this.guard('startAgent');
  task = async () => {
    this.guard('task');
    return this.taskState;
  };
  readOutput = async (offset: number) => {
    const text = this.stdout.map((l) => `${l}\n`).join('');
    const rest = new TextEncoder().encode(text).subarray(offset);
    const lines = new TextDecoder().decode(rest).split('\n').filter(Boolean);
    return { consumed: rest.length, lines };
  };
  stderrTail = async () => this.stderr;
  stopAgent = async () => this.guard('stopAgent');
  commitAndPush = async (message: string, keepHistory: boolean) => {
    this.guard(`push:${message}${keepHistory ? ' (history)' : ''}`);
    return this.push;
  };
  land = async (): Promise<LandOutcome> => {
    this.guard('land');
    return (
      this.landings.shift() ?? { landed: true, commit: 'c'.repeat(40), teamCommit: 'd'.repeat(40), version: 4 }
    );
  };
  // The ledger's rule: a conflict in round 0 gets the one resume.
  reportLanding = async (outcome: LandOutcome, round: number) => {
    this.reports.push({ outcome, round });
    return { resume: !outcome.landed && round === 0 };
  };
  resumeAgent = async (session: string, paths: string[]) => {
    this.guard('resume');
    this.resumed.push({ session, paths });
    // The resumed CLI writes a fresh task directory.
    this.stdout = [];
    this.taskState = { state: 'running' };
  };
  record = async (summary: string) => {
    this.guard('record');
    this.recorded = summary;
  };
  fail = async (reason: string) => {
    this.failed = reason;
  };
  progress = async (activity: Record<string, unknown>) => {
    this.progressed.push(activity);
  };
  appendActivity = async (_at: number, entries: { text: string }[]) => {
    this.activity.push(...entries.map((e) => e.text));
  };
  destroy = async () => {
    this.destroyed = true;
  };
}

/** Runs alarms until the driver finishes, advancing the clock to each requested time. */
async function drive(sandbox: FakeSandbox, state: DriverState = initialState(sandbox.clock), max = 50) {
  let current = state;
  for (let i = 0; i < max; i++) {
    const { state: next, next: at } = await step(current, sandbox);
    current = next;
    if (at === null) return current;
    sandbox.clock = Math.max(sandbox.clock, at);
    sandbox.onTick?.(sandbox);
  }
  return current;
}

describe('sandbox attempt steps', () => {
  it('clones, runs the CLI, pushes and records the commit', async () => {
    const sandbox = new FakeSandbox();
    let polls = 0;
    sandbox.onTick = (s) => {
      if (s.calls.includes('startAgent') && ++polls === 2) {
        s.stdout.push(tool('Edit', { file_path: 'src/math.js' }), result(false, 'Added add(a,b)'));
        s.taskState = { state: 'exited', exitCode: 0 };
      }
    };
    const final = await drive(sandbox);
    expect(final.phase).toBe('done');
    expect(sandbox.calls.filter((c) => !c.startsWith('task'))).toEqual([
      'prepare',
      'clone',
      'startAgent',
      'push:Agent change: Added add(a,b)',
      'record',
    ]);
    expect(sandbox.activity).toEqual(['Edit src/math.js', 'Agent finished: Added add(a,b)']);
    expect(sandbox.recorded).toBe('Added add(a,b)');
    expect(sandbox.failed).toBeNull();
    expect(sandbox.destroyed).toBe(true);
    expect(sandbox.progressed.map((p) => p.phase)).toEqual(
      expect.arrayContaining(['cloning', 'running', 'finalizing', 'recording']),
    );
  });

  it('surfaces the CLI failure reason and pushes nothing', async () => {
    const sandbox = new FakeSandbox();
    sandbox.onTick = (s) => {
      if (s.calls.includes('startAgent')) {
        s.stdout.push(result(true, 'API Error: 401 Unauthorized'));
        s.taskState = { state: 'exited', exitCode: 0 };
      }
    };
    await drive(sandbox);
    expect(sandbox.failed).toBe('The agent CLI failed: API Error: 401 Unauthorized');
    expect(sandbox.calls.some((c) => c.startsWith('push'))).toBe(false);
    expect(sandbox.destroyed).toBe(true);
  });

  it('reports a CLI that exited without a result with the end of its stderr', async () => {
    const sandbox = new FakeSandbox();
    sandbox.stderr = 'Error: Invalid API key';
    sandbox.onTick = (s) => {
      if (s.calls.includes('startAgent')) s.taskState = { state: 'exited', exitCode: 1 };
    };
    await drive(sandbox);
    expect(sandbox.failed).toBe('The agent CLI failed: exited with 1: Error: Invalid API key');
  });

  it('commits and pushes what exists at the safety cap, then stops', async () => {
    const sandbox = new FakeSandbox();
    sandbox.onTick = (s) => {
      if (s.calls.includes('startAgent') && s.stdout.length === 0)
        s.stdout.push(tool('Bash', { command: 'npm test' }));
      // Still running two hours later.
      if (s.calls.includes('startAgent')) s.clock += 20 * 60 * 1000;
    };
    const final = await drive(sandbox, undefined, 200);
    expect(final.capped).toBe(true);
    expect(sandbox.calls).toContain('stopAgent');
    expect(sandbox.calls).toContain('push:Agent work at the two-hour safety cap');
    expect(sandbox.recorded).toMatch(/^Stopped at the safety cap/);
    expect(sandbox.failed).toBeNull();
  });

  it('marks a live but silent CLI idle after ten minutes and never stops it for that', async () => {
    const sandbox = new FakeSandbox();
    let state = initialState(sandbox.clock);
    for (const _ of [1, 2]) state = (await step(state, sandbox)).state; // prepare, clone
    expect(state.phase).toBe('running');
    sandbox.clock += LIMITS.idleMs + 1;
    state = (await step(state, sandbox)).state;
    const last = sandbox.progressed.at(-1);
    expect(last).toMatchObject({ phase: 'running' });
    expect(Number(last?.idle_ms)).toBeGreaterThanOrEqual(LIMITS.idleMs);
    expect(sandbox.calls).not.toContain('stopAgent');
    expect(state.phase).toBe('running');
  });

  it('fails a clone with its error and destroys the sandbox', async () => {
    const sandbox = new FakeSandbox();
    sandbox.cloneExit = 128;
    await drive(sandbox);
    expect(sandbox.failed).toBe('Clone failed: fatal: no repo');
    expect(sandbox.calls).not.toContain('startAgent');
    expect(sandbox.destroyed).toBe(true);
  });

  it('fails an attempt that changed nothing', async () => {
    const sandbox = new FakeSandbox();
    sandbox.push = { pushed: false, reason: 'unchanged' };
    sandbox.onTick = (s) => {
      if (s.calls.includes('startAgent')) {
        s.stdout.push(result(false, 'Nothing to do'));
        s.taskState = { state: 'exited', exitCode: 0 };
      }
    };
    await drive(sandbox);
    expect(sandbox.failed).toBe('The agent finished without changing any file');
    expect(sandbox.recorded).toBeNull();
  });

  it('stops and destroys the sandbox once the ledger cancelled the attempt', async () => {
    const sandbox = new FakeSandbox();
    sandbox.onTick = (s) => {
      if (s.calls.includes('startAgent')) s.active = false;
    };
    const final = await drive(sandbox);
    expect(final.phase).toBe('done');
    expect(sandbox.destroyed).toBe(true);
    expect(sandbox.failed).toBeNull();
  });

  it('retries a failing step and fails the attempt after repeated errors', async () => {
    const sandbox = new FakeSandbox();
    sandbox.throwOn = 'prepare';
    const final = await drive(sandbox);
    expect(sandbox.calls.filter((c) => c === 'prepare')).toHaveLength(LIMITS.maxErrors);
    expect(sandbox.failed).toBe('Sandbox starting failed: prepare unavailable');
    expect(final.phase).toBe('done');
  });

  it('fails a sandbox whose container stopped before the agent finished', async () => {
    const sandbox = new FakeSandbox();
    sandbox.onTick = (s) => {
      if (s.calls.includes('startAgent')) s.taskState = { state: 'lost' };
    };
    await drive(sandbox);
    expect(sandbox.failed).toBe('The sandbox stopped before the agent finished');
  });
});

describe('sandbox team member steps', () => {
  const init = line({ type: 'system', subtype: 'init', session_id: 'session-0123-abcd', model: 'glm' });
  const conflict: LandOutcome = { landed: false, paths: ['src/math.js'] };
  /** A member whose CLI finishes once per start or resume. */
  function member() {
    const sandbox = new FakeSandbox();
    sandbox.team = true;
    let runs = 0;
    sandbox.onTick = (s) => {
      const starts = s.calls.filter((c) => c === 'startAgent' || c === 'resume').length;
      if (starts > runs && s.taskState.state === 'running') {
        runs = starts;
        s.stdout.push(init, result(false, `Done ${runs}`));
        s.taskState = { state: 'exited', exitCode: 0 };
      }
    };
    return sandbox;
  }

  it('lands the pushed commit on the team branch instead of recording a candidate', async () => {
    const sandbox = member();
    const final = await drive(sandbox);
    expect(final.phase).toBe('done');
    expect(sandbox.calls.filter((c) => !c.startsWith('task'))).toEqual([
      'prepare',
      'clone',
      'startAgent',
      'push:Agent change: Done 1',
      'land',
    ]);
    expect(sandbox.recorded).toBeNull();
    expect(sandbox.reports.map((r) => [r.outcome.landed, r.round])).toEqual([[true, 0]]);
    expect(sandbox.failed).toBeNull();
    expect(sandbox.destroyed).toBe(true);
  });

  it('resumes the same CLI session exactly once on a conflict, then lands its merge', async () => {
    const sandbox = member();
    sandbox.landings = [conflict];
    const final = await drive(sandbox);
    expect(final.phase).toBe('done');
    expect(sandbox.resumed).toEqual([{ session: 'session-0123-abcd', paths: ['src/math.js'] }]);
    // The resumed work keeps its history: the agent's merge of the team branch lands as is.
    expect(sandbox.calls.filter((c) => c.startsWith('push') || c === 'land' || c === 'resume')).toEqual([
      'push:Agent change: Done 1',
      'land',
      'resume',
      'push:Agent change: Done 2 (history)',
      'land',
    ]);
    expect(sandbox.reports.map((r) => [r.outcome.landed, r.round])).toEqual([
      [false, 0],
      [true, 1],
    ]);
    expect(sandbox.progressed.map((p) => p.phase)).toEqual(
      expect.arrayContaining(['landing', 'resolving']),
    );
    expect(sandbox.failed).toBeNull();
  });

  it('fails the member with the conflict paths after a second conflict', async () => {
    const sandbox = member();
    sandbox.landings = [conflict, conflict];
    await drive(sandbox);
    expect(sandbox.resumed).toHaveLength(1);
    expect(sandbox.failed).toBe('Conflicts with the team branch on src/math.js after one resume');
    expect(sandbox.destroyed).toBe(true);
  });

  it('fails a conflicting member whose session cannot be resumed', async () => {
    const sandbox = member();
    sandbox.landings = [conflict];
    sandbox.onTick = (s) => {
      if (s.calls.includes('startAgent') && s.taskState.state === 'running') {
        s.stdout.push(result(false, 'Done'));
        s.taskState = { state: 'exited', exitCode: 0 };
      }
    };
    await drive(sandbox);
    expect(sandbox.resumed).toEqual([]);
    expect(sandbox.failed).toBe(
      'Conflicts with the team branch on src/math.js; the agent session cannot be resumed',
    );
  });
});
