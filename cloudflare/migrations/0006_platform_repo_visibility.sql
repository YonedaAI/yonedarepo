-- Discovery of public repositories (/explore): the listing carries each repository's
-- visibility. Authority stays in the SourceRepository Durable Object. The adapter writes
-- 'public' only after the authority made a repository public and 'private' before it
-- makes one private, so a lagging row can only hide a public repository from discovery,
-- never list a private one.
ALTER TABLE platform_repos ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
CREATE INDEX IF NOT EXISTS platform_repos_public ON platform_repos(visibility, created_at);
