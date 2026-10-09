import { ledger } from './storage';
import type { Env, Scope } from './types';

export type LogStage =
  | 'model.request_started'
  | 'model.response_headers'
  | 'model.rejected'
  | 'model.transport_failed'
  | 'execution.started'
  | 'execution.completion_received'
  | 'execution.failure_received';
type Fields = {
  exit_code?: number;
  stop_reason?: string;
  http_status?: number;
  duration_ms?: number;
  request_number?: number;
  error_code?: string;
};
const codes = new Set([
  'PROVIDER_CONFIGURATION',
  'PROVIDER_CHANGED',
  'PROVIDER_MISSING',
  'PROVIDER_AUTH',
  'PROVIDER_BALANCE',
  'PROVIDER_FORBIDDEN',
  'PROVIDER_MODEL',
  'PROVIDER_REQUEST',
  'PROVIDER_REQUEST_LIMIT',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TRANSPORT',
  'MODEL_REQUEST_LIMIT',
  'MODEL_SPEND_LIMIT',
  'BUDGET_LIMIT',
  'RESOURCE_LIMIT',
  'FENCED',
  'RUNTIME',
  'EXECUTION_TIMEOUT',
  'REPOSITORY_DELETED',
  'MODEL_PROXY',
  'UNKNOWN',
  'SETUP_FAILED',
  'SETUP_TIMEOUT',
  'EMPTY_REPOSITORY',
  'NOT_FOUND',
  'INVALID_URL',
  'REMOTE_AUTH_REQUIRED',
  'UPSTREAM_UNAVAILABLE',
  'MEMORY_LIMIT',
]);
export function failureCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && codes.has(code) ? code : 'UNKNOWN';
}
export function providerStatusCode(status: number): string | undefined {
  return (
    (
      {
        400: 'PROVIDER_REQUEST',
        401: 'PROVIDER_AUTH',
        402: 'PROVIDER_BALANCE',
        403: 'PROVIDER_FORBIDDEN',
        404: 'PROVIDER_MODEL',
        413: 'PROVIDER_REQUEST_LIMIT',
        422: 'PROVIDER_REQUEST',
        429: 'PROVIDER_RATE_LIMIT',
      } as Record<number, string>
    )[status] ?? (status >= 500 ? 'PROVIDER_UNAVAILABLE' : undefined)
  );
}
// Construct fields explicitly; never spread a Request, Error, job payload or provider response.
export function writeLog(
  event: string,
  fields: Fields & {
    repo_id?: string;
    job_id?: string;
    execution_id?: string;
    run_id?: string;
    epoch?: number;
    provider?: string;
    model?: string;
    billing_source?: string;
    region?: string;
    stage?: string;
  } = {},
) {
  const record: Record<string, string | number> = { service: 'yonedarepo', event };
  for (const key of [
    'repo_id',
    'job_id',
    'execution_id',
    'run_id',
    'provider',
    'model',
    'billing_source',
    'region',
    'stage',
  ] as const) {
    const value = fields[key];
    if (typeof value === 'string') record[key] = value.slice(0, 256);
  }
  for (const key of [
    'http_status',
    'duration_ms',
    'request_number',
    'epoch',
    'exit_code',
  ] as const) {
    const value = fields[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) record[key] = value;
  }
  if (
    fields.stop_reason &&
    [
      'exit',
      'runtime_signal',
      'inactivity',
      'completion',
      'requested',
      'boot_failed',
      'lease_invalid',
      'launch_timeout',
    ].includes(fields.stop_reason)
  )
    record.stop_reason = fields.stop_reason;
  if (fields.error_code) record.error_code = failureCode({ code: fields.error_code });
  if (record.error_code || Number(record.http_status) >= 400) console.warn(record);
  else console.info(record);
  return record;
}

export async function attemptLog(env: Env, scope: Scope, stage: LogStage, fields: Fields = {}) {
  const execution = scope.job.payload?.execution;
  const safe = writeLog(stage, {
    repo_id: scope.repo_id,
    job_id: scope.job.id,
    epoch: scope.job.epoch,
    execution_id: execution?.id,
    run_id: execution?.run_id,
    provider: execution?.provider ?? execution?.harness,
    model: scope.job.model ?? execution?.model,
    billing_source:
      execution?.routing?.plan ?? (execution?.provider === 'zai' ? 'coding_plan' : 'api_credits'),
    region: execution?.routing?.region,
    http_status: fields.http_status,
    duration_ms: fields.duration_ms,
    request_number: fields.request_number,
    error_code: fields.error_code,
  });
  if (scope.job.kind !== 'agent') return;
  try {
    await ledger(env, scope.repo_id, {
      op: 'record_execution_log',
      job_id: scope.job.id,
      epoch: scope.job.epoch,
      event_id: crypto.randomUUID(),
      stage,
      ...Object.fromEntries(
        ['http_status', 'duration_ms', 'request_number', 'error_code']
          .filter((key) => safe[key] !== undefined)
          .map((key) => [key, safe[key]]),
      ),
    });
  } catch {
    // Logging outages cannot turn successful inference into a failed execution.
    writeLog('logs.persist_failed', {
      repo_id: scope.repo_id,
      job_id: scope.job.id,
      error_code: 'UNKNOWN',
    });
  }
}
