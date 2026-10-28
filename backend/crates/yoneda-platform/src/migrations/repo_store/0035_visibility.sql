-- Who reads a repository besides its owner and members. 'private' (every repository
-- before this one): nobody else, and the repository answers NOT_FOUND to them. 'public':
-- anyone reads, including callers without credentials, and nobody gains write. Only the
-- owner changes it (`repo_set_visibility`), and the published head carries it so
-- stateless reads decide on it within the access bound.
ALTER TABLE repo_settings ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private', 'public'))
