-- The size of a repository's Git objects (repo_store/capacity.rs): a running total of the
-- packs it stored, the growth of a `.git` folder, kept in the row every command reads so
-- that a push can be refused at the published size without a read of its own. It starts at
-- zero: what a repository held before this migration isn't in it until it is measured.
ALTER TABLE repo_settings ADD COLUMN git_bytes INTEGER NOT NULL DEFAULT 0
