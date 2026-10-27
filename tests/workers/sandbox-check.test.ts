// The check sandbox's step logic against a fake sandbox (no container, platform or ledger), the
// report format it shares with the evaluator container, and its read-only egress.
import { describe, expect, it } from 'vitest';
import {
  type CheckAttempt,
  type CheckPort,
  type CheckState,
  CHECK_LIMITS,
  type CommandOutput,
  type CommandSpec,
  checkStep,
  commandOutput,
  initialCheckState,
  type SiteCapture,
} from '../../cloudflare/worker/sandbox-check-driver';
import { type OutboundProps, outboundDecision } from '../../cloudflare/worker/sandbox-outbound';

const COMMIT = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const passed = (stdout = ''): CommandOutput => ({
  exit: 0,
  signal: null,
  stdout,
  stderr: '',
  stdout_truncated: false,
  stderr_truncated: false,
});

const check = (extra: Partial<CheckAttempt> = {}): CheckAttempt => ({
  repo: 'proj',
  job_id: 'evaluate:sandbox-candidate',
  epoch: 1,
  owner: 'owner',
  platform_repo: 'r0123456789abcdef0123',
  platform_origin: 'https://platform.test',
  candidate: { id: 'sandbox-candidate', repository: 'platform/proj', commit: COMMIT, tree: TREE },
  suite: 'commands-v1',
  environment: 'linux-node24-rust1.94-v1',
  setup: [],
  checks: [
    { name: 'math', argv: ['node', '-e', 'require("./src/math.js")'], timeout_seconds: 10 },
    { name: 'test', argv: ['node', '--test', 'test/math.test.js'], timeout_seconds: 30 },
  ],
  static_dir: null,
  ...extra,
});

class FakeCheckSandbox implements CheckPort {
  clock = 1_000_000;
  calls: string[] = [];
  outputs: Record<string, CommandOutput> = {};
  revisionValue = { head: COMMIT, tree: TREE };
  cloneExit = 0;
  site: SiteCapture = { captured: true };
  reported: Record<string, unknown> | null = null;
  failed: string | null = null;
  destroyed = false;
  active = true;
  throwOn: string | null = null;
  error: string | null = null;
  deferred = 0;
  deferFails = false;
  installedDigest: string | null = null;
  onTick?: (sandbox: FakeCheckSandbox) => void;

  private guard(name: string) {
    this.calls.push(name);
    if (this.throwOn === name) throw new Error(this.error ?? `${name} unavailable`);
  }
  now = () => this.clock;
  attemptActive = async () => this.active;
  prepare = async () => this.guard('prepare');
  clone = async () => {
    this.guard('clone');
    return { exitCode: this.cloneExit, stdout: '', stderr: this.cloneExit ? 'fatal: denied' : '' };
  };
  revision = async () => {
    this.guard('revision');
    return this.revisionValue;
  };
  installBundle = async (digest: string) => {
    this.guard('bundle');
    return this.installedDigest ?? digest;
  };
  run = async (spec: CommandSpec) => {
    this.guard(`run:${spec.name}`);
    return this.outputs[spec.name] ?? passed();
  };
  captureSite = async (directory: string) => {
    this.guard(`site:${directory}`);
    return this.site;
  };
  report = async (report: Record<string, unknown>) => {
    this.guard('report');
    this.reported = report;
  };
  fail = async (reason: string) => {
    this.failed = reason;
  };
  defer = async () => {
    this.calls.push('defer');
    if (this.deferFails) throw new Error('ledger unavailable');
    this.deferred += 1;
  };
  destroy = async () => {
    this.destroyed = true;
  };
}

async function drive(sandbox: FakeCheckSandbox, attempt = check(), max = 50) {
  let state: CheckState = initialCheckState(sandbox.clock);
  for (let i = 0; i < max; i++) {
    const { state: next, next: at } = await checkStep(state, attempt, sandbox);
    state = next;
    if (at === null) return state;
    sandbox.clock = Math.max(sandbox.clock, at);
    sandbox.onTick?.(sandbox);
  }
  return state;
}

