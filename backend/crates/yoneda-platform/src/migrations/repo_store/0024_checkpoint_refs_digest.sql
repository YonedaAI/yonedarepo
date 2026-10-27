-- Each checkpoint's ref-map digest (Delta's version checksum), which the next log entry
-- repeats. Checkpoints written before it stay NULL and reads no longer trust them.
ALTER TABLE txlog_checkpoints ADD COLUMN refs_digest TEXT;
