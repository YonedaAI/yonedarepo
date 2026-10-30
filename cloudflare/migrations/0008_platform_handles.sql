-- Handles of accounts named by an email address (the handle each picked), for listings and
-- profile pages: a rebuildable projection of each account's authority (its `handle`
-- record). Every other owner's handle is its name. Repository names are looked up per
-- owner ignoring case, as owners hold them (accounts/repo_names.rs), when an owner's
-- authority has no record of a repository made before it held names.
CREATE TABLE IF NOT EXISTS platform_handles(
  workspace TEXT PRIMARY KEY,
  handle TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_handles_by_handle ON platform_handles(handle);
CREATE INDEX IF NOT EXISTS platform_repos_by_name ON platform_repos(workspace, name COLLATE NOCASE);
