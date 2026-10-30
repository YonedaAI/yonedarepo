---
title: Privacy Policy
summary: What YonedaRepo collects, why, where it is kept, who helps us process it, and how to have it removed.
---

YonedaRepo is the source platform at yonedarepo.com. It is operated by {{legalName}}, a {{entityType}} registered in {{formation}} ("we", "us"). This policy describes what the platform actually does today. When we add a new kind of personal data, we update this page before we start collecting it.

## What we collect

### Your account

- **Email address.** You sign up with an email address. It stays private: we use it to sign you in, to recover your account and to send the emails described below. Your public user name is made from the part before the `@`. To stop two accounts claiming the same address, we keep a SHA-256 digest of it. Accounts made before email-only sign-up may use a chosen user name, or an email address as their user name.
- **Password.** Stored only as an Argon2id hash with a per-account salt. We never store the password itself.
- **Recovery code.** Stored only as a hash. It is shown to you once.
- **Sessions.** Each signed-in session is stored as a hash of its cookie, with an expiry.

### Sign-in with GitHub or Google

Only if you choose to sign in with one of them. We ask GitHub for your profile and email addresses, and Google for the standard OpenID profile and email. We keep:

- which provider it was, and its stable id for you;
- your login name there;
- the email address the provider has verified, if it shares one;
- when you linked the identity and when you last used it.

We use the codes and tokens the provider returns during sign-in in memory only, and we do not keep them.

### Repositories and their content

- **Code and files.** Commits, trees and files, Git LFS objects and release assets.
- **Records.** Each repository's transaction log, branches and tags, change requests, comments, reviews, check results and logs, members and settings.
- **A discovery index** of repository ids, names, owners and visibility, so we can list your repositories.

Public repositories can be read, cloned and listed by anyone. Private repositories can be read only by their members.

### Agent session records and transcripts

When a coding agent, or you, records a session on a commit, we keep the agent CLI and model name, the session's summary and id, digests of the prompt and of the files it read, the account or token that recorded it, and the paths of the files it declared as read.

A session record can also carry a **transcript**: the context the session started with, then its prompts, tool calls with their input and output, and replies. A transcript can hold anything that appeared in the session, including code and text from your files.

- Transcripts are uploaded by the agent plugins when a session ends, or by `yoneda session record --transcript`. Without one of these, no transcript is stored.
- Before storing a transcript, the platform replaces every credential its 11 rules recognize with `[REDACTED:<rule>]`. These are the same rules that scan pushes. **Known limit:** a credential written in JSON-escaped form can slip past them, so do not rely on redaction alone.
- A stored transcript is at most 1 MiB and 2,000 turns; longer ones are shortened in the middle.
- Anyone who can read the repository can read its transcripts.

### Tokens and keys

- **Personal access tokens, repository tokens and device login codes** are stored only as hashes. We keep each token's name, scopes, repository list, creation, expiry and last-use times, and for tokens made by `yoneda login`, the host name your CLI reports.
- **SSH public keys** are stored with their fingerprints. Public keys are not secret.
- **Webhook signing secrets** are stored as issued, because each delivery is signed with them. They are shown to you once.

### Managed review agents and credit

If a workspace owner enables a managed review agent (Code review, Security review or Slop review) on a repository, we keep each run's settings, its outcome, the comments and check it posted, and a transcript of the run with credentials redacted. Each workspace has a credit balance: we record every grant and every charge, which is a model call's cost or a container's running time. Billing is not live yet: we take no payments and hold no payment details.

### Email

We send a welcome email when your account is created, an email to confirm your address, and an email when you ask to change it. We do not send marketing email.

### Request logs

Our servers run on Cloudflare Workers, which log each request's outcome, errors and timing. Cloudflare may record request metadata with them, such as your IP address and browser user agent. Our code is written never to log passwords, tokens or authorization headers. An internal monitor counts these events to find faults.

### In your browser

- A signed, HttpOnly session cookie.
- Two local-storage entries: whether this browser was signed in last time, and your theme choice.
- No advertising or third-party tracking cookies.

## How we use it

We use this information to:

- run the service and sign you in;
- enforce who can read and write each repository;
- show you your own data;
- run the checks and review agents a repository's owner sets up;
- protect the platform, for example by scanning pushes for leaked credentials and limiting sign-in attempts;
- send the emails described above;
- find and fix faults.

We do not sell personal data, and we do not use your repositories or transcripts to train models.

## Where it is stored

