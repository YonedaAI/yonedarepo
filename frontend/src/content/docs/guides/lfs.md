---
title: Git LFS
summary: Store large files with Git LFS against the repository's HTTPS remote. Objects go straight to object storage and are verified before they are recorded.
---

## Use it

Git LFS finds the platform from the repository's HTTPS remote; nothing else to configure.

```sh
git lfs install
git lfs track "*.psd"
git add .gitattributes design.psd
git commit -m "Add design"
git push origin main
```

The LFS endpoint is `https://api.yonedarepo.com/git/<repo-id>.git/info/lfs`, authenticated like Git over HTTPS: any user name and a token as the password.

## How it works

- LFS uses the Batch API with the basic transfer adapter. Uploads and downloads go straight to object storage through signed URLs, valid for one hour.
- Each object's size and SHA-256 are verified before it is recorded.
- A public repository's LFS objects download without credentials.
- Path-restricted tokens cannot use LFS, as with Git itself.

## Limits and quota

| Limit | Value |
|---|---|
| Largest object | 5,000,000,000 bytes (5 GB) |
| Objects per batch request | 1,000 |
| Storage per repository | 5 GiB by default; the owner can raise it to 1 TiB |

The owner changes the quota under **Settings → Large files (LFS)**, or with `PUT /api/v1/repos/<id>/lfs`. A push over the quota is refused with HTTP 507: `LFS quota exceeded: … the owner can raise the quota in Settings`.

## File locking

Locking is not supported: YonedaRepo merges concurrent changes instead. `git lfs locks` lists nothing, and `git lfs lock` is refused with `File locking is not supported: YonedaRepo merges concurrent changes`.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `Push has an object of N MiB; the limit is 100 MiB per file` | The file is not tracked by LFS yet: `git lfs track` it, then `git lfs migrate import` to move it out of earlier commits |
| HTTP 507 on push | The repository's LFS quota is full; the owner raises it in Settings |
| An LFS request is refused with a valid token | The token is path-restricted, or lacks write for uploads; use a token for the whole repository |
