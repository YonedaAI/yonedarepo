-- Webhooks (B3): per-repository hooks, the repository's event cursor (versions and the
-- refused-ticket watermark fanned out so far), each hook's ordered outbox of payloads and
-- its delivery attempts (the adapter keeps the last 50 per hook).
CREATE TABLE hooks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  paths TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0,
  since_version INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
CREATE TABLE hook_cursor(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  ticket INTEGER NOT NULL
);
CREATE TABLE hook_outbox(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER
);
CREATE INDEX hook_outbox_order ON hook_outbox(hook_id, seq);
CREATE TABLE hook_attempts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_id INTEGER NOT NULL,
  delivery_id TEXT NOT NULL,
  event TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  ms INTEGER NOT NULL,
  error TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX hook_attempts_by_hook ON hook_attempts(hook_id, id);
-- A changeset landed from its commit shard's record keeps the commit's message too, for
-- hook payloads (the commit itself is never adopted into the authority).
ALTER TABLE changesets ADD COLUMN message TEXT
