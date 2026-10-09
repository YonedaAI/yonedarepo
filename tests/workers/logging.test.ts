import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { attemptLog, writeLog } from '../../cloudflare/worker/logging';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Scope } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
it('logs only allowlisted lifecycle observations, without raw payloads or errors', () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => {});
  const safe = writeLog('container.stopped', { job_id: 'known-job', epoch: 2, exit_code: 143, stop_reason: 'runtime_signal', payload: { token: 'private-token' }, error: 'private-error' } as any);
  expect(safe).toMatchObject({ job_id: 'known-job', exit_code: 143, stop_reason: 'runtime_signal' });
  expect(JSON.stringify(output.mock.calls)).not.toContain('private-');
  expect(writeLog('container.stopped', { stop_reason: 'private-secret' })).not.toHaveProperty('stop_reason');
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
async function fixture(): Promise<Scope> {
  const repo = 'logging-fixture';
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Logging', commit: 'a'.repeat(40),
    remote: { namespace: 'test', name: repo }, policy: { version: 'v1', suite: 'retry-contract-v1',
      environment: 'rust-1.94-evaluator-v1', required_checks: ['build', 'behavior'] } });
  await ledger(bindings, repo, { op: 'start_run', id: 'logged-run', intent: 'Offline logging fixture' });
  const job = await ledger(bindings, repo, { op: 'claim', job_id: 'job:logged-run:research' });
  return { repo_id: repo, job, supervisor: 'private-supervisor', model_calls: 0, created_at: Date.now() };
}

it('stores safe correlated diagnostics in real DO SQLite, survives eviction and enforces owner scope', async () => {
  const scope = await fixture();
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await attemptLog(bindings, scope, 'model.rejected', {
    error_code: 'PROVIDER_CONFIGURATION', duration_ms: 5,
    headers: { authorization: 'private-key' }, message: 'private-prompt',
  } as any);
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(scope.repo_id)));
  const path = `https://yoneda/api/repos/${scope.repo_id}/execution_logs?execution_id=logged-run:research`;
  const result = await bindings.SELF.fetch(path, { headers: { authorization: 'Bearer local-test-owner' } });
  expect(result.status).toBe(200);
  const logs = await result.json() as { entries: { data: Record<string,unknown> }[] };
  expect(logs.entries).toHaveLength(1);
  expect(logs.entries[0].data).toMatchObject({ job_id: scope.job.id, epoch: scope.job.epoch,
    execution_id: 'logged-run:research', error_code: 'PROVIDER_CONFIGURATION' });
  expect(JSON.stringify([logs, output.mock.calls])).not.toContain('private-');
  expect((await bindings.SELF.fetch(path)).status).toBe(401);
  const signup = await bindings.SELF.fetch('https://yoneda/api/auth/signup', { method: 'POST',
    body: JSON.stringify({ username: 'other_logger', password: 'a long test password' }) });
  const cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0];
  expect((await bindings.SELF.fetch(path, { headers: { cookie } })).status).toBe(403);
});

it('logging storage failure never turns successful model transport into an exception', async () => {
  const scope = await fixture();
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const unavailable = { ...bindings, REPOSITORIES: { idFromName() { throw new Error('private-key'); } } } as unknown as Env;
  await expect(attemptLog(unavailable, scope, 'model.response_headers', { http_status: 200 })).resolves.toBeUndefined();
  expect(output).toHaveBeenCalledWith(expect.objectContaining({ event: 'logs.persist_failed' }));
  expect(JSON.stringify(output.mock.calls)).not.toContain('private-key');
});
