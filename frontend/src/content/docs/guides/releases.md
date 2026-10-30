---
title: Releases and tags
summary: Tag a commit, publish a release with notes and assets, and download assets with their SHA-256.
---

## Tags

Push a tag with Git, or create one over the API:

```sh
git tag -a v1.2.0 -m "1.2.0"
git push origin v1.2.0
```

Annotated and lightweight tags are both accepted. **Tags never move and are never deleted** once created: pushing a different tag under an existing name is refused with `tags are immutable: this tag already exists`. Creating a tag needs the write and land scopes. Over the API: `POST /api/v1/repos/<id>/tags`; over MCP: `git_tag`.

## Publish a release

```sh
yoneda release create v1.2.0 --title "1.2.0" -m "Notes" --asset dist/app.tgz
yoneda release list
yoneda release show v1.2.0     # notes and assets, each with its SHA-256
```

- A release belongs to an existing tag; one release per tag.
- Publishing or deleting a release and uploading assets need the write and land scopes.
- Deleting a release deletes its assets; the tag stays.
- The repository's **Releases** page lists releases with their notes and assets.

## Assets

| Limit | Value |
|---|---|
| Assets per release | 20 |
| Size of one asset | 25 MiB over REST, 4 MiB over MCP |
| Title | 200 characters |
| Notes | 16,000 characters |

Upload an asset with the file as the request body:

```sh
curl -X PUT -H "Authorization: Bearer $YONEDA_TOKEN" \
  --data-binary @dist/app.tgz \
  https://api.yonedarepo.com/api/v1/repos/<id>/releases/v1.2.0/assets/app.tgz
```

Assets are immutable: a name is used once per release. A download answers the recorded SHA-256 in the `x-yoneda-sha256` header.

## Webhooks

Publishing and deleting a release send the `release.published` and `release.deleted` events; see [Webhooks](/docs/guides/webhooks).
