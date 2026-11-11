import type { OperationRow } from '../../../../shared/operation-metrics';

export const OPERATION_SOURCE: Record<string, string> = {
  web: 'Website',
  rest: 'API',
  mcp: 'MCP',
  git_https: 'Git HTTPS',
  git_ssh: 'Git SSH',
  queue: 'Queue',
  cron: 'Scheduled',
  workflow: 'Workflow',
  alarm: 'Alarm',
  monitor: 'Health check',
  unknown: 'Unknown',
};
export const OPERATION_KIND: Record<string, string> = {
  request: 'Requests',
  repository: 'Repository commands',
  background: 'Background work',
  browser: 'Browser reports',
  transfer: 'Git transfers',
};
export const OPERATION_TRAFFIC: Record<string, string> = {
  ordinary: 'Unclassified',
  marked_automation: 'Our tools',
  crawler_claimed: 'Crawler claim',
  agent_claimed: 'Agent claim',
  automation_claimed: 'Automation claim',
  health: 'Health check',
  scanner: 'Scanner',
  telemetry: 'Telemetry',
  unknown: 'Unknown',
};
export const TIMING_LABELS = { p50: 'Median', p95: '95% under', p99: '99% under' };
export const TIMING_HELP: Record<string, string> = {
  Median: 'Half of the measured operations finished within this time.',
  '95% under': '95% of the measured operations finished within this time.',
  '99% under': '99% of the measured operations finished within this time.',
  'Queue 95% under': '95% of measured queue waits were within this time.',
};
export const OPERATION_COLUMNS = [
  { key: 'operation', label: 'Operation', number: false },
  { key: 'source', label: 'Trigger', number: false },
  { key: 'traffic', label: 'Traffic', number: false },
  { key: 'outcome', label: 'Result', number: false },
  { key: 'requests', label: 'Count', number: true },
  { key: 'p50', label: TIMING_LABELS.p50, number: true },
  { key: 'p95', label: TIMING_LABELS.p95, number: true },
  { key: 'p99', label: TIMING_LABELS.p99, number: true },
  { key: 'queueWaitP95', label: 'Queue 95% under', number: true },
] as const;
export type OperationSortKey = (typeof OPERATION_COLUMNS)[number]['key'];
export type OperationSort = { key: OperationSortKey; direction: 'asc' | 'desc' };

export function nextOperationSort(order: OperationSort, key: OperationSortKey): OperationSort {
  return {
    key,
    direction:
      order.key === key
        ? order.direction === 'asc'
          ? 'desc'
          : 'asc'
        : OPERATION_COLUMNS.find((c) => c.key === key)?.number
          ? 'desc'
          : 'asc',
  };
}
function value(row: OperationRow, key: OperationSortKey): string | number | null {
  if (key === 'source') return OPERATION_SOURCE[row.source];
  if (key === 'traffic') return OPERATION_TRAFFIC[row.traffic];
  const v = row[key];
  return typeof v === 'number' && !Number.isFinite(v) ? null : v;
}
/** Sort the displayed groups, retaining separate services/releases and unknown values. */
export function sortOperationRows(rows: OperationRow[], order: OperationSort) {
  return [...rows].sort((a, b) => {
    const av = value(a, order.key),
      bv = value(b, order.key);
    if (av == null) return bv == null ? 0 : 1;
    if (bv == null) return -1;
    const compared =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    return order.direction === 'asc' ? compared : -compared;
  });
}
