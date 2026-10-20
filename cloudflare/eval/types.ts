// Bindings of the eval Worker (agent-layer side): model keys from the Secrets Store, the
// platform reached only through its public HTTP API, and the spend authority.
import type { SpendLedger } from './ledger';

export type EvalEnv = {
  /** Bearer secret every request must present (`wrangler secret put EVAL_TOKEN`). */
  EVAL_TOKEN?: string;
  /** Total cap across all arms in micro-USD; the code ceiling is HARD_CAP_MICROUSD. */
  EVAL_SPEND_CAP_MICROUSD?: string;
  ZAI_KEY?: { get(): Promise<string> };
  MIMO_KEY?: { get(): Promise<string> };
  PLATFORM: { fetch(request: Request): Promise<Response> };
  SPEND: DurableObjectNamespace<SpendLedger>;
};
