-- Accounts that are ours (the team's and the test accounts), flagged by an operator so they stay
-- out of the analytics and the overview's figures (`cargo xtask admin internal`). The one column
-- here no authority holds: it is an operator's label, used only for counting, and a rebuilt index
-- loses it until the command runs again.
ALTER TABLE platform_accounts ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS platform_accounts_internal ON platform_accounts(account) WHERE internal=1;
