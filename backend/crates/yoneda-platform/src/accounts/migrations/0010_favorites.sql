-- The repositories an account keeps at the top of its repository picker, by id. This store
-- is the account's own, so a row needs no account column. Names and access are not kept: the
-- adapter checks both on every read.
CREATE TABLE account_favorites(
  repo TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL
);
