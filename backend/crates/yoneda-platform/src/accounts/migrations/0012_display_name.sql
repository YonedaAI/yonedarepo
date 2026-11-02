-- The name a person goes by, shown only to them. No row: none yet, so a sign-in provider's name
-- may fill it. An empty name: they cleared it, so no provider fills it again.
CREATE TABLE account_name(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
