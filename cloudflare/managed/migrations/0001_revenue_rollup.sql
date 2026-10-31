-- The managed Worker's own D1, separate from the platform's: agents and their billing reach the
-- platform only as an API client. The operators' revenue view reads these tables, and the ledgers
-- stay the authority. Ledger entries live in one Durable Object per account, so a platform view
-- needs a rollup: each ledger pushes the days that changed, as whole rows, from its own outbox
-- (ledger-rollup.ts). Rebuildable: the ledgers can push every day again. Amounts are micro-USD,
-- days are UTC.
-- `version` rises with each push from a ledger, so a late retry cannot overwrite newer numbers.
CREATE TABLE IF NOT EXISTS billing_daily(
  account TEXT NOT NULL,
  day TEXT NOT NULL,
  version INTEGER NOT NULL,
  top_ups INTEGER NOT NULL DEFAULT 0,
  refunds INTEGER NOT NULL DEFAULT 0,
  disputes_lost INTEGER NOT NULL DEFAULT 0,
  free_granted INTEGER NOT NULL DEFAULT 0,
  model_charged INTEGER NOT NULL DEFAULT 0,
  model_cost INTEGER NOT NULL DEFAULT 0,
  container_charged INTEGER NOT NULL DEFAULT 0,
  unpriced_charged INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account, day)
);
CREATE INDEX IF NOT EXISTS billing_daily_by_day ON billing_daily(day);
-- Each account now: what it holds, not what happened in a period.
CREATE TABLE IF NOT EXISTS billing_accounts(
  account TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  first_paid_day TEXT,
  sold_outstanding INTEGER NOT NULL DEFAULT 0,
  free_outstanding INTEGER NOT NULL DEFAULT 0,
  frozen INTEGER NOT NULL DEFAULT 0,
  refunds_open INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
