---
title: Webhooks
summary: Signed HTTPS POSTs for landings, refusals, branches, tags, checks, changes and releases, delivered in order and at least once.
---

## Add a webhook

In the repository's **Settings → Webhooks**, or over the API:

```sh
curl -X POST https://api.yonedarepo.com/api/v1/repos/<id>/hooks \
  -H "Authorization: Bearer $YONEDA_TOKEN" -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/yoneda", "events": ["land", "change"]}'
```

The answer holds the signing secret (`whsec_…`). It is shown once. The URL must be a public `https://` address. Managing webhooks needs the owner or a token with `repo:admin`. A repository holds up to 20 webhooks.

## Events

| Event | Sent when |
|---|---|
| `land` | A commit landed on a branch |
| `merged` | A landing was merged on the server with concurrent work |
| `refused` | A landing was refused |
| `branch` | A branch was created, moved or deleted |
| `tag` | A tag was created |
| `check` | A check concluded: pass, fail or error |
| `change` | A change request was opened, commented, landed, closed or deleted (`change.opened`, `change.commented`, `change.landed`, `change.closed`, `change.deleted`) |
| `release` | A release was published or deleted (`release.published`, `release.deleted`) |
| `repo` | The repository was deleted (`repo.deleted`, sent once; nothing is delivered after it) |

Leave out `events` to get them all. `paths` limits the commit messages a hook sees to commits inside those paths; change titles and comment text go only to hooks without `paths`.

## Deliveries

Each delivery is a POST with a JSON body and these headers:

| Header | Value |
|---|---|
| `X-Yoneda-Event` | The event, such as `land` or `change.opened` |
| `X-Yoneda-Delivery` | A delivery id; the same event retried keeps it |
| `X-Yoneda-Signature` | `sha256=` and the hex HMAC-SHA256 of the raw body, keyed with the secret |

- Events are delivered in the order of the repository's log, at least once: handle a repeated delivery id as a duplicate.
- Your endpoint has 10 seconds to answer with a 2xx status.
- Failures are retried with backoff from 10 seconds up to 15 minutes. After 50 failures in a row the hook is switched off.

## Verify the signature

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verified(rawBody: string, header: string, secret: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

Compute the HMAC over the raw request body, before parsing it.

## Inspect and delete

| Action | API | MCP |
|---|---|---|
| List webhooks (secrets never shown) | `GET /repos/<id>/hooks` | `git_hook_list` |
| The last 50 delivery attempts | `GET /repos/<id>/hooks/<hook>/deliveries` | `git_hook_deliveries` |
| Delete a webhook (undelivered events are dropped) | `DELETE /repos/<id>/hooks/<hook>` | `git_hook_delete` |
