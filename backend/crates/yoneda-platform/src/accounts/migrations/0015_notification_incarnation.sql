CREATE TABLE account_incarnation(id INTEGER PRIMARY KEY AUTOINCREMENT);
ALTER TABLE org_member_notices ADD COLUMN recipient_incarnation INTEGER NOT NULL DEFAULT 0;
