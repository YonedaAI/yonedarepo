-- Handles and repository names (accounts/handles.rs, accounts/repo_names.rs). A handle an
-- email-named account picks is held on that handle's own instance (record handle_alias)
-- and kept by the account (record handle). An owner's authority holds its repositories'
-- names, unique ignoring case (name_key: the name lowercased), and a renamed repository's
-- earlier names stay (current=0) and resolve to it until another repository takes them.
CREATE TABLE repo_names(
  name_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo TEXT NOT NULL,
  current INTEGER NOT NULL CHECK (current IN (0, 1)),
  at INTEGER NOT NULL
);
CREATE INDEX repo_names_by_repo ON repo_names(repo, current)
