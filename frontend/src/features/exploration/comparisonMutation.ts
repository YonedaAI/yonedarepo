import { ApiError, api } from '../../lib/api';
import type { ComparisonAction } from '../../lib/comparison';

/** One explicit owner selection owns one ID/body, including acknowledgement-loss readback. */
export function createComparisonMutation(
  repo: string,
  perform: ComparisonAction,
  read: typeof api = api,
) {
  const id = crypto.randomUUID();
  let body: Record<string, unknown> | undefined;
  let uncertain = false,
    complete = false;
  let pending: Promise<boolean> | undefined;
  async function execute() {
    if (complete) return true;
    if (uncertain) {
      const detail = await read<{ run?: Record<string, any>; runs?: Record<string, any>[] }>(
        `repos/${repo}/run_detail?run_id=${encodeURIComponent(String(body?.run_id))}`,
      );
      const run = detail.run ?? detail.runs?.[0];
      const state = run?.comparison;
      const found =
        state?.selection_request_id === id && state.selected_candidate_id === body?.candidate_id;
      if (!found || run?.id !== body?.run_id)
        throw new Error(
          'This action is unconfirmed. Check the same request again before changing it.',
        );
      complete = true;
      return true;
    }
    try {
      const accepted = await perform('select_comparison_candidate', body ?? {});
      if (!accepted) throw new Error('The action was not confirmed.');
      complete = true;
      return true;
    } catch (error) {
      uncertain =
        uncertain ||
        !(error instanceof ApiError) ||
        ['REQUEST_TIMEOUT', 'REQUEST_FAILED'].includes(error.code);
      if (!uncertain) body = undefined;
      throw error;
    }
  }
  return {
    submit(input: Record<string, unknown>) {
      if (pending) return pending;
      body ??= structuredClone({ ...input, request_id: id });
      pending = execute().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    get uncertain() {
      return uncertain && !complete;
    },
    get requestId() {
      return id;
    },
  };
}
