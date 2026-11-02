-- The GitHub App installation an account connected: which one and on whom, never a token. The
-- adapter asks GitHub again on every use, so this row grants nothing alone. This store is the
-- account's own, so a row needs no account column.
CREATE TABLE account_github_installation(
  installation INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  connected_at INTEGER NOT NULL
);
