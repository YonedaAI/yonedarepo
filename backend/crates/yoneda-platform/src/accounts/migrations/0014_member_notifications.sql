CREATE TABLE org_member_notices(
 id INTEGER PRIMARY KEY AUTOINCREMENT,recipient TEXT NOT NULL,org TEXT NOT NULL,
 role TEXT NOT NULL,created_at INTEGER NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,
 epoch INTEGER NOT NULL DEFAULT 0,first_attempt INTEGER,completed INTEGER NOT NULL DEFAULT 0,
 canceled INTEGER NOT NULL DEFAULT 0,enqueued_at INTEGER NOT NULL DEFAULT 0,email_state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX member_notices_pending ON org_member_notices(completed,canceled,id);
CREATE TABLE account_notifications(
 id TEXT PRIMARY KEY,org TEXT NOT NULL,role TEXT NOT NULL,at INTEGER NOT NULL,read_at INTEGER
);
