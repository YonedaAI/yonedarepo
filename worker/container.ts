import { Container } from '@cloudflare/containers';
import { now } from './http';
import { ledger } from './storage';
import type { Env, Scope } from './types';
export class ExecutionContainer extends Container<Env> {
  defaultPort = 8080;
  enableInternet = false;
  sleepAfter = '12m';
  async launch(scope: Scope) {
    const existing = await this.ctx.storage.get<Scope>('scope');
    if (existing) return { status: 'already_configured' };
    await this.ctx.storage.put('scope', scope);
    await this.schedule(15, 'watchdog');
    await this.startAndWaitForPorts({
      ports: [8080],
      startOptions: { envVars: { SUPERVISOR_TOKEN: scope.supervisor } },
      cancellationOptions: { portReadyTimeoutMS: 40_000 },
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
  }
  async scope() {
    const scope = await this.ctx.storage.get<Scope>('scope');
    if (!scope) throw new Error('Container has no execution scope');
    return scope;
  }
  async modelCall() {
    const scope = await this.scope();
    if (++scope.model_calls > 24) throw new Error('Model request budget exhausted');
    await this.ctx.storage.put('scope', scope);
    return scope;
  }
  async stop() {
    await this.ctx.storage.put('stopped', true);
    await this.destroy();
  }
  async scheduleStop() {
    await this.schedule(2, 'stop');
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
    } catch {
      await this.stop();
      return;
    }
    if (!(await this.ctx.storage.get('launched'))) {
      if (now() - scope.created_at < 50_000) {
        await this.schedule(15, 'watchdog');
        return;
      }
      await this.stop();
      return;
    }
    await this.schedule(15, 'watchdog');
  }
}