Everything is stored and processed by Cloudflare. Requests are served from Cloudflare's global network, and you do not choose a region. Our main storage is placed in eastern North America, so your data is processed in the United States. The service providers below may process the data they receive in other countries.

## How long we keep it

- **Sessions** expire after seven days. **Personal access tokens** expire after 1 to 90 days, and you can revoke them at any time.
- **Deleting a repository** closes it at once: it can no longer be read, and its tokens are revoked. Its code, LFS files, release assets, check logs and transcripts are then deleted from storage, and it leaves the discovery index. The repository's own records (its log, change requests, comments, reviews and session records) are retained in its sealed database and never served again. They are not deleted automatically; we erase them when you ask at [legal@yonedarepo.com](mailto:legal@yonedarepo.com).
- **Transaction log history** is kept according to each repository's retention settings.
- **Managed agent transcripts and credit records** are retained while the workspace exists and are not deleted automatically. We erase them when you ask at [legal@yonedarepo.com](mailto:legal@yonedarepo.com).
- **Request logs** are kept for the period Cloudflare's logging service allows, which is days, not months.
- **Your account** is kept until you ask us to delete it.

## Your choices and deletion

At any time, in the app, the CLI or the API, you can:

- export your code: clone any repository you can read with stock Git;
- list and revoke your tokens, and remove your SSH keys;
- unlink a sign-in provider;
- delete repositories you own.

Deleting an account is not self-service yet. Email us and we will delete your account, the repositories it owns and their sealed records, and confirm when it is done. We will also send you a copy of your account data on request.

## When we disclose it

- **Members** of a repository see what their role allows, and **anyone** can see a public repository.
- **Webhooks** that a repository's owner sets up send event details (such as a branch, commit or change number) to an address the owner chooses.
- **Service providers** receive what they need to do their job, listed below.
- **Legal requests:** we disclose information when the law requires it.
- **A change of control:** if the service is sold or merged, your data moves with it under this policy.

## Security

Passwords, recovery codes, sessions and tokens are stored only as hashes. Every request is checked against the account, token scope and repository it acts on. Checks and review agents run in isolated containers with no access to the internet; they reach the platform only through our own servers. Pushes and transcripts are scanned for credentials. No system is perfectly secure: if we learn of a breach that affects your data, we will tell you without undue delay.

## Service providers

| Provider | What it receives | When |
|---|---|---|
| Cloudflare | Everything above: it hosts our servers, storage, databases, containers, logs and the AI Gateway our model calls pass through | Always |
| Resend | Your email address and the message | When we send you an email |
| GitHub, Google | The sign-in exchange | Only if you sign in with them |
| Z.ai, Xiaomi (MiMo), Anthropic, OpenAI | The code and text a managed review agent reads, and its instructions | Only for repositories whose owner enables a managed review agent; which provider depends on the agent and the model the owner picks |
| Z.ai | A commit's diff and message | Only for repositories whose owner sets up a model check |
| Xiaomi (MiMo) | Error counts and short error messages from our servers, with credentials removed | When our internal monitor summarizes a fault |

Model calls pass through Cloudflare AI Gateway, which may keep a log of each request and its response under our account. Checks you write run in containers on Cloudflare, and their code is not sent anywhere else.

## Links to other sites

Repositories, documentation and README files can link to other sites. Their own privacy policies apply there, not this one.

## Rights in the EEA and the UK

If you are in the European Economic Area or the United Kingdom, you have the right to access, correct, delete, restrict or object to our use of your personal data, to receive it in a portable form, and to withdraw consent where we rely on it. We rely on our contract with you to run the service, on our legitimate interests to secure it and fix faults, and on legal obligations where they apply. You can also complain to your data protection authority. Your data is transferred to the United States as described above.

## Rights in US states

- **California, Colorado, Connecticut, Virginia and other states with similar laws:** you can ask what personal information we hold about you, ask us to correct or delete it, and get a copy. We do not sell personal information, share it for targeted advertising or use it for profiling, so there is nothing to opt out of. We will not treat you differently for asking.
- **Nevada:** we do not sell covered information.

To make a request, email us from the address on your account. We may need to confirm it is you, and we answer within the time the law sets.

## Children

YonedaRepo is not meant for anyone under {{minimumAge}}, and we do not knowingly collect personal data from them. If you believe a child has given us personal data, email us and we will delete it.

## Changes to this policy

We will update this policy as the platform changes. The date of the latest version is at the top. If a change is significant, we will tell signed-in users before it takes effect.

## Contact

Privacy questions and requests go to [legal@yonedarepo.com](mailto:legal@yonedarepo.com). We reply from that address.
