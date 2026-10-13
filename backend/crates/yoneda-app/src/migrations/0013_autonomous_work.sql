CREATE TABLE working_branches(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE peer_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,run_id TEXT NOT NULL,recipient TEXT NOT NULL,payload TEXT NOT NULL);
CREATE INDEX peer_messages_run_recipient ON peer_messages(run_id,recipient,seq);
CREATE TABLE peer_deliveries(message_seq INTEGER NOT NULL,execution_id TEXT NOT NULL,epoch INTEGER NOT NULL,delivered_at INTEGER NOT NULL,acknowledged_at INTEGER,PRIMARY KEY(message_seq,execution_id,epoch));
CREATE TABLE intent_questions(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE INDEX intent_questions_run ON intent_questions(json_extract(payload,'$.run_id'));
