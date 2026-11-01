// Migration 0013: an account index from before it gains the flag, every row reads as not ours,
// and applying it again changes nothing. Real D1 (workerd).
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import internal from '../../cloudflare/migrations/0013_platform_account_internal.sql?raw';

const db = (env as unknown as { INDEX: D1Database }).INDEX;
const statements = (sql: string) =>
  sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
const columns = async () =>
  (await db.prepare('PRAGMA table_info(old_accounts)').all<{ name: string }>()).results.map(
    (c) => c.name,
  );
const upgraded = statements(internal).map((s) => s.replaceAll('platform_accounts', 'old_accounts'));

beforeEach(async () => {
  await db.exec('DROP TABLE IF EXISTS old_accounts');
  await db.exec('CREATE TABLE old_accounts(account TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
  await db.exec("INSERT INTO old_accounts VALUES('before', 1)");
});

it('upgrades the preceding schema: old rows are not ours, and the list uses its index', async () => {
  expect(await columns()).not.toContain('internal');
  for (const statement of upgraded) await db.exec(statement);
  expect(await columns()).toContain('internal');
  const row = await db.prepare("SELECT internal FROM old_accounts WHERE account='before'").first();
  expect(row).toEqual({ internal: 0 });
  const plan = await db
    .prepare('EXPLAIN QUERY PLAN SELECT account FROM old_accounts WHERE internal=1 LIMIT 10')
    .all<{ detail: string }>();
  expect(plan.results.map((r) => r.detail).join(' ')).toContain('old_accounts_internal');
});

it('refuses a second run without touching a row', async () => {
  for (const statement of upgraded) await db.exec(statement);
  // D1's migration table stops this in deployment; the column refuses it anyway.
  await expect(db.exec(upgraded[0])).rejects.toThrow(/duplicate column/i);
  await db.exec(upgraded[1]);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM old_accounts').first()).toEqual({ n: 1 });
});