describe('check sandbox steps', () => {
  it('clones the exact candidate, runs every check and reports in the evaluator format', async () => {
    const sandbox = new FakeCheckSandbox();
    sandbox.outputs.test = passed('# pass 1\n');
    const final = await drive(sandbox);
    expect(final.phase).toBe('done');
    expect(sandbox.calls).toEqual(['prepare', 'clone', 'revision', 'run:math', 'run:test', 'report']);
    expect(sandbox.reported).toEqual({
      setup: [],
      commands: [
        { name: 'math', output: passed() },
        { name: 'test', output: passed('# pass 1\n') },
      ],
      environment: 'linux-node24-rust1.94-v1',
      suite: 'commands-v1',
      test_bundle_digest: null,
      protected_changes: [],
      test_bundle_policy_digest: null,
    });
    expect(sandbox.failed).toBeNull();
    expect(sandbox.destroyed).toBe(true);
  });

  it('installs the immutable test bundle before setup and reports it as the evaluator does', async () => {
    const sandbox = new FakeCheckSandbox();
    const digest = 'b'.repeat(64);
    const bundled = check({
      setup: [{ name: 'deps', argv: ['npm', 'ci'], timeout_seconds: 60 }],
      test_bundle: { digest, protected_changes: ['tests'] },
    });
    await drive(sandbox, bundled);
    expect(sandbox.calls).toEqual(['prepare', 'clone', 'revision', 'bundle', 'run:deps', 'run:math', 'run:test', 'report']);
    // A candidate that changed a protected path is reported so the ledger rejects it.
    expect(sandbox.reported).toMatchObject({
      test_bundle_digest: digest,
      protected_changes: ['tests'],
      test_bundle_policy_digest: digest,
    });
  });

  it('fails closed when the installed bundle is not the approved one', async () => {
    const sandbox = new FakeCheckSandbox();
    sandbox.installedDigest = 'e'.repeat(64);
    await drive(sandbox, check({ test_bundle: { digest: 'b'.repeat(64), protected_changes: [] } }));
    expect(sandbox.failed).toMatch(/^Installed test bundle e+ differs from the approved b+/);
    expect(sandbox.calls).not.toContain('run:math');
    expect(sandbox.reported).toBeNull();
  });

  it('reports a failing check with its exit code and output, and runs the rest', async () => {
    const sandbox = new FakeCheckSandbox();
    sandbox.outputs.math = { ...passed(), exit: 1, stderr: 'TypeError: add is not a function' };
    await drive(sandbox);
    const commands = sandbox.reported?.commands as { name: string; output: CommandOutput }[];
    expect(commands.map((c) => [c.name, c.output.exit])).toEqual([
      ['math', 1],
      ['test', 0],
    ]);
    expect(commands[0].output.stderr).toBe('TypeError: add is not a function');
    expect(sandbox.failed).toBeNull();
  });

  it('reports a timed-out check exactly as the evaluator container does', async () => {
    const sandbox = new FakeCheckSandbox();
    sandbox.outputs.test = commandOutput('timeout 0 0', '', '');
    await drive(sandbox);
    const commands = sandbox.reported?.commands as { name: string; output: CommandOutput }[];
    expect(commands[1].output).toEqual({
      exit: null,
      timeout: true,
      stdout: '',
      stderr: 'Command exceeded approved timeout',
    });
  });

  it('skips the checks after a failed setup command, as the evaluator does', async () => {
    const sandbox = new FakeCheckSandbox();
    const setup = [
      { name: 'prepare', argv: ['node', '-e', 'process.exit(2)'], timeout_seconds: 5 },
      { name: 'never', argv: ['true'], timeout_seconds: 5 },
    ];
    sandbox.outputs.prepare = { ...passed(), exit: 2 };
    await drive(sandbox, check({ setup }));
    expect(sandbox.calls).toEqual(['prepare', 'clone', 'revision', 'run:prepare', 'report']);
    expect(sandbox.reported).toMatchObject({
      setup: [{ name: 'prepare', output: { exit: 2 } }],
      commands: [],
    });
  });

  it('fails closed when HEAD is not the candidate commit, and runs nothing', async () => {
    const sandbox = new FakeCheckSandbox();
    sandbox.revisionValue = { head: 'e'.repeat(40), tree: TREE };
    await drive(sandbox);
    expect(sandbox.failed).toMatch(/^Check checkout differs from the candidate/);
    expect(sandbox.calls).toEqual(['prepare', 'clone', 'revision']);
    expect(sandbox.reported).toBeNull();
    expect(sandbox.destroyed).toBe(true);
  });

  it('fails closed when the tree is not the candidate tree', async () => {
    const sandbox = new FakeCheckSandbox();
    sandbox.revisionValue = { head: COMMIT, tree: 'f'.repeat(40) };
    await drive(sandbox);
    expect(sandbox.failed).toMatch(/^Check checkout differs from the candidate/);
    expect(sandbox.reported).toBeNull();
  });

  it('fails a clone with its error', async () => {
    const sandbox = new FakeCheckSandbox();
    sandbox.cloneExit = 128;
    await drive(sandbox);
    expect(sandbox.failed).toBe('Check sandbox clone failed: fatal: denied');
    expect(sandbox.calls).not.toContain('revision');
    expect(sandbox.destroyed).toBe(true);
  });

  it('captures the static output after the checks and reports a capture failure', async () => {
    const sandbox = new FakeCheckSandbox();
    sandbox.site = {
      captured: false,
      diagnostic: { version: 1, stage: 'index', code: 'MISSING_INDEX', path: 'public/index.html', errno: null },
    };
    await drive(sandbox, check({ static_dir: 'public' }));
    expect(sandbox.calls.slice(-2)).toEqual(['site:public', 'report']);
    expect(sandbox.reported).toMatchObject({
      static_error: 'Static output missing, unsafe or exceeds limits',
      static_export_diagnostic: { code: 'MISSING_INDEX' },
    });
  });

  it('records a failure with a clear reason at the overall cap', async () => {
    const sandbox = new FakeCheckSandbox();
    sandbox.onTick = (s) => {
      if (s.calls.includes('run:math')) s.clock += CHECK_LIMITS.capMs;
    };
    await drive(sandbox);
    expect(sandbox.failed).toBe('The checks did not finish within the 15-minute cap');
    expect(sandbox.reported).toBeNull();
    expect(sandbox.destroyed).toBe(true);
  });

  it('retries a failing sandbox call, then fails the check attempt', async () => {
    const sandbox = new FakeCheckSandbox();
    sandbox.throwOn = 'run:math';
    await drive(sandbox);
    expect(sandbox.calls.filter((c) => c === 'run:math')).toHaveLength(CHECK_LIMITS.maxErrors);
    expect(sandbox.failed).toBe('Check sandbox checks failed: run:math unavailable');
    expect(sandbox.destroyed).toBe(true);
  });

  it('gives the check back to be retried later when no sandbox can start yet', async () => {
    const sandbox = new FakeCheckSandbox();
    sandbox.throwOn = 'prepare';
    sandbox.error = 'Maximum number of running container instances exceeded. Try again later.';
    const state = await drive(sandbox);
    expect(sandbox.deferred).toBe(1);
    expect(sandbox.failed).toBeNull();
    expect(sandbox.calls).toEqual(['prepare', 'defer']);
    expect(state.phase).toBe('done');
    expect(sandbox.destroyed).toBe(true);
  });

  it('fails a start error that is not capacity, and counts a lost deferral as an error', async () => {
    const other = new FakeCheckSandbox();
    other.throwOn = 'prepare';
    await drive(other);
    expect(other.deferred).toBe(0);
    expect(other.failed).toBe('Check sandbox starting failed: prepare unavailable');
    const lost = new FakeCheckSandbox();
    lost.throwOn = 'prepare';
    lost.error = 'there is no container instance that can be provided to this durable object';
    lost.deferFails = true;
    await drive(lost);
    expect(lost.calls.filter((c) => c === 'prepare')).toHaveLength(CHECK_LIMITS.maxErrors);
    expect(lost.failed).toContain('Check sandbox starting failed');
  });

  it('stops once the ledger cancelled or superseded the check attempt', async () => {
    const sandbox = new FakeCheckSandbox();
    sandbox.onTick = (s) => {
      if (s.calls.includes('revision')) s.active = false;
    };
    await drive(sandbox);
    expect(sandbox.calls).not.toContain('run:math');
    expect(sandbox.reported).toBeNull();
    expect(sandbox.destroyed).toBe(true);
  });
});

