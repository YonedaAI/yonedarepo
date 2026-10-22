-- Deleted repositories stay as tombstones: every operation answers GONE once this is set.
ALTER TABLE repo_settings ADD COLUMN deleted_at INTEGER;
