// The revenue rollup under test: its real D1 tables (the migration itself), a ledger with
// ADMIN_BILLING on, and its alarm run by hand. A ledger's env comes from the test config, not
// the harness, so the switch is set on the object.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import migration from '../../cloudflare/migrations/0012_billing_rollup.sql?raw';
import { ledgerStub } from '../../cloudflare/managed/ledger';
import type { Harness } from './fake';

export const index = (env as unknown as { INDEX: D1Database }).INDEX;

export async function rollupTables() {
  for (const statement of migration.replace(/--.*$/gm, '').split(';'))
    if (statement.trim()) await index.exec(statement.replace(/\s+/g, ' ').trim());
}

const object = (h: Harness, account = h.platform.account) =>
  ledgerStub(h.env, account) as unknown as DurableObjectStub;

/** Turns the switch on in this ledger, and optionally overrides its D1. */
export const rollupOn = (h: Harness, overrides: Record<string, unknown> = {}) =>
  runInDurableObject(object(h), (instance: any) => {
    instance.env = { ...instance.env, ADMIN_BILLING: 'on', ...overrides };
  });

/** What the alarm would do, now; false when no alarm was set. */
export const flush = (h: Harness) => runDurableObjectAlarm(object(h));

export const days = async (h: Harness) =>
  (await index.prepare('SELECT * FROM billing_daily WHERE account = ? ORDER BY day').bind(h.platform.account).all<any>()).results;

export const snapshot = (h: Harness) =>
  index.prepare('SELECT * FROM billing_accounts WHERE account = ?').bind(h.platform.account).first<any>();

export const pending = (h: Harness) =>
  runInDurableObject(object(h), (_i, state) => state.storage.sql.exec('SELECT day, mark FROM rollup_dirty').toArray());

/** Takes a ledger back before schema v5 (a fresh object has it already). */
export function undoRollup(sql: SqlStorage) {
  for (const trigger of ['rollup_entry', 'rollup_refund', 'rollup_refund_settled', 'rollup_dispute', 'rollup_dispute_closed'])
    sql.exec(`DROP TRIGGER ${trigger}`);
  sql.exec('DROP INDEX entries_by_at');
  sql.exec('DROP TABLE rollup_dirty');
  sql.exec('DROP TABLE rollup_state');
}
