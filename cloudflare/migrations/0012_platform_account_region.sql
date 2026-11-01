-- Where an account signed up from, a continent-level code (cloudflare/worker/region.ts), global
-- regions stage R1. Nothing routes on it yet. A rebuildable projection: the account's authority
-- holds the code, and an account without one, as every account made before this column is,
-- reads as `enam`.
ALTER TABLE platform_accounts ADD COLUMN region TEXT NOT NULL DEFAULT 'enam';
