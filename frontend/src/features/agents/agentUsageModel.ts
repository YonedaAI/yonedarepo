// Display-only totals of the exact authorized rows already loaded by a Runs page.
import type { ManagedRun, RunStatus } from '../../../../shared/managed-agents';

const number = (value: number) => Number.isFinite(value) && value >= 0;

export function recordedUsage(runs: ManagedRun[]) {
  const totals = {
    calls: 0,
    input: 0,
    output: 0,
    reported: 0,
    seconds: 0,
    timed: 0,
    cost: 0,
    priced: 0,
    outcomes: {} as Partial<Record<RunStatus, number>>,
  };
  for (const run of runs) {
    if (
      number(run.calls) &&
      run.calls > 0 &&
      number(run.input_tokens) &&
      number(run.output_tokens)
    ) {
      totals.calls += run.calls;
      totals.input += run.input_tokens;
      totals.output += run.output_tokens;
      totals.reported++;
    }
    if (number(run.container_seconds) && run.container_seconds > 0) {
      totals.seconds += run.container_seconds;
      totals.timed++;
    }
    if (number(run.cost_usd)) {
      totals.cost += run.cost_usd;
      totals.priced++;
    }
    totals.outcomes[run.status] = (totals.outcomes[run.status] ?? 0) + 1;
  }
  return totals;
}

export const usageCount = (n: number) =>
  new Intl.NumberFormat(
    'en-US',
    n >= 100_000 ? { notation: 'compact', maximumFractionDigits: 1 } : {},
  ).format(n);

export function usageOutcomes(outcomes: Partial<Record<RunStatus, number>>) {
  const n = (status: RunStatus) => outcomes[status] ?? 0;
  return [
    [n('passed'), 'passed'],
    [n('findings'), 'found issues'],
    [n('failed'), 'failed'],
    [n('queued') + n('running') + n('paused'), 'unfinished'],
    [n('superseded') + n('cancelled'), 'stopped'],
  ]
    .filter(([count]) => count)
    .map(([count, label]) => `${count} ${label}`)
    .join(' · ');
}

export function usageTime(seconds: number) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}
