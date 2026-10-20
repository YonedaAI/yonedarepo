CREATE TABLE symbol_contracts(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  symbol_path TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  node_digest TEXT NOT NULL,
  contract TEXT NOT NULL,
  contract_digest TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  recorded_version INTEGER NOT NULL
);
CREATE INDEX symbol_contracts_symbol ON symbol_contracts(path,symbol_path,seq)
