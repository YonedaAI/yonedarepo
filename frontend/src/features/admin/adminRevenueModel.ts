// The revenue view's model: its range, its path and how a figure nobody recorded reads. The
// numbers are the server's.
import { money } from './adminBillingModel';
import { withQuery } from './adminModel';

export type RevenueRange = { from: string; to: string; by: 'day' | 'month' };

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
/** As the server's limit: a longer range goes by month. */
const MAX_DAYS = 366;

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

export const defaultRange = (now = Date.now()): RevenueRange => ({
  from: utcDay(now - (DEFAULT_DAYS - 1) * DAY_MS),
  to: utcDay(now),
  by: 'day',
});

export const revenuePath = ({ from, to, by }: RevenueRange) =>
  withQuery('/admin/revenue', { from, to, by });

/** Why a range would be refused; null when it can be read. */
export function rangeProblem({ from, to, by }: RevenueRange) {
  if (!from || !to) return 'Pick both dates.';
  if (from > to) return 'From is after to.';
  const days = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (by === 'day' && days >= MAX_DAYS)
    return `By day covers up to ${MAX_DAYS} days: use by month.`;
  return null;
}

/** A figure, or what stands in for one nobody recorded. Zero is a figure. */
export const recorded = (usd: number | null) => (usd === null ? 'not recorded' : money(usd));
