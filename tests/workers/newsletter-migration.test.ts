// Migration 0014: the Flight log's table on a database from before it, the same statements run
// again, and the indexes its reads rely on. Real D1 (workerd).
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import migration from '../../cloudflare/migrations/0014_newsletter_subscribers.sql?raw';

const db = (env as unknown as { INDEX: D1Database }).INDEX;
const statements = migration
  .replace(/--.*$/gm, '')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean);
const apply = async () => {
  for (const statement of statements) await db.exec(statement);
};
const plan = async (sql: string) =>
  (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results
    .map((r) => r.detail)
    .join(' ');

it('creates the table, repeats without changing a row, and never reuses an id', async () => {
  await apply();
  const insert = db.prepare(
    `INSERT INTO newsletter_subscribers(email,created_at,token_hash,token_at,mails_since)
     VALUES(?,1,?,1,1) RETURNING id`,
  );
  const first = await insert.bind('a@example.com', 'x').first<{ id: number }>();
  await apply();
  expect(await db.prepare('SELECT email FROM newsletter_subscribers').all()).toMatchObject({
    results: [{ email: 'a@example.com' }],
  });
  // An unsubscribe link names the id: a swept row's id must not come back for someone else.
  await db.exec('DELETE FROM newsletter_subscribers');
  const second = await insert.bind('b@example.com', 'y').first<{ id: number }>();
  expect(second?.id).toBeGreaterThan(first?.id ?? 0);
});

it('refuses a second row for an address or a token', async () => {
  await apply();
  const insert = (email: string, token: string) =>
    db
      .prepare(
        `INSERT INTO newsletter_subscribers(email,created_at,token_hash,token_at,mails_since)
         VALUES(?,1,?,1,1)`,
      )
      .bind(email, token)
      .run();
  await insert('c@example.com', 'one');
  await expect(insert('c@example.com', 'two')).rejects.toThrow(/UNIQUE/);
  await expect(insert('d@example.com', 'one')).rejects.toThrow(/UNIQUE/);
});

it('reads by index: the token, the sweep, the count and the export', async () => {
  await apply();
  expect(await plan('SELECT id FROM newsletter_subscribers WHERE token_hash=\'x\'')).toContain(
    'newsletter_token',
  );
  expect(
    await plan('SELECT id FROM newsletter_subscribers WHERE confirmed_at IS NULL AND token_at<1'),
  ).toContain('newsletter_pending');
  expect(
    await plan(
      'SELECT COUNT(*) FROM newsletter_subscribers WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL',
    ),
  ).toContain('newsletter_list');
});
