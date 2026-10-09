import type { ContextUsage } from '../../../../shared/context_usage';
import { validContextUsage } from './contextUsageValidation';

export function contextUsagePath(
  repo: string,
  run: string,
  execution: string,
  epoch: string,
  cursor: number,
) {
  if (epoch && (!Number.isSafeInteger(Number(epoch)) || Number(epoch) < 1)) return null;
  const query = new URLSearchParams({ run_id: run, cursor: String(cursor), limit: '30' });
  if (execution) query.set('execution_id', execution);
  if (epoch) query.set('epoch', String(Number(epoch)));
  return `repos/${encodeURIComponent(repo)}/context_usage?${query}`;
}

export function contextUsageMetric(data: ContextUsage, key: keyof ContextUsage['counts']) {
  const reads = ['returned', 'opened', 'read_calls'].includes(key);
  const incomplete = reads && data.coverage.status !== 'recorded';
  return {
    value: incomplete && data.counts[key] === 0 ? '—' : String(data.counts[key]),
    note: incomplete
      ? 'recorded · incomplete tracking'
      : reads
        ? 'recorded access'
        : 'recorded lineage',
  };
}

export function isContextUsage(value: unknown, run: string): value is ContextUsage {
  return validContextUsage(value) && value.run_id === run;
}
