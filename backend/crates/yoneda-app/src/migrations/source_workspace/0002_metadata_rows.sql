CREATE TABLE sw_view_files(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE sw_overrides(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE sw_deltas(checkpoint_id TEXT NOT NULL,path TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(checkpoint_id,path));
