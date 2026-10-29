-- Fetch efficiency of the session's clone: the bytes it fetched from the platform and the
-- bytes of the files its agent read, as the client tallied them (a lazy clone fetches file
-- contents on first use). Nullable: records from before this, and clients that send none.
ALTER TABLE sessions ADD COLUMN fetched_bytes INTEGER;
ALTER TABLE sessions ADD COLUMN read_bytes INTEGER
