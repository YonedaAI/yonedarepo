// The tombstone backfill's dry run, live on dev (dev-checks.mjs), and its estimate. It wakes every
// repository object once. There is no way to send `--confirm` from here: erasing the tombstones
// is a separate decision, made on this estimate.
import assert from 'node:assert/strict';
import { backfillEstimate, parseBackfill } from './dev-checks-cost.mjs';

export function backfillSteps(ctx, { delayMs }) {
  return [
    ['B1', 'Dry run of the tombstone backfill, and its estimate', async (m) => {
      const run = await ctx.backfillDryRun(delayMs);
      m.exit_code = run.status;
      assert.equal(run.status, 0, `the dry run failed: ${run.stderr.slice(-300)}`);
      const parsed = parseBackfill(run.stdout);
      assert.ok(parsed.summary, 'the dry run printed its summary');
      m.estimate = backfillEstimate(parsed, { delayMs });
      ctx.evidence('backfill-estimate.json', m.estimate);
      m.tombstones = m.estimate.tombstones;
      m.hours_at_least = Number(m.estimate.hours_at_least.toFixed(2));
    }],
  ];
}
