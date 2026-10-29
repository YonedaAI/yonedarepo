-- Sign-in identities from OAuth providers (GitHub, Google), keyed by the provider's stable
-- user id and never by email. An account holds at most one identity per provider. One
-- authority instance per identity (`identity:<provider>:<subject>`) and per verified email
-- digest (`email:<sha256>`) maps it to the one account holding it (identity_claims), and one
-- per sign-in attempt (`oauth:<state digest>`) holds that attempt's PKCE verifier, nonce and
-- browser binding until its callback consumes it, once (oauth_flows).
CREATE TABLE account_identities(
  provider TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  login TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE identity_claims(
  key TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
CREATE TABLE oauth_flows(
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('signin','link')),
  account TEXT,
  session_hash TEXT,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
