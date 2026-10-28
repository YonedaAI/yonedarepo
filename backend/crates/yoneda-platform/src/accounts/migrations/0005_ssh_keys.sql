CREATE TABLE account_ssh_keys(id TEXT PRIMARY KEY,title TEXT NOT NULL,fingerprint TEXT NOT NULL,algorithm TEXT NOT NULL,public_key TEXT NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER,removed_at INTEGER);
CREATE UNIQUE INDEX account_ssh_keys_live ON account_ssh_keys(fingerprint) WHERE removed_at IS NULL;
CREATE TABLE ssh_fingerprints(fingerprint TEXT PRIMARY KEY,account TEXT NOT NULL,key_id TEXT NOT NULL,claimed_at INTEGER NOT NULL);
