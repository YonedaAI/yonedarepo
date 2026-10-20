-- Batched landing: changesets landed in one batch share one projected Git commit (batch is
-- the batch's first version, NULL for a commit per version). A changeset can land from
-- its commit shard's record without adoption, so its tree and generation are kept here.
ALTER TABLE changesets ADD COLUMN batch INTEGER;
ALTER TABLE changesets ADD COLUMN tree TEXT;
ALTER TABLE changesets ADD COLUMN generation INTEGER
