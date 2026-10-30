---
title: Import a repository
summary: Bring code in from a public Git remote such as GitHub, with its recent history, or from a local directory as one snapshot.
---

## Two ways in

| You have | Use | Brings |
|---|---|---|
| A public HTTPS Git remote (for example on GitHub) | `POST /api/v1/repos/import` | The branch's newest commits, up to 5,000 |
| A local checkout or directory | `yoneda repo import <dir>` | The files at HEAD, as one snapshot |

## From a public Git remote

```sh
curl -X POST https://api.yonedarepo.com/api/v1/repos/import \
  -H "Authorization: Bearer $YONEDA_TOKEN" -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/owner/project.git", "name": "project", "max_commits": 500}'
```

| Field | Meaning |
|---|---|
| `url` | An `https://` Git remote. Required. |
| `branch` | The branch to import; default the remote's default branch |
| `max_commits` | How many of the newest commits to bring; default 100, from 1 to 5,000 |
| `name`, `visibility`, `owner` | The new repository's name (default its id), `public` or `private`, and an organization to own it |
| `policy` | Its landing rules; default one required approval |

The answer names the new repository's `id`. The import runs in the background; follow it with:

```sh
curl -H "Authorization: Bearer $YONEDA_TOKEN" \
  https://api.yonedarepo.com/api/v1/repos/<id>/import
```

- Commit messages are kept up to 4,000 characters.
- **Public remotes only.** A remote that needs credentials fails the import; there is no field for a remote token.
- There is no import button in the web app or CLI command for remotes yet.

## From a local directory

```sh
yoneda repo import ./project --name project
```

Uploads the files at HEAD of a local Git checkout (or every regular file of a plain directory) as a new repository's first commit. Large trees go up in batches of 10,000 files (`--batch-files <n>` changes it) and land at once at the end. History is not uploaded.

## After importing

Secrets in imported history are not removed by the import. If one turns up, [quarantine](/docs/guides/quarantine) the blob that holds it so it is no longer served, and rotate the credential.
