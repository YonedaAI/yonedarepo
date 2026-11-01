---
title: Limits
summary: How large a repository can grow, what counts toward it, and what happens at each limit.
---

**Recommended** figures keep a repository quick to work with; nothing stops you going past them. **Enforced** figures are hard: past them the request is refused.

| What | Recommended | Enforced |
|---|---|---|
| Repository size | Under 5 GB | 10 GB of Git data ([what counts](#what-counts-toward-the-10-gb)) |
| Files in one directory | Up to 3,000 | No limit |
| Directory depth | Up to 50 levels | Paths up to 512 bytes |
| Branches | Up to 5,000 | No limit on the count |
| Files in a repository | Up to 200,000 | No limit on the count |
| Size of one file | Under 1 MiB | 100 MiB, with a warning from 50 MiB |
| One file in [Git LFS](/docs/guides/lfs) | Files over 50 MiB belong here | 5 GB |
| Git LFS storage per repository | None | 5 GiB until the owner raises it, up to 1 TiB |
| One push over HTTPS or SSH | None | 64 MiB of pack data (files over 8 MiB aside), 40,000 objects, 2 GiB of files |
| One commit through Git | None | 100,000 changed files |
| One commit through the API | None | 10,000 changed files, 32 MiB per file, a 64 MiB request |

A push through the [`yoneda::` helper](/docs/guides/yoneda-remotes) goes commit by commit, so the 64 MiB pack limit doesn't apply to it.

## What counts toward the 10 GB

Repository size is your Git data: the same thing as the size of a `.git` folder, not of the files you check out. It adds up as you push, compressed the way Git sends it.

Git LFS objects and release assets are stored apart and don't count.

The owner can read the current size in bytes: `GET /api/v1/repos/<id>/compaction` answers `storage.git_bytes`.

## When a repository reaches 10 GB

Pushes and new commits are refused with HTTP 507 and the code `REPO_SIZE_LIMIT`. A push that starts under the limit finishes.

Everything else still works: reading, cloning, Landings, moving and deleting branches, and deleting the repository.

To keep going, start a new repository or contact support.

## High activity

Very high activity has its own limit, however little code a repository holds. Every commit, Landing, check and session leaves a record, and it takes millions of Landings to reach it.

| Refused | Still works |
|---|---|
| New commits and pushes | Reading, cloning and fetching |
| Imports | Landings already in the queue, and their checks and reviews |
| New Landings, comments and releases | Moving and deleting branches |
| New branches and tags | Revoking tokens and quarantining files |
| New sessions, memories and flight plans | Deleting the repository |

A refused request answers HTTP 507 with the code `REPO_FULL`. Over Git, the push reports it for each branch.

To keep going, start a new repository or contact support. Commits you made but couldn't land stay in your clone, ready to push to the new repository.
