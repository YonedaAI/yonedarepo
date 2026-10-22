// One Durable Object per sandbox attempt, after Cloudflare's "Build a coding agent runner"
// (developers.cloudflare.com/sandbox/get-started/build-a-coding-agent-runner): the object
// starts a container with Internet access off, routes its traffic through SandboxOutbound,
// clones the repository, runs Claude Code in the background with its output in files, and an
// alarm checks the task until it ends (which also keeps the container running). Differences:
// the clone is `yoneda::` from the platform, the result is a pushed commit instead of a diff,
// and the alarm streams the CLI's stream-json into a bounded activity log.
import { DurableObject } from 'cloudflare:workers';
import { type Activity, completeLines } from './sandbox-activity';
import { recordSandboxCandidate, type SandboxAttempt } from './sandbox-attempt';
import { agentCli } from './sandbox-cli';
import {
  type CommandResult,
  type DriverState,
  initialState,
  type PushResult,
  type SandboxPort,
  step,
  type TaskState,
} from './sandbox-driver';
import type { OutboundProps } from './sandbox-outbound';
import {
  cloneScript,
  eventsPath,
  exitCodePath,
  pidPath,
  pushScript,
  repositoryDirectory,
  stderrPath,
  stopScript,
  taskDirectory,
  taskRunningScript,
  taskScript,
  trustEnv,
} from './sandbox-shell';
import { ledger } from './storage';
import type { Env } from './types';

const inactivityTimeout = 30 * 60 * 1000;
const readChunk = 256 * 1024;
const activityRows = 2000;

