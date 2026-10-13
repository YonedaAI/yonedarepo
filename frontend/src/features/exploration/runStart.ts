import { ApiError, api } from '../../lib/api';

type Send = (path: string, body?: unknown) => Promise<unknown>;
/** One draft owns one immutable request. An ambiguous response is read back before retrying. */
export function createRunStart(repoId: string, send: Send = api) {
  const id = `run-${crypto.randomUUID()}`;
  let request: Record<string, unknown> | undefined;
  let uncertain = false;
  let pending: Promise<string> | undefined;
  let complete = false;
  async function execute() {
    if (complete) return id;
    if (uncertain) {
      try {
        const result = await send(`repos/${repoId}/run_detail?run_id=${encodeURIComponent(id)}`);
        const run = (result as { run?: { id?: string } } | null)?.run;
        if (run?.id !== id)
          throw new Error('Run readback was incomplete. Refresh before retrying.');
        complete = true;
        return id;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'NOT_FOUND') throw error;
      }
    }
    try {
      await send(`repos/${repoId}/start_run`, request);
      complete = true;
      return id;
    } catch (error) {
      // A retry rejection cannot resolve an earlier ambiguous start: it may have committed
      // after NOT_FOUND. Preserve the frozen brief until readback confirms this run ID.
      uncertain =
        uncertain ||
        !(error instanceof ApiError) ||
        ['REQUEST_TIMEOUT', 'REQUEST_FAILED', 'ALREADY_EXISTS'].includes(error.code);
      if (!uncertain) request = undefined;
      throw error;
    }
  }
  return {
    start(brief: Record<string, unknown>): Promise<string> {
      if (pending) return pending;
      request ??= structuredClone({ ...brief, id });
      pending = execute().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    get uncertain() {
      return uncertain && !complete;
    },
  };
}
