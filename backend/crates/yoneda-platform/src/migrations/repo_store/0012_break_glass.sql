CREATE TABLE break_glass(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL CHECK (action IN ('land','revert','release_land_lease','pause_automation','resume_automation')),
  refname TEXT,
  commit_id TEXT,
  target_commit TEXT,
  old_commit TEXT,
  version INTEGER,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX break_glass_commit ON break_glass(commit_id);
CREATE INDEX break_glass_target ON break_glass(target_commit, refname);
CREATE INDEX break_glass_action ON break_glass(action, seq)
