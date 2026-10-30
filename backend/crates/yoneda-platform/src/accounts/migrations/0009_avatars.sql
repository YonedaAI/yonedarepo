-- Account pictures. Each sign-in identity keeps the avatar URL its provider reported at the
-- last sign-in or link (GitHub avatar_url, Google picture), only on the provider's own image
-- hosts. An uploaded picture is one row: the store-of-record key of its bytes, the type its
-- leading bytes show, its size and SHA-256. The upload, when present, is the account's
-- picture, else the most recently used identity's, else none (initials).
ALTER TABLE account_identities ADD COLUMN avatar_url TEXT;
CREATE TABLE account_avatar(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 1048576),
  digest TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);
