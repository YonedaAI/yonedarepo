-- A flight plan: the goal and scope a coding session files on purpose before it flies. Not a
-- change row (a row with no branch would break branch rules and every open list), and never
-- taken from prompts, which are not kept. `branch` and `change_number` are what a landing
-- finds its plan by: a plan may be filed before its branch is pushed or its change opened,
-- and `session_id` is null when a person files one outside a coding session.
CREATE TABLE flight_plans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  branch TEXT,
  change_number INTEGER,
  goal TEXT NOT NULL,
  scope TEXT,
  principal TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX flight_plans_by_branch ON flight_plans(branch, id);
CREATE INDEX flight_plans_by_change ON flight_plans(change_number, id)
