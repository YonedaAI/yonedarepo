// Forward-only schemas of the managed Worker's Durable Objects and their runner. Each entry
// of a list runs once, in order, and its number is recorded; never edit an applied entry,
// append one.

/** RepoAgents: the platform connection, agent switches and runs. */
export const REPO_SCHEMA: string[] = [
  `CREATE TABLE connection (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     repo TEXT NOT NULL,
     account TEXT NOT NULL,
     token_name TEXT NOT NULL,
     token_sealed TEXT NOT NULL,
     hook_id INTEGER NOT NULL,
     hook_secret_sealed TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE agents (
     agent TEXT PRIMARY KEY,
     enabled INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL
   );
   CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     agent TEXT NOT NULL,
     change INTEGER NOT NULL,
     head TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN
       ('queued','running','passed','findings','paused','superseded','cancelled','failed')),
     attempt INTEGER NOT NULL DEFAULT 1,
     value TEXT,
     harness TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     fallback TEXT,
     container_seconds INTEGER NOT NULL DEFAULT 0,
     calls INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     charged_microusd INTEGER NOT NULL DEFAULT 0,
     findings INTEGER NOT NULL DEFAULT 0,
     withheld INTEGER NOT NULL DEFAULT 0,
     findings_json TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     finished_at INTEGER,
     UNIQUE (agent, change, head)
   );
   CREATE INDEX runs_recent ON runs(created_at DESC);`,
  // v2 (2026-10-30): the agent's summary, as posted, for the run's detail page.
  `ALTER TABLE runs ADD COLUMN summary TEXT;`,
  // v3 (2026-10-30): a connection whose token was revoked when its last agent was disabled,
  // kept (with a repo-only hook) so the repository's deletion still clears its reviews.
  `ALTER TABLE connection ADD COLUMN revoked_at INTEGER;`,
];

/** CreditLedger: append-only credit entries and runs waiting for credit. */
export const LEDGER_SCHEMA: string[] = [
  `CREATE TABLE entries (
     id INTEGER PRIMARY KEY,
     key TEXT NOT NULL UNIQUE,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('grant','hold','release','charge')),
     amount INTEGER NOT NULL,
     repo TEXT, run TEXT, agent TEXT, model TEXT,
     input_tokens INTEGER, output_tokens INTEGER, cost_microusd INTEGER,
     note TEXT
   );
   CREATE TABLE paused (
     repo TEXT NOT NULL,
     run TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (repo, run)
   );`,
  // v2 (2026-10-30): card billing. One row of the workspace's Stripe customer and saved card
  // (payment method id, brand and last four only), and the automatic top-ups charged to it.
  `CREATE TABLE billing (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     customer TEXT,
     payment_method TEXT,
     brand TEXT,
     last4 TEXT,
     card_added_at INTEGER,
     top_up_failed TEXT
   );
   CREATE TABLE top_ups (
     key TEXT PRIMARY KEY,
     amount INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
     payment_intent TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     settled_at INTEGER
   );`,
  // v3 (2026-10-30): automatic top-up can be switched off without removing the card; on for
  // every card saved before the switch existed.
  `ALTER TABLE billing ADD COLUMN auto_top_up INTEGER NOT NULL DEFAULT 1;`,
  // v4 (2026-10-31): operators' billing. An operator's pause on charging the card; refunds (an
  // operator's, recorded before Stripe is asked, and those Stripe reported), with what Stripe
  // says is refunded per top-up; disputes; and each day's refunds on the instance that counts
  // them (admin-refund.ts). entries.kind cannot change without rebuilding the table, so what
  // takes credit back is a negative 'grant' keyed refund:, freeze: and so on (ledger-refunds.ts).
  `ALTER TABLE billing ADD COLUMN paused_at INTEGER;
   ALTER TABLE billing ADD COLUMN paused_reason TEXT;
   ALTER TABLE billing ADD COLUMN paused_by TEXT;
   ALTER TABLE top_ups ADD COLUMN stripe_refunded INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE refunds (
     id TEXT PRIMARY KEY,
     account TEXT NOT NULL,
     top_up TEXT NOT NULL,
     amount INTEGER NOT NULL CHECK (amount > 0),
     status TEXT NOT NULL CHECK (status IN ('open','succeeded','failed')),
     origin TEXT NOT NULL CHECK (origin IN ('operator','stripe')),
     actor TEXT NOT NULL,
     reason TEXT NOT NULL,
     spent_override INTEGER NOT NULL DEFAULT 0,
     stripe_refund TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     settled_at INTEGER
   );
   CREATE INDEX refunds_by_top_up ON refunds(top_up);
   CREATE TABLE disputes (
     id TEXT PRIMARY KEY,
     top_up TEXT,
     charge TEXT NOT NULL,
     amount INTEGER NOT NULL,
     frozen INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL,
     reason TEXT,
     opened_at INTEGER NOT NULL,
     closed_at INTEGER
   );
   CREATE TABLE refund_days (
     id TEXT PRIMARY KEY,
     day TEXT NOT NULL,
     amount INTEGER NOT NULL
   );
   CREATE INDEX refund_days_by_day ON refund_days(day);`,
];

/** WorkspaceAgents: per-agent overrides (workspace-wide or per repository) and where it runs. */
export const WORKSPACE_SCHEMA: string[] = [
  `CREATE TABLE settings (
     agent TEXT NOT NULL,
     scope TEXT NOT NULL,
     overrides TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL,
     PRIMARY KEY (agent, scope)
   );
   CREATE TABLE enabled (
     agent TEXT NOT NULL,
     repo TEXT NOT NULL,
     PRIMARY KEY (agent, repo)
   );`,
  // v2 (2026-10-30): an agent's set-up (Add agent): who and when, whether it is paused, and
  // whether it runs on all the workspace's repositories, new ones included.
  `CREATE TABLE agent_meta (
     agent TEXT PRIMARY KEY,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     active INTEGER NOT NULL DEFAULT 1,
     all_repos INTEGER NOT NULL DEFAULT 0
   );`,
];

/** Applies pending migrations; safe to call on every Durable Object start. */
export function migrate(sql: SqlStorage, migrations: readonly string[]) {
  sql.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = sql.exec<{ version: number }>('SELECT version FROM schema_version').toArray()[0];
  let version = row?.version ?? 0;
  if (!row) sql.exec('INSERT INTO schema_version (version) VALUES (0)');
  for (; version < migrations.length; version++) {
    sql.exec(migrations[version]);
    sql.exec('UPDATE schema_version SET version = ?', version + 1);
  }
  return version;
}
