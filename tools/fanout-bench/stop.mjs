// The stop rules of docs/load-testing.md: stop at the first of errors above 1%, p95 over 3x its
// target, or a Cloudflare limit error. Targets are the doc's request budget; sustained load has
// none of its own, so it takes the 3 s of busy repositories (`--target-p95-ms` overrides it).
export const TARGETS = { many_repos_ms: 3000, sustained_ms: 3000 };
export const STOP = { errors: 0.01, p95_factor: 3 };

// Limit errors as Cloudflare words them, in an answer's code or message or in a bench client
// failure: Workers (1015 rate limited, 1102 resources, 1200 queue), Durable Objects, D1, R2.
const LIMIT =
  /too many subrequests|too many requests queued|exceeded (cpu|memory|resource|allowed|the maximum database size)|exceeded its (cpu|memory)|resource limits|overloaded|storage operation exceeded timeout|error code: (1015|1102|1200)\b|\(10058\)/i;
const D1 = /\bD1(_ERROR|_TYPE_ERROR)?\b/;

export const isLimitError = (text) => LIMIT.test(String(text ?? ''));
const text = (r) => [r?.error, r?.message, r?.client_error].filter(Boolean).join(' ');

/** Failed records that name a Cloudflare limit. */
export const limitErrors = (rows) => rows.filter((r) => r && isLimitError(text(r)));
/** Failed records that name D1: Cloudflare publishes no D1 error count (docs/load-testing.md). */
export const d1Errors = (rows) => rows.filter((r) => r && D1.test(text(r)));
/** A conflict the platform answered as one: the budget's only allowed refusal. */
export const expectedConflict = (r) => r?.status === 409 && r.error === 'CONFLICT';

/** Which rules a window trips: `errors` of `total` failed, `p95_ms` against `target_ms` (null
 * means nothing landed, which trips it), `limits` Cloudflare limit errors seen. */
export function stopReasons({ total, errors, p95_ms, target_ms, limits = 0 }) {
  return [
    total > 0 && errors / total > STOP.errors && 'errors',
    total > 0 && (p95_ms ?? Infinity) > STOP.p95_factor * target_ms && 'p95',
    limits > 0 && 'limit',
  ].filter(Boolean);
}
