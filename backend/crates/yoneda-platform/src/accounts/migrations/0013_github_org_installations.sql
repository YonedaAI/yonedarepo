-- GitHub installations on organizations. An account now holds its own installation and any
-- number of organizations': each row says which kind it is, and an organization's also says which
-- organization (GitHub's id, as logins change) and which GitHub user proved they own it.
ALTER TABLE account_github_installation ADD COLUMN target_type TEXT NOT NULL DEFAULT 'User'
  CHECK (target_type IN ('User','Organization'));
ALTER TABLE account_github_installation ADD COLUMN target_id INTEGER;
ALTER TABLE account_github_installation ADD COLUMN connected_by TEXT;
-- What the OAuth round proving an owner carries: the platform read the installation, and the
-- sign-in Worker, which can't, finishes the job from this. A hash, once, for ten minutes.
CREATE TABLE account_github_org_tickets(
  ticket_hash TEXT PRIMARY KEY,
  installation INTEGER NOT NULL,
  login TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- That round is an OAuth attempt of its own kind, so the attempts' table takes a new intent.
CREATE TABLE oauth_flows_next(
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('signin','link','github_org')),
  account TEXT,
  session_hash TEXT,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
INSERT INTO oauth_flows_next SELECT * FROM oauth_flows;
DROP TABLE oauth_flows;
ALTER TABLE oauth_flows_next RENAME TO oauth_flows;
