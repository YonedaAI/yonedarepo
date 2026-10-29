---
title: Security and privacy
summary: How access is checked, what we store, and what never leaves the server.
---

## Accounts and sessions

- Passwords must be at least 12 characters. A recovery code, shown once at sign-up, resets the password.
- The browser session is a signed, HttpOnly cookie. Signing in from too many places ends the oldest session.

## Tokens

| Token | Prefix | Scope |
|---|---|---|
| Personal access token | `ypat_` | Account-wide. Scopes `repo:read`, `repo:write`, `repo:land`, `repo:review`, `repo:admin`. All repositories or an allowlist. Expires in 1–90 days (default 30). |
| Repository token | `yrp_` | One repository, optional directory paths. |
| SSH key | | Acts as its account: read to fetch; read, write and land to push. |

- The server keeps only a hash of each token and checks it on every request. Revoking a token or removing an SSH key takes effect on the next request.
- A path-restricted token is enforced on every read, search, blame and cache path. Git transport refuses path-restricted tokens.
- Device login follows RFC 8628: single-use `XXXX-XXXX` codes that expire after 10 minutes, approved in a signed-in browser.

## Repository access

- Private repositories are readable by members only. A public repository can be cloned and read by anyone without signing in; only members write.
- Changing visibility applies within a second: an anonymous read of a repository just made private answers 404.
- Approving a change is a review of its head commit by an account other than its author. The platform refuses an author's own approval, including through a token the author created.

## What a push is checked for

- Every object is verified before anything is recorded; refs move only after the commits are recorded. A push that fails or is cut off leaves refs and the log unchanged.
- A file carrying a credential refuses the whole push with `secret detected in <path>:<line>`. Owners can accept a false positive by path and rule.
- Protected branches (`main`, `release`, `release/*`) are never rewritten or deleted, even by `git push --force`. Tags never move once created.

## Checks

Each check runs in its own container on the exact commit and is destroyed afterwards. The check's command runs as an unprivileged user with no capabilities, a scrubbed environment, **no network** and a hard timeout.

Model checks send the commit's diff and message to a model for one structured verdict. They are opt-in per repository: only a policy that lists a model runner sends code to a model.

## Agents

Agents are ordinary clients: they hold the same tokens as people and follow the same landing rules. An agent's claims about its work are not trusted on their own; checks run on the exact commit, and approvals come from a different account.

## Emergency access

A human-only break-glass path can land, revert or pause automation when checks or agents are down. It is never exposed over MCP.
