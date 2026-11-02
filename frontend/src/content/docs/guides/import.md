---
title: Import a repository
summary: Bring code in from a GitHub repository with its whole history, or from a local directory as one snapshot.
---

## Two ways in

| You have | Use | Brings |
|---|---|---|
| A GitHub repository | The web app, or `POST /api/v1/repos/import` for a public one | Every branch and tag, with every commit |
| A local checkout or directory | `yoneda repo import <dir>` | The files at HEAD, as one snapshot |

## From GitHub

```sh
curl -X POST https://api.yonedarepo.com/api/v1/repos/import \
  -H "Authorization: Bearer $YONEDA_TOKEN" -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/owner/project.git", "name": "project"}'
```

| Field | Meaning |
|---|---|
| `url` | `https://github.com/<owner>/<repo>`. Required. |
| `branch` | The branch that becomes `main`; default the repository's default branch |
| `name`, `visibility`, `owner` | The new repository's name (default its id), `public` or `private`, and an organization to own it |
| `policy` | Its landing rules; default one required approval |

The answer names the new repository's `id`. The import runs in the background; follow it until `status` reads `complete`:

```sh
curl -H "Authorization: Bearer $YONEDA_TOKEN" \
  https://api.yonedarepo.com/api/v1/repos/<id>/import
```

- Branches and tags all arrive at the end, so the repository is empty until `status` reads `complete`.
- Every branch keeps its name. `master` stays `master`, with a `main` beside it at the same commit when the repository has none.
- **Up to 10 GB.** A larger repository fails the import, and nothing lands.
- **After a failure,** delete the repository and add it again.
- **Private repositories** are added from the web app: choose the + button, then **Add GitHub repository**, and connect your own GitHub account. A private repository stays private here. Organization accounts can't connect yet.
- A private repository's address without a connection fails the import. There is no field for a token, and no CLI command for remotes yet.

## From a local directory

```sh
yoneda repo import ./project --name project
```

Uploads the files at HEAD of a local Git checkout (or every regular file of a plain directory) as a new repository's first commit. Large trees go up in batches of 10,000 files (`--batch-files <n>` changes it) and land at once at the end. History is not uploaded.

## After importing

Secrets in imported history are not removed by the import. If one turns up, [quarantine](/docs/guides/quarantine) the blob that holds it so it is no longer served, and rotate the credential.