describe('check command output', () => {
  it('keeps the evaluator fields and marks truncated tails', () => {
    expect(commandOutput('exit 0 5 0', 'hello', '')).toEqual(passed('hello'));
    expect(commandOutput('exit 3 99999999 2', 'tail', 'no')).toEqual({
      exit: 3,
      signal: null,
      stdout: 'tail',
      stderr: 'no',
      stdout_truncated: true,
      stderr_truncated: false,
    });
  });

  it('refuses an unreadable status line', () => {
    expect(() => commandOutput('exit x 0 0', '', '')).toThrow();
    expect(() => commandOutput('exit 0 0', '', '')).toThrow();
    expect(() => commandOutput('timeout 0 0 0', '', '')).toThrow();
    expect(() => commandOutput('', '', '')).toThrow();
  });
});

describe('check sandbox egress', () => {
  const props: OutboundProps = {
    role: 'check',
    project: 'proj',
    owner: 'owner',
    platformRepo: 'r0123456789abcdef0123',
    platformOrigin: 'https://dev.yonedarepo.com',
  };
  const decide = (url: string, method = 'GET') => outboundDecision(new URL(url), method, props);
  const repo = 'https://dev.yonedarepo.com/api/v1/repos/r0123456789abcdef0123';

  it('reads this repository only', () => {
    expect(decide(`${repo}/refs`)).toEqual({ route: 'platform', refs: false });
    expect(decide(`${repo}/commits/${COMMIT}`)).toEqual({ route: 'platform', refs: false });
    // git fetch through yoneda:: reads objects with the batch POST, which writes nothing.
    expect(decide(`${repo}/objects`, 'POST')).toEqual({ route: 'platform', refs: false });
    expect(
      decide('https://dev.yonedarepo.com/api/v1/repos/r9999999999999999999/refs'),
    ).toHaveProperty('deny');
  });

  it('refuses every push, upload and ref move', () => {
    for (const path of ['/commits', '/branches', '/refs/batch', '/land'])
      expect(decide(`${repo}${path}`, 'POST')).toHaveProperty('deny');
    expect(decide(`${repo}/branches/main`, 'DELETE')).toHaveProperty('deny');
    expect(decide(`${repo}/policy`, 'PUT')).toHaveProperty('deny');
  });

  it('has no model endpoint and no other host', () => {
    expect(decide('https://api.z.ai/api/anthropic/v1/messages', 'POST')).toHaveProperty('deny');
    expect(decide('https://registry.npmjs.org/left-pad')).toHaveProperty('deny');
    expect(decide(`${repo.replace('https:', 'http:')}/refs`)).toHaveProperty('deny');
  });
});
