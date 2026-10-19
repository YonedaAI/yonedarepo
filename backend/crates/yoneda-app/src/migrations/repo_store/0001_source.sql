CREATE TABLE repo_settings(
  id TEXT PRIMARY KEY CHECK (id='repository'),
  workspace TEXT NOT NULL,
  owner TEXT NOT NULL,
  object_store TEXT NOT NULL,
  policy TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE prepared_commits(
  commit_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE commits(
  id TEXT PRIMARY KEY,
  tree TEXT NOT NULL,
  parents TEXT NOT NULL,
  generation INTEGER NOT NULL,
  base_version INTEGER NOT NULL,
  principal TEXT NOT NULL,
  message TEXT NOT NULL,
  read_set TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE TABLE commit_paths(
  commit_id TEXT NOT NULL,
  path TEXT NOT NULL,
  op TEXT NOT NULL,
  old_blob TEXT,
  new_blob TEXT,
  PRIMARY KEY(commit_id, path)
);
CREATE INDEX commit_paths_by_path ON commit_paths(path, commit_id);
CREATE TABLE txlog(
  version INTEGER PRIMARY KEY,
  refname TEXT NOT NULL,
  entry TEXT NOT NULL,
  chain TEXT NOT NULL
);
CREATE INDEX txlog_by_ref ON txlog(refname, version);
CREATE TABLE refs(
  name TEXT PRIMARY KEY,
  commit_id TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE TABLE checks(
  commit_id TEXT NOT NULL,
  name TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass','fail')),
  evidence TEXT,
  principal TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(commit_id, name, policy_digest)
);
CREATE TABLE reviews(
  commit_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  reason TEXT,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(commit_id, principal)
);
CREATE TABLE landings(
  commit_id TEXT NOT NULL,
  refname TEXT NOT NULL,
  version INTEGER NOT NULL,
  landed_at INTEGER NOT NULL,
  PRIMARY KEY(commit_id, refname)
)
;
CREATE TABLE tokens(
  name TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
)
