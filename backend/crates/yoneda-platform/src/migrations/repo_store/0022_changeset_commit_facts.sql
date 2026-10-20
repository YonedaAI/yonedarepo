-- A changeset landed from its commit shard's record keeps the commit's parents, writer
-- and recording time, which analytics read without adopting the commit.
ALTER TABLE changesets ADD COLUMN parents TEXT;
ALTER TABLE changesets ADD COLUMN writer TEXT;
ALTER TABLE changesets ADD COLUMN recorded_at INTEGER
