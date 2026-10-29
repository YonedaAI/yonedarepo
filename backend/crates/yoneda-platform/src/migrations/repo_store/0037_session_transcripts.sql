-- Session transcripts. A record may name the transcript the platform keeps for it: the
-- document (the context packet and the turns, credentials redacted, at most 1 MiB) is in R2
-- at `platform/v1/<repo>/sessions/transcripts/<sha256>.json`, written and read back by the
-- adapter before the record is posted. This column holds its metadata as JSON (sha256,
-- bytes, turns, redactions, truncated, context). Null for records without one, which is
-- every record from before this migration.
ALTER TABLE sessions ADD COLUMN transcript TEXT
