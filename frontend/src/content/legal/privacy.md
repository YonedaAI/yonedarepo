---
title: Privacy Policy
status: Draft, pending legal review
summary: What YonedaRepo stores about you, why, who processes it, and how to have it removed. Last updated 2026-10-28.
---

This policy covers YonedaRepo, the source platform at yonedarepo.com operated by Yoneda Labs ("we"). It describes what the platform actually stores today. Where a feature is not built yet, we say so.

## What we store

### Your account

- **User name.** You may use an email address as your user name.
- **Password**, stored only as an Argon2id hash with a per-account salt. We never store the password itself.
- **Recovery code**, stored only as a hash. It is shown to you once.
- **Signed-in sessions**, stored by a hash of the session cookie, with an expiry. Older sessions are removed when you sign in from many places.

### Sign-in with GitHub or Google

If you sign in with GitHub or Google, we store:

- which provider it was;
- the provider's stable user id for you;
- your login name there;
- the email address the provider has verified, if it shares one;
- when you linked the identity and last used it.

We ask GitHub only for your profile and email addresses, and Google only for the standard OpenID profile and email. We use the codes and tokens the provider returns during sign-in in memory only and do not keep them. To stop two accounts claiming the same address, we keep a SHA-256 digest of each verified email.

### Email

We use your email address to send a welcome message when your account is created. We do not send marketing email.

### Tokens and keys

- **Personal access tokens** are stored as a hash. We keep each token's name, scopes, repository allowlist, creation, expiry and last-use times. For tokens made by `yoneda login`, we also keep the host name your CLI reports.
- **Repository tokens** and **device login codes** are stored as hashes.
- **SSH public keys** are stored with their fingerprints. Public keys are not secret.
- **Webhook signing secrets** are stored as issued, because each delivery is signed with them. They are shown to you once and never listed afterwards.

### Repositories

- **Contents.** Commits, trees and files are stored as Git objects in Cloudflare's Git object storage (Artifacts) and object storage (R2). Git LFS objects and release assets are stored in R2.
- **Records.** Each repository's transaction log, branches and tags, change requests, comments, reviews, check results, check logs, members and settings are kept in that repository's database on Cloudflare (Durable Objects).
- **Discovery index.** A separate index (Cloudflare D1) lists repository ids, names, owners and visibility, so we can show you your repositories.
- **Public repositories** can be read, cloned and listed by anyone, without signing in. Private repositories are readable only by their members.

### Agent session records

When a coding agent, or you, records a session on a commit, we store:

- the agent CLI and model name;
- the session's summary and its own session id;
- digests of the prompt and of the files it read;
- a transcript reference;
- the account or token that recorded it.

Files a session declares as read are recorded by path in the repository's transaction log.

**Transcripts are coming.** The platform does not store session transcripts today. Before it does, transcripts will be redacted for secrets before they are stored, and this policy will be updated first.

### Logs

- Our servers run on Cloudflare Workers. Their logs record request outcomes, errors and timing. Cloudflare may record request metadata such as your IP address and browser user agent with them.
- Our code is written never to log passwords, tokens or authorization headers.
- An internal monitor reads these events and Cloudflare's aggregate analytics to find faults.

### In your browser

- A signed, HttpOnly session cookie.
- Two local-storage entries: whether this browser was signed in last time (so the home page does not flicker), and your theme choice.
- We use no advertising or third-party tracking cookies.

## How we use it

We use this information to:

- run the service and authenticate you;
- enforce who can read and write each repository;
- show you your data;
- protect the platform, for example by scanning pushes for leaked credentials and limiting sign-in attempts;
- send the welcome email.

We do not sell personal data. We do not use your repositories to train models.

## Who processes it

| Processor | What it receives | When |
|---|---|---|
| Cloudflare | All of the above: it hosts our servers, storage, databases, check containers and logs | Always |
| GitHub, Google | The sign-in exchange | Only if you sign in with them |
| Resend | Your email address and the welcome message | When your account is created |
| Z.ai | A commit's diff and message | Only for repositories whose owner sets up a model check |

Checks run in isolated containers on Cloudflare with no network access. Their code is not sent anywhere else.

## Who else sees it

- **Members** of a repository see what their role allows.
- **Anyone** can see a public repository.
- **Webhooks:** a repository's owner can set up webhooks that send event details (such as a branch, commit or change number) to an address the owner chooses.
- **Legal requests:** we disclose information when the law requires it.

## How long we keep it

- **Sessions** expire. **Personal tokens** expire after 1 to 90 days, and you can revoke them at any time.
- **Deleting a repository** removes it from the platform at once and queues the deletion of its stored objects, check logs and LFS files.
- **Transaction log history** is kept according to the repository's retention settings.
- **Account deletion** is not yet self-service. Ask us and we will delete your account and the repositories it owns.
- **Logs** are kept for the retention period of our Cloudflare logging.

## Your choices

You can do these in the app, the CLI or the API at any time:

- see and export your data: clone any repository you can read, and list your tokens and SSH keys;
- revoke tokens and remove keys;
- unlink a sign-in provider;
- delete repositories.

For anything else, including account deletion or a copy of your account data, contact us. Contact details will be published on this page.

## Changes

We will change this policy as the platform changes. Each version is dated at the top. Before we store a new kind of personal data, such as transcripts, we will update this page.
