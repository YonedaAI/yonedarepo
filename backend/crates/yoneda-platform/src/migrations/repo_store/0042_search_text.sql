-- Full-text candidates for one search across the repository's records
-- (repo_store/search_records.rs): commit messages and who recorded them, the paths commits
-- touched, session record summaries with the reads their commit declared, and change
-- titles and descriptions. Each table's rowid is its row's (commits.rowid,
-- commit_paths.rowid, sessions.id, changes.number), and ranking is done in Rust. Triggers
-- keep them with their rows on every write path, and existing rows are indexed here first.
CREATE VIRTUAL TABLE commit_text USING fts5(message, author, tokenize='unicode61');
CREATE VIRTUAL TABLE commit_path_text USING fts5(path, tokenize='unicode61');
CREATE VIRTUAL TABLE session_text USING fts5(summary, reads, tokenize='unicode61');
CREATE VIRTUAL TABLE change_text USING fts5(title, body, tokenize='unicode61');
INSERT INTO commit_text(rowid,message,author) SELECT rowid,message,principal FROM commits;
INSERT INTO commit_path_text(rowid,path) SELECT rowid,path FROM commit_paths;
INSERT INTO session_text(rowid,summary,reads)
  SELECT s.id,s.summary,c.read_set FROM sessions s LEFT JOIN commits c ON c.id=s.commit_id;
INSERT INTO change_text(rowid,title,body) SELECT number,title,body FROM changes;
CREATE TRIGGER commit_text_add AFTER INSERT ON commits BEGIN
  INSERT INTO commit_text(rowid,message,author) VALUES(new.rowid,new.message,new.principal);
END;
CREATE TRIGGER commit_text_drop AFTER DELETE ON commits BEGIN
  DELETE FROM commit_text WHERE rowid=old.rowid;
END;
CREATE TRIGGER commit_path_text_add AFTER INSERT ON commit_paths BEGIN
  INSERT INTO commit_path_text(rowid,path) VALUES(new.rowid,new.path);
END;
CREATE TRIGGER commit_path_text_drop AFTER DELETE ON commit_paths BEGIN
  DELETE FROM commit_path_text WHERE rowid=old.rowid;
END;
CREATE TRIGGER session_text_add AFTER INSERT ON sessions BEGIN
  INSERT INTO session_text(rowid,summary,reads)
    VALUES(new.id,new.summary,(SELECT read_set FROM commits WHERE id=new.commit_id));
END;
CREATE TRIGGER session_text_edit AFTER UPDATE OF summary ON sessions BEGIN
  DELETE FROM session_text WHERE rowid=old.id;
  INSERT INTO session_text(rowid,summary,reads)
    VALUES(new.id,new.summary,(SELECT read_set FROM commits WHERE id=new.commit_id));
END;
CREATE TRIGGER session_text_drop AFTER DELETE ON sessions BEGIN
  DELETE FROM session_text WHERE rowid=old.id;
END;
CREATE TRIGGER change_text_add AFTER INSERT ON changes BEGIN
  INSERT INTO change_text(rowid,title,body) VALUES(new.number,new.title,new.body);
END;
CREATE TRIGGER change_text_edit AFTER UPDATE OF title,body ON changes BEGIN
  DELETE FROM change_text WHERE rowid=old.number;
  INSERT INTO change_text(rowid,title,body) VALUES(new.number,new.title,new.body);
END;
CREATE TRIGGER change_text_drop AFTER DELETE ON changes BEGIN
  DELETE FROM change_text WHERE rowid=old.number;
END
