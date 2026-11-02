-- As repo_store's 0048: a shard's commits reach the authority with who wrote them.
ALTER TABLE commits ADD COLUMN author_name TEXT;
ALTER TABLE commits ADD COLUMN authored_at INTEGER;
