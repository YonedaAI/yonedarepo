---
title: Security and privacy
summary: How access is checked, what a push is checked for, how checks are sandboxed, and what never leaves the server.
---

## Accounts and sessions

- Passwords are 12 to 128 characters and stored as argon2id hashes. Your email address is private.
- The browser session is a signed, HttpOnly cookie that lasts 7 days. An account holds at most 10 sessions; signing in once more ends the oldest.
- Sign-in attempts are limited to 10 a minute per account.
- A recovery code, shown once at sign-up, resets the password. Using it ends every session, revokes every token, removes every SSH key and unlinks GitHub and Google. See [Accounts and sign-in](/docs/accounts).

## Tokens

| Token | Prefix | Scope |
|---|---|---|
| Personal access token | `ypat_` | Your account: scopes `repo:read`, `repo:write`, `repo:land`, `repo:review`, `repo:admin`, `account:ssh-keys`; all repositories, an allowlist or one organization; expires in 1 to 90 days |
| Repository token | `yrp_` | One repository, optionally some paths; scopes `read`, `write`, `check`, `review`, `land` |
| SSH key | | Acts as its account over Git |

- The server keeps only a hash of each token and checks it on every request. Revoking a token or removing an SSH key takes effect on the next request.
- A path-restricted token is enforced on every read, search, blame and cache path. Git and LFS refuse path-restricted tokens.
- Device login follows RFC 8628: single-use `XXXX-XXXX` codes that expire after 10 minutes, approved in a signed-in browser.

Details are on [Tokens and access](/docs/guides/tokens).

## Repository access

- Private repositories are readable by members only, and answer "not found" to everyone else. A public repository can be cloned and read by anyone without signing in; only members write.
- Changing visibility applies within a second.
- An approval is a review of a change's head commit by an account other than its author. The platform refuses an author's own approval, including through a token the author created.

## What a push is checked for

- Every object is verified before anything is recorded; refs move only after the commits are recorded. A push that fails or is cut off leaves refs and the log unchanged.
- **Credentials.** A file carrying a credential refuses the whole push. Over Git: `secret detected in <path>:<line>`; over the API: `<path> line N looks like a credential (<rule>)`. Remove it and rotate it if it was real. If it is a false positive, the owner accepts it by path (or directory) and rule under **Settings → Secret exceptions** (the policy's `secret_allow`).
- **Protected branches** (`main`, `release`, `release/*`) are never rewritten or deleted, even by `git push --force`. Tags never move once created.

## Checks

Each check runs in its own container on the exact commit and is destroyed afterwards. The check's command runs as an unprivileged user with no capabilities, a scrubbed environment, **no network** and a hard timeout. Check definitions come from the landing rules, never from the commit under test, so a change cannot weaken its own check.

Model checks send the commit's diff and message to a model for one structured verdict. They are opt-in per repository: only a policy that lists a model runner sends code to a model. The managed [review agents](/docs/agents/review-agents) send code to a model only on repositories where you turn them on.

## Agents

Agents are ordinary clients: they hold the same tokens as people and follow the same landing rules. An agent's claims about its work are not trusted on their own; checks run on the exact commit, and approvals come from a different account. Session transcripts are redacted before they are stored; see [Sessions](/docs/guides/sessions#transcripts).

## Withholding content

An owner can [quarantine](/docs/guides/quarantine) a file's contents or a session's text so it is no longer served, then purge it, without rewriting any commit ids.

## Emergency access

A human-only [break-glass](/docs/guides/break-glass) path can land, revert or pause automation when checks or agents are down. It needs the owner's own signed-in session and is never exposed over tokens or MCP.