export class AgentSandbox extends DurableObject<Env> {
  private readonly container: Container;
  private setup: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (!container) throw new Error('The container binding is not configured');
    this.container = container;
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS activity(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL)',
    );
    if (container.running)
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(inactivityTimeout));
  }

  /** Starts the attempt once; a repeated delivery of the same claim changes nothing. */
  async begin(attempt: SandboxAttempt): Promise<'started' | 'running'> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = this.ctx.storage.kv.get<SandboxAttempt>('attempt');
      if (current?.job_id === attempt.job_id && current.epoch === attempt.epoch) return 'running';
      if (current)
        throw Object.assign(new Error('Sandbox holds another attempt'), { code: 'FENCED' });
      this.ctx.storage.kv.put('attempt', attempt);
      this.ctx.storage.kv.put('state', initialState(Date.now()));
      await this.ctx.storage.setAlarm(Date.now());
      return 'started';
    });
  }

  async alarm(): Promise<void> {
    const attempt = this.ctx.storage.kv.get<SandboxAttempt>('attempt');
    const state = this.ctx.storage.kv.get<DriverState>('state');
    if (!attempt || !state) return;
    const { state: next, next: at } = await step(state, this.port(attempt));
    this.ctx.storage.kv.put('state', next);
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }

  /** The activity log after `after`, oldest first, with the attempt's current phase. */
  async activity(after: number, limit: number) {
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; at: number; kind: string; text: string }>(
        'SELECT seq, at, kind, text FROM activity WHERE seq > ? ORDER BY seq LIMIT ?',
        after,
        limit + 1,
      )
      .toArray();
    const state = this.ctx.storage.kv.get<DriverState>('state');
    const entries = rows.slice(0, limit);
    return {
      entries,
      next: entries.at(-1)?.seq ?? after,
      has_more: rows.length > limit,
      phase: state?.phase ?? null,
      last_activity_at: state?.lastActivityAt ?? null,
    };
  }

  private port(attempt: SandboxAttempt): SandboxPort {
    const call = (command: Record<string, unknown>) =>
      ledger(this.env, attempt.repo, { ...command, job_id: attempt.job_id, epoch: attempt.epoch });
    return {
      now: () => Date.now(),
      attemptActive: async () => {
        const job = await ledger(this.env, attempt.repo, { op: 'job_status', id: attempt.job_id });
        return job.status === 'running' && Number(job.epoch) === attempt.epoch;
      },
      prepare: () => this.ensureSandbox(attempt, true),
      clone: async () => {
        await this.ensureSandbox(attempt, false);
        return this.run(
          [
            '/bin/sh',
            '-c',
            cloneScript,
            'clone',
            attempt.platform_origin,
            attempt.platform_repo,
            attempt.base.commit,
            repositoryDirectory,
          ],
          '/workspace',
          { ...trustEnv, YONEDA_TOKEN: 'provided-by-worker' },
        );
      },
      startAgent: async () => {
        await this.ensureSandbox(attempt, false);
        await this.run(['mkdir', '-p', taskDirectory], '/', {});
        const cli = agentCli(attempt);
        await this.container.exec(
          ['/bin/sh', '-c', taskScript, 'agent', taskDirectory, ...cli.command],
          {
            cwd: repositoryDirectory,
            env: { ...trustEnv, ...cli.env },
            stdout: 'ignore',
            stderr: 'ignore',
          },
        );
      },
      task: () => this.task(attempt),
      readOutput: async (offset) => {
        const output = await this.output([
          '/bin/sh',
          '-c',
          'tail -c +"$(($1 + 1))" "$2" 2>/dev/null | head -c "$3"',
          'read',
          String(offset),
          eventsPath,
          String(readChunk),
        ]);
        const bytes = new Uint8Array(output.stdout);
        return completeLines(bytes, bytes.length >= readChunk);
      },
      stderrTail: async () =>
        new TextDecoder().decode(
          (
            await this.output([
              '/bin/sh',
              '-c',
              'tail -c 2000 "$1" 2>/dev/null',
              'tail',
              stderrPath,
            ])
          ).stdout,
        ),
      stopAgent: async () => {
        await this.run(['/bin/sh', '-c', stopScript, 'stop', pidPath], '/', {});
      },
      commitAndPush: async (message) => this.push(attempt, message),
      record: async (summary) => {
        await recordSandboxCandidate(this.env, attempt, summary);
      },
      fail: async (reason) => {
        await call({ op: 'fail', error: reason.slice(0, 2000), retryable: false });
      },
      progress: async (activity) => {
        await call({ op: 'sandbox_progress', activity });
      },
      appendActivity: async (at, entries) => this.append(at, entries),
      destroy: async () => {
        if (this.container.running) await this.container.destroy();
        this.setup = undefined;
      },
    };
  }

  /** Starts the container (only when `start`) and registers its interception once per object. */
  private async ensureSandbox(attempt: SandboxAttempt, start: boolean): Promise<void> {
    if (!this.container.running && !start)
      throw Object.assign(new Error('The sandbox container stopped'), { code: 'SANDBOX_LOST' });
    if (this.setup === undefined || !this.container.running) {
      this.setup = this.setUpSandbox(attempt).catch((error) => {
        this.setup = undefined;
        throw error;
      });
    }
    await this.setup;
  }

  private async setUpSandbox(attempt: SandboxAttempt): Promise<void> {
    if (!this.container.running)
      this.container.start({
        image: this.container.images.agent,
        instance: 'standard-1',
        enableInternet: false,
      });
    const props: OutboundProps = {
      project: attempt.repo,
      owner: attempt.owner,
      platformRepo: attempt.platform_repo,
      platformOrigin: attempt.platform_origin,
      refPrefix: `refs/heads/${attempt.branch.replace(/[^/]+$/, '')}`,
      provider: attempt.provider,
      connection: attempt.connection,
      model: attempt.model,
      routing: attempt.routing,
      modelBase: attempt.model_base,
    };
    const outbound = (this.ctx.exports as any).SandboxOutbound({ props }) as Fetcher;
    try {
      await this.container.interceptAllOutboundHttp(outbound);
      await this.container.interceptOutboundHttps('*', outbound);
      await this.container.setInactivityTimeout(inactivityTimeout);
    } catch (error) {
      await this.container.destroy();
      throw error;
    }
  }

  private async task(attempt: SandboxAttempt): Promise<TaskState> {
    if (!this.container.running) return { state: 'lost' };
    await this.ensureSandbox(attempt, false);
    const exitCode = await this.readText(exitCodePath);
    if (exitCode !== undefined) return { state: 'exited', exitCode: Number.parseInt(exitCode, 10) };
    if ((await this.readText(pidPath)) === undefined) return { state: 'running' };
    const probe = await this.run(['/bin/sh', '-c', taskRunningScript, 'probe', pidPath], '/', {});
    if (probe.exitCode === 0) return { state: 'running' };
    // The task can finish between the two reads.
    const late = await this.readText(exitCodePath);
    return late !== undefined
      ? { state: 'exited', exitCode: Number.parseInt(late, 10) }
      : { state: 'lost' };
  }

  private async push(attempt: SandboxAttempt, message: string): Promise<PushResult> {
    const result = await this.run(
      [
        '/bin/sh',
        '-c',
        pushScript,
        'push',
        repositoryDirectory,
        attempt.base.commit,
        message,
        attempt.branch,
      ],
      repositoryDirectory,
      { ...trustEnv, YONEDA_TOKEN: 'provided-by-worker' },
    );
    if (result.exitCode !== 0)
      throw new Error(`git push failed: ${result.stderr.trim().slice(-500)}`);
    return result.stdout.trim().endsWith('unchanged')
      ? { pushed: false, reason: 'unchanged' }
      : { pushed: true };
  }

  private append(at: number, entries: Activity[]) {
    for (const entry of entries)
      this.ctx.storage.sql.exec(
        'INSERT INTO activity(at, kind, text) VALUES(?, ?, ?)',
        at,
        entry.kind,
        entry.text,
      );
    this.ctx.storage.sql.exec(
      'DELETE FROM activity WHERE seq <= (SELECT MAX(seq) FROM activity) - ?',
      activityRows,
    );
  }

  private async readText(path: string): Promise<string | undefined> {
    const result = await this.run(['/bin/sh', '-c', 'cat "$1" 2>/dev/null', 'read', path], '/', {});
    return result.exitCode === 0 ? result.stdout : undefined;
  }

  private async output(command: string[]): Promise<ExecOutput> {
    return (await this.container.exec(command, { cwd: '/' })).output();
  }

  private async run(
    command: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<CommandResult> {
    const output = await (await this.container.exec(command, { cwd, env })).output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }
}
