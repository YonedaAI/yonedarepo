-- Who wrote a commit and when (ms), as Git says, apart from `principal`: who pushed or imported
-- it. Empty on a commit recorded before this, until the operators' backfill reads its bytes.
ALTER TABLE commits ADD COLUMN author_name TEXT;
ALTER TABLE commits ADD COLUMN authored_at INTEGER;
CREATE INDEX commits_without_author ON commits(id) WHERE authored_at IS NULL;
