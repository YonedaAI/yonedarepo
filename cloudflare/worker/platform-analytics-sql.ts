// Reads Analytics Engine back through its SQL API, with an Account Analytics Read token, for the
// admin reports and the repository Insights page. All that ends up in a statement comes from code
// or from a value checked here.
import type { Env } from './types';

// Interpolated into SQL as the table name: only an ordinary identifier is accepted.
const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;

export type SqlRow = Record<string, unknown>;
export type SqlReader = { dataset: string; run: (sql: string) => Promise<SqlRow[]> };

/** The dataset and a way to read it, or null when any of it is unset here. */
export function sqlReader(env: Env, fetcher: typeof fetch = fetch): SqlReader | null {
  const account = env.CF_ACCOUNT_ID ?? '';
  const dataset = env.SITE_EVENTS_DATASET ?? '';
  const token = env.ANALYTICS_READ_TOKEN ?? '';
  if (!ACCOUNT.test(account) || !DATASET.test(dataset) || !token) return null;
  const run = async (sql: string): Promise<SqlRow[]> => {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: sql },
    );
    if (!response.ok) throw new Error(`Analytics Engine SQL API answered ${response.status}`);
    const data = ((await response.json()) as { data?: unknown }).data;
    if (!Array.isArray(data)) throw new Error('Analytics Engine SQL API answered without data');
    return data as SqlRow[];
  };
  return { dataset, run };
}

// Analytics Engine answers 64-bit sums as strings (ClickHouse JSON), smaller ones as numbers.
export const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
export const text = (value: unknown) => (typeof value === 'string' ? value : '');
