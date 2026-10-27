-- Rebuildable membership index (B5): which accounts are members of which repositories, so
-- an account's listing includes repositories shared with it. Authority (roles, who may
-- manage them) stays in each SourceRepository Durable Object. A missing row only hides a
-- shared repository from the listing.
CREATE TABLE IF NOT EXISTS platform_members(
  repo TEXT NOT NULL,
  account TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY(repo, account)
);
CREATE INDEX IF NOT EXISTS platform_members_by_account ON platform_members(account);
