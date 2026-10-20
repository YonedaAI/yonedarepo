// Forward-only schema for the superfan ledger. Each entry runs once, in order, and its
// number is recorded; never edit an applied entry, append a new one.
export const MIGRATIONS: string[] = [
  `CREATE TABLE findings (
     id INTEGER PRIMARY KEY,
     dedup_key TEXT NOT NULL,
     component TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('anomaly','telemetry')),
     status TEXT NOT NULL CHECK (status IN ('open','resolved')),
     signals TEXT NOT NULL,
     summary TEXT NOT NULL,
     narrative TEXT,
     narrative_status TEXT NOT NULL
       CHECK (narrative_status IN ('pending','written','deterministic','budget_exhausted','model_failed')),
     model TEXT,
     cost_microusd INTEGER NOT NULL DEFAULT 0,
     occurrences INTEGER NOT NULL DEFAULT 1,
     first_seen INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     resolved_at INTEGER
   );
   CREATE UNIQUE INDEX findings_open_key ON findings(dedup_key) WHERE status = 'open';
   CREATE INDEX findings_recent ON findings(last_seen DESC);
   CREATE TABLE baselines (
     key TEXT PRIMARY KEY,
     value REAL NOT NULL,
     samples INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE spend_days (
     day TEXT PRIMARY KEY,
     reserved INTEGER NOT NULL DEFAULT 0,
     settled INTEGER NOT NULL DEFAULT 0,
     calls INTEGER NOT NULL DEFAULT 0,
     refused INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE reservations (
     id TEXT PRIMARY KEY,
     day TEXT NOT NULL,
     amount INTEGER NOT NULL,
     settled INTEGER
   );
   CREATE TABLE runs (
     id INTEGER PRIMARY KEY,
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     outcome TEXT,
     anomalies INTEGER NOT NULL DEFAULT 0,
     model_calls INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE run_lease (
     name TEXT PRIMARY KEY,
     run_id INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );`,
  `CREATE TABLE tail_minutes (
     minute INTEGER NOT NULL,
     component TEXT NOT NULL,
     invocations INTEGER NOT NULL DEFAULT 0,
     errors INTEGER NOT NULL DEFAULT 0,
     exceptions INTEGER NOT NULL DEFAULT 0,
     resource_kills INTEGER NOT NULL DEFAULT 0,
     error_logs INTEGER NOT NULL DEFAULT 0,
     push_retries INTEGER NOT NULL DEFAULT 0,
     hist TEXT NOT NULL,
     PRIMARY KEY (minute, component)
   );
   CREATE TABLE tail_samples (
     id INTEGER PRIMARY KEY,
     minute INTEGER NOT NULL,
     component TEXT NOT NULL,
     name TEXT NOT NULL,
     message TEXT NOT NULL
   );
   CREATE INDEX tail_samples_recent ON tail_samples(component, minute DESC);`,
];

/** Applies pending migrations; safe to call on every Durable Object start. */
export function migrate(sql: SqlStorage) {
  sql.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = sql.exec<{ version: number }>('SELECT version FROM schema_version').toArray()[0];
  let version = row?.version ?? 0;
  if (!row) sql.exec('INSERT INTO schema_version (version) VALUES (0)');
  for (; version < MIGRATIONS.length; version++) {
    sql.exec(MIGRATIONS[version]);
    sql.exec('UPDATE schema_version SET version = ?', version + 1);
  }
  return version;
}
