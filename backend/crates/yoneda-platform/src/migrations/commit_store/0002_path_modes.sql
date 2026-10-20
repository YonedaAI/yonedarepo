-- A changed path records its new file mode, so landing and projection apply the change
-- without reading the commit's tree.
ALTER TABLE commit_paths ADD COLUMN mode TEXT
