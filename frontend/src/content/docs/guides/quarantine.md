---
title: Quarantine and purge
summary: Stop serving a file's contents or a session's text, for example a secret found in history, and later delete it for good, without rewriting commit ids.
---

## What it does

Commits are immutable: rewriting history to remove a secret would change every later commit id. Quarantine withholds the content instead:

- A **quarantined** blob (a file's contents at some commit) or session text is no longer served. Commits, trees and ids stay as they are.
- A **purge** deletes the bytes from storage and derived caches. Copies already cached at other edge locations cannot be recalled, so rotate any leaked credential either way.
- A **release** lifts a quarantine before it is purged.

Pages that would show the content say `Withheld by the repository owner (quarantined).`

## Who and where

The repository's owner or an admin, over the REST API. There is no web or CLI control for it yet.

| Action | Request |
|---|---|
| List quarantines | `GET /api/v1/repos/<id>/quarantine` |
| Quarantine | `POST /api/v1/repos/<id>/quarantine` with `{blob \| path (+ ref) \| session, reason, retain_days?}` |
| Release | `POST /api/v1/repos/<id>/quarantine/<record>/release` |
| Purge now | `POST /api/v1/repos/<id>/quarantine/<record>/purge` with `{confirm}`, the target's id |

```sh
curl -X POST https://api.yonedarepo.com/api/v1/repos/<id>/quarantine \
  -H "Authorization: Bearer $YONEDA_TOKEN" -H "Content-Type: application/json" \
  -d '{"path": "config/prod.env", "ref": "main", "reason": "leaked API key"}'
```

- A quarantine is purged automatically after `retain_days`: 7 by default, from 1 to 365.
- Up to 1,000 blobs can be withheld at once.

## Effect on clones

A fetch that needs a withheld blob fails with HTTP 451:

```text
Blob <id> (<path>) is quarantined by the repository's owner and is not served; a fetch that needs it cannot complete (a partial clone or sparse checkout without it can)
```

So after quarantining a file that appears in history, full clones of that history stop working. Partial clones (`--filter=blob:none`) and sparse checkouts that never need the blob keep working.
