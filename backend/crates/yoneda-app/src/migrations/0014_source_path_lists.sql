CREATE TABLE source_path_lists(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE source_path_entries(list_id TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(list_id,path));
