-- Repository members (B5): other accounts with a role on this repository. The owner is
-- never a member. Removing a member deletes its row, so access ends with that commit.
CREATE TABLE members(
  account TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('read','write','land','admin')),
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
