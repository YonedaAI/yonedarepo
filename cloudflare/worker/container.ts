import { Container } from '@cloudflare/containers';
import { capacityUnavailable } from './container-capacity';
import { now } from './http';
import { writeLog } from './logging';
import { checkRuntime } from './runtime';
import { ledger } from './storage';
import type { Env, Json, Scope } from './types';
export class ExecutionContainer extends Container<Env> {
  defaultPort = 8080;
  enableInternet = false;
  interceptHttps = true;
  sleepAfter = '12m';
  async launch(scope: Scope) {
    const existing = await this.ctx.storage.get<Scope>('scope');
    if (existing) return { status: 'already_configured' };
    await this.ctx.storage.put('scope', scope);
    await this.schedule(15, 'watchdog');
    let runtimeStarted = false;
    try {
      await ledger(this.env, scope.repo_id, {
        op: 'progress',
        job_id: scope.job.id,
        epoch: scope.job.epoch,
        progress: { stage: 'container_starting' },
      });
      await this.startAndWaitForPorts({
        ports: [8080],
        startOptions: { envVars: { SUPERVISOR_TOKEN: scope.supervisor } },
        cancellationOptions: { portReadyTimeoutMS: 90_000 },
      });
      runtimeStarted = true;
      const health = await this.containerFetch(new Request('http://supervisor/health'));
      let runtime: Json;
      try {
        runtime = await health.json<Json>();
      } catch {
        throw new Error('Previous container image is still serving; wait for rollout completion');
      }
      checkRuntime(runtime, scope.job);
      await ledger(this.env, scope.repo_id, {
        op: 'progress',
        job_id: scope.job.id,
        epoch: scope.job.epoch,
        progress: { stage: 'container_ready', runtime },
      });
      const res = await this.containerFetch(
        new Request('http://supervisor/job', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${scope.supervisor}`,
          },
          body: JSON.stringify(scope.job),
        }),
      );
      if (!res.ok) throw new Error('Container rejected job');
      await this.ctx.storage.put('launched', true);
      return { status: 'started' };
    } catch (error) {
      try {
        await ledger(this.env, scope.repo_id, {
          ...(!runtimeStarted && capacityUnavailable(error)
            ? { op: 'defer_job', reason: 'container_capacity' }
            : {
                op: 'fail',
                retryable: true,
                error: `Container boot failed: ${(error as Error).message}`,
              }),
          job_id: scope.job.id,
          epoch: scope.job.epoch,
        });
      } catch {}
      await this.ctx.storage.put('stop_reason', 'boot_failed');
      await this.stop();
      throw error;
    }
  }
  async scope() {
    const scope = await this.ctx.storage.get<Scope>('scope');
    if (!scope) throw new Error('Container has no execution scope');
    return scope;
  }
  async stop() {
    await this.lifecycle(
      'container.stop_requested',
      (await this.ctx.storage.get<string>('stop_reason')) ?? 'requested',
    );
    await this.ctx.storage.put('stopped', true);
    await this.destroy();
  }
  async scheduleStop() {
    await this.ctx.storage.put('stop_reason', 'completion');
    await this.schedule(2, 'stop');
  }
  override async onStop(params: { exitCode: number; reason: 'exit' | 'runtime_signal' }) {
    await this.lifecycle('container.stopped', params.reason, params.exitCode);
  }
  override async onActivityExpired() {
    await this.ctx.storage.put('stop_reason', 'inactivity');
    await this.stop();
  }
  private async lifecycle(event: string, reason: string, exitCode?: number) {
    const scope = await this.ctx.storage.get<Scope>('scope');
    writeLog(event, {
      repo_id: scope?.repo_id,
      job_id: scope?.job.id,
      epoch: scope?.job.epoch,
      execution_id: scope?.job.payload?.execution?.id,
      run_id: scope?.job.payload?.execution?.run_id,
      stop_reason: reason,
      exit_code: exitCode,
    });
  }
  async watchdog() {
    if (await this.ctx.storage.get('stopped')) return;
    const scope = await this.scope();
    try {
      await ledger(this.env, scope.repo_id, {
        op: 'check_attempt',
        job_id: scope.job.id,
        epoch: scope.job.epoch,
      });
    } catch (failure) {
      if (!['FENCED', 'REPOSITORY_DELETED'].includes((failure as { code?: string }).code ?? '')) {
        await this.schedule(15, 'watchdog');
        return;
      }
      await this.ctx.storage.put('stop_reason', 'lease_invalid');
      await this.stop();
      return;
    }
    // Background supervisor work has no incoming requests to renew SDK activity.
    // Keep it awake only while its authoritative lease and deadline remain valid.
    this.renewActivityTimeout();
    if (!(await this.ctx.storage.get('launched'))) {
      if (now() - scope.created_at < 120_000) {
        await this.schedule(15, 'watchdog');
        return;
      }
      await this.ctx.storage.put('stop_reason', 'launch_timeout');
      await this.stop();
      return;
    }
    await this.schedule(15, 'watchdog');
  }
}
