-- Lookup of personal access tokens by secret digest: which account's WorkspaceAuthority
-- holds a token. The account is the authority (scopes, expiry, revocation, checked on every
-- request). A missing row only makes its token unusable, so this projection fails closed.
CREATE TABLE IF NOT EXISTS platform_tokens(
  token_hash TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_tokens_by_id ON platform_tokens(workspace, id);
