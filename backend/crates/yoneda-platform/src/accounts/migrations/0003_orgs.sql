-- Organizations: an account of kind org (no password, no sessions, no tokens of its own)
-- holds its owners and members, and teams of members. Its WorkspaceAuthority is the only
-- authority for them. A personal account keeps the names of the orgs it joined
-- (account_orgs), a hint the adapter uses to know which org authorities to ask: the hint
-- never grants anything, so a stale entry costs one lookup and a missing one only hides
-- that org's access. Personal access tokens may be limited to one org (account_tokens.org).
CREATE TABLE org_members(
  account TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE TABLE org_teams(
  name TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE org_team_members(
  team TEXT NOT NULL,
  account TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY(team, account)
);
CREATE TABLE account_orgs(org TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
ALTER TABLE account_tokens ADD COLUMN org TEXT
