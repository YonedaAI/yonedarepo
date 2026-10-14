import type { Json, Scope } from './types';

export type SourceInvalidation = { alias: string; paths: string[]; job_id: string; epoch: number };
export type SourceInvalidationReceipt = {
  invalidated: true;
  alias: string;
  job_id: string;
  epoch: number;
};
const denied = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'SOURCE_SCOPE' });
};

/** Trusted execution RPC validates its stored scope again before contacting the root supervisor. */
export async function invalidateSourceSession(
  scope: Scope,
  input: SourceInvalidation,
  checkAttempt: () => Promise<unknown>,
  send: (input: SourceInvalidation) => Promise<Json>,
): Promise<SourceInvalidationReceipt> {
  if (
    !input ||
    Object.keys(input).some((key) => !['alias', 'paths', 'job_id', 'epoch'].includes(key)) ||
    input.job_id !== scope.job.id ||
    input.epoch !== scope.job.epoch ||
    scope.job.payload?.workspace_transport !== 'api-source-v1' ||
    !['repo', 'candidate-0', 'candidate-1'].includes(input.alias) ||
    !scope.job.source_mounts?.some((mount: Json) => mount.path === input.alias) ||
    !Array.isArray(input.paths) ||
    input.paths.length === 0 ||
    input.paths.length > 256 ||
    input.paths.some(
      (path) =>
        typeof path !== 'string' ||
        !path ||
        new TextEncoder().encode(path).length > 512 ||
        /[\\\0]/.test(path) ||
        path.split('/').some((part) => !part || ['.', '..', '.git'].includes(part.toLowerCase())),
    )
  )
    denied('Source invalidation does not match the active mount');
  await checkAttempt();
  const result = await send(input);
  if (
    result.invalidated !== true ||
    result.alias !== input.alias ||
    result.job_id !== input.job_id ||
    result.epoch !== input.epoch
  )
    denied('Source invalidation acknowledgement differs');
  return { invalidated: true, alias: input.alias, job_id: input.job_id, epoch: input.epoch };
}
