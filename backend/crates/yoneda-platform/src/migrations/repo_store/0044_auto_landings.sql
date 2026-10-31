-- Landings for every push (repo_store/auto_landing.rs). `changes.origin` is `explicit`,
-- opened on purpose, or `auto`, opened by a push and not yet claimed: `git_change_create`
-- on an auto row adopts it (change_adopt.rs). Two switches per repository, both off:
-- create Landings automatically, and run agents on them. They are columns and not
-- `policy`, whose digest every recorded check is bound to. A closed or landed row stays,
-- so a branch can hold several, and `changes_by_branch` finds its newest.
ALTER TABLE changes ADD COLUMN origin TEXT NOT NULL DEFAULT 'explicit'
  CHECK (origin IN ('explicit', 'auto'));
ALTER TABLE repo_settings ADD COLUMN auto_landings INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repo_settings ADD COLUMN auto_landing_agents INTEGER NOT NULL DEFAULT 0;
CREATE INDEX changes_by_branch ON changes(branch, number)
