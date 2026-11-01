-- What the operator log's split, filters and detail panel read (platform-operator-audit.ts). All
-- additive: a row from before them has none, reads as finished, and is told apart by its actor.
-- `outcome` is success, failed, denied, or a purge's requested, queued, completed. `actor_kind`
-- is person or system. `origin` is the page's host, or `script`. No address is kept.
ALTER TABLE admin_audit ADD COLUMN outcome TEXT;
ALTER TABLE admin_audit ADD COLUMN request_id TEXT;
ALTER TABLE admin_audit ADD COLUMN actor_kind TEXT;
ALTER TABLE admin_audit ADD COLUMN origin TEXT;
ALTER TABLE admin_audit ADD COLUMN time_zone TEXT;
