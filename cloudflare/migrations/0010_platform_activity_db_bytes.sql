-- A repository's database size in bytes, as the derive job last sampled it (repo-storage.ts);
-- NULL until the first sample. The Durable Object stays the authority: this only feeds the
-- admin pages and the size alerts.
ALTER TABLE platform_activity ADD COLUMN db_bytes INTEGER;
