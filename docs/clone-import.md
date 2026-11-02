# Clone import

An import is a `git clone`. `cloneRepository` (`cloudflare/worker/repo-clone.ts`) runs Git in an `ImportContainer` and hands what it fetched to what a push stores and records with, with no public Git endpoint in between. The result is an ordinary repository: every object in R2, every commit of every branch and tag recorded under its own id, and each ref as it stood on the remote.

Public GitHub repositories, and private ones from a connected personal GitHub account (see **Private repositories**).

## Budget

Written before the code. **Nothing here is measured on dev.** The cold start is dev's check container on 2026-10-20; the rest are limits this path holds itself to.

| Measure | Budget |
|---|---|
| The import request answered | under 1 s: 1 R2 put to keep what starts the Workflow; the Workflow is created behind the answer |
| The remote asked before a container starts | 1 request, under 300 ms |
| A remote that is private or gone | no container started |
| Container | 1 instance, 1 of the class's slots, under 180 s to start |
| `git clone` | at most 60 min, 10 GB of pack; about 13.8 GB of disk free on `standard-3` (16 GB, less the 2.19 GB image), in `ImportContainer`, the check image on a class of its own, so checks stay on `standard-1` |
| The objects | 1 R2 write per 4 MiB, at most 3 at once, 1 index call per 5,000 objects. A file over 8 MiB is 1 R2 write of its own |
| The commits | 1 authority call per 100 commits or 1 MiB of changes |
| The refs | 1 authority call for main, then 1 per 100 refs |
| The pack a first `git clone` is sent | 1 multipart, 1 part per 5 MiB |
| One Workflow step | hands on after 120 s, always past at least one object |
| Worker memory | at most 2 parts of the pack, 3 bundles of 4 MiB and 1 chunk of a large file: under 64 MiB. No pack enters Wasm |
| Worker CPU | under the Worker's 5 min limit a step. **Not measured** |

Bench: `tools/import-bench.mjs`, 3 runs of each repository, server-side timing, min, median and max.

## How it works

1. The request checks the address (`githubRemote`), makes a repository on the platform's own store, and starts the Workflow.
2. The Workflow asks GitHub for the head, so a remote that is private or gone costs no container.
3. A fresh `ImportContainer` named `clone:<repo>` starts with `enableInternet` on for that start alone; every check still starts with it off. `POST /clone` runs a bare clone of every branch and tag, and nothing else a remote keeps (a pull request's refs).
4. Steps read what it holds, each time-boxed, so that no Worker fits a repository into one call:
   - `/clone/objects`: every commit, tree and file, framed as a push's, to `storeBundle`, and a large file to its own raw object.
   - `/clone/commits`: every commit, parents first, each with its bytes and its changes against its first parent, to `repo_record_pushed`.
   - `/clone/refs`: `repo_import` lands main, then `repo_import_refs` makes every other branch and tag. An annotated tag keeps its object, so its id stays Git's.
   - `/clone/pack`: stored under the key a whole `git clone` of those refs asks for, and kept as the seed later pack builds start from. A failure here ends nothing: a clone is then built from the objects.
5. The instance is destroyed.

**The smallest internal route** is the instance's own routes, read by the Worker over the Container binding. Nothing the platform stores or records goes over HTTP from the container, and the container holds no platform credential.

Refs come last, so an import is nothing or all of it. While it runs, the repository has no refs and `GET /repos/<id>/import` answers `{status: "running"}`; its page says `Importing this repository…`.

Every branch and tag keeps its name and commit. `master` stays `master`, and a remote with no `main` gets one beside it at the same commit, so the repository holds both:

| The remote | `main` starts at | Other refs |
|---|---|---|
| Has a `main` | its own `main`, whatever the default | as they are |
| No `main`, default `master` | `master` | `master` stays |
| `branch` asked for | that branch | that branch stays; a `main` of the remote's own becomes `imported/main` |

The trunk has to exist as `main`: it is a fixed name in the code rather than a setting of each repository. `HEAD` in Git over HTTP, protected branches, landings and direct landings, the ref chain, traffic warnings, the pack jobs, the CLI and the UI's defaults all name it: 169 lines in 88 files. A default branch per repository would be a schema change and a refactor of each of those.

## Rules of the instance

| Rule | Where |
|---|---|
| Only `https://github.com/<owner>/<repo>`, rebuilt from its two names | `githubRemote`, before any instance starts |
| https only; no private, loopback, link-local, shared or multicast host, as written or as resolved; no user, port, query or fragment | `clone_remote.rs`, before Git starts |
| A bare clone: no checkout, no template, `core.hooksPath=/dev/null`, `GIT_ALLOW_PROTOCOL=https`, no redirects, no prompts, no configuration read | `clone_git.rs` |
| 60 min for Git, killed with its whole process group; 10 GB of pack, watched as it arrives | `clone_git.rs` |
| Destroyed when the import ends, on any failure, and after 2 minutes idle | `cloneRepository`, `ImportContainer` |
| One clone an instance, for the holder of its one-start secret | `clone_import.rs` |

**The internet is not limited to GitHub at the network level.** `allowedHosts` would need `interceptHttps`, which carries every byte through a Worker. What keeps the instance to GitHub is the fixed command above: no code from any repository runs on it.

## Private repositories

A signed-in owner connects GitHub in the import dialog, picks a repository, and gets the same clone, through a GitHub App with Contents read-only. No OAuth flow or app is added: the proof is the GitHub identity the account linked by signing in with GitHub.

| Step | What happens |
|---|---|
| Connect | `/github/connect` sends someone with no linked GitHub to the link step. Otherwise it goes to the App's install page with a signed state. The session cookie is `SameSite=Strict` and does not come back from github.com, so the state names the account and a `Lax` cookie ties it to the browser |
| Back | `/github/connected` trusts neither the `installation_id` nor anything else on the address. It reads `GET /app/installations/{id}` with the App's JWT, and keeps the installation only when `account.id` is the account's linked GitHub identity. The account authority stores the installation id and login, never a token |
| Every use | The same proof again, so an undone link, a suspended or removed installation, or a changed account ends access at once |
| Picker | `GET /installation/repositories`, 1,000 at most |
| Import | `POST /repos/import {github_repository: <id>}`. A token limited to that id with `contents: read` is minted and dropped: a repository outside the installation mints nothing, and GitHub's answer gives its name and whether it is private. A private source imports as private, whatever was asked |
| Clone | The Workflow's payload holds two ids. `cloneRepository` mints a token inside the step that uses it: one for the head, one per instance start. It goes by the instance's environment and Git's environment for that one command, is taken out of anything Git says, and is in no Workflow state, step name or log |
| Re-import | Keeps the same ids for the same address. Another address drops them |

**A token lasts an hour.** Only `POST /clone` uses it, and Git's requests all start in the first seconds of the clone: the refs, then one fetch whose answer is the pack. The steps after that read the instance's disk. A clone may run 60 minutes and its token is minted up to 3 minutes before, so the very longest clone's pack would still be arriving past the hour. GitHub's docs don't say whether an answer already streaming is cut off at expiry. **Not measured.** If it is, the clone fails, nothing lands and the import is run again.

**An organization connects like an account.** Add another repository opens GitHub's install page, which lists the person's account and organizations. On the way back the redirect's `installation_id` is believed only once GitHub says the same: the App asks `GET /repos/{repo}/collaborators/{login}` about the GitHub user this account linked, on the installation's repositories until one says yes. That call needs only the metadata every installation token has, so the App needs no Members permission. OAuth app restrictions don't cover GitHub Apps, so an organization has nothing to approve, and no OAuth round or owner check is involved. GitHub counts owners, team members, members by default access and outside collaborators. Tested 2026-11-02 against a personal installation: 204 for the owner, 404 for a stranger, on a private and a public repository. **Not yet tested on a real organization.**

| Case | What happens |
|---|---|
| On none of its repositories, as with a forged `installation_id` | `not_member`. Nothing stored |
| Nothing shared with the App | `not_member`: there is no repository to ask about |
| The login now names another GitHub id | `other_account` |
| `setup_action=request`: GitHub stopped someone who isn't an owner | Organizations already holding the App are checked and connected where this person is on a repository. Otherwise `requested` |

The import dialog lists every repository of every installation that holds, an account's own first, in one list and one search. On an organization a private repository shows only if GitHub counts this person on it, asked ten at a time and at most 300 for one answer; past that it's left out and `more` is set. Importing one asks again. A public one is listed for all.

Re-checks: each use reads the installation (still an organization, the same id, not suspended) and needs the GitHub user who connected it still linked here. Closing an account takes its own installation off GitHub and leaves an organization's.

`github_org_ticket_*` in the account authority are unused since this change. Migration 13 stays; removing the ops is separate work.

## What can go wrong

| Case | What happens |
|---|---|
| A pack over 10 GB, or more than the instance's disk holds | The import errors with `REPO_TOO_LARGE`, saying so. Nothing lands |
| A remote that is private or gone | `REMOTE_AUTH_REQUIRED`, no container started, and a pointer to Connect where the App is set up |
| An installation removed or suspended, or a repository taken out of it | `GITHUB_RECONNECT`, no container started when it is known before the clone, and the page offers Connect |
| No container free, the clone fails or times out, a stream is cut short | The import errors, saying what failed. No ref moved, and the repository is deleted and added again |
| The instance goes between steps | The steps start again on a fresh one, once. Objects and commits are keyed by id, so what they find stored stays |
| A step repeats | Harmless: a commit recorded and a ref at its commit stay |
| Someone pushes while it imports | The import errors, saying the repository changed; what they pushed stays |
| A ref the platform cannot name | Left out alone and counted (`left_out`), with no stored pack, since no clone asks for what it holds |
| A tag of a file or tree | Left out: a ref names a commit here (`refs_skipped`) |
| A tag object the platform cannot keep (a tag of a tag) | The ref stays, at the commit |
| A commit over 100,000 changed files | Recorded with its files and no list of changes: only a path's history skips it |
| A path the platform refuses (`a:b`) | The file is there; only that path's history is left out |

## What is proved

Locally, 2026-11-01, on a Mac and in the real image, not on dev.

- Runtime tests with real Git over `file://`: every branch and tag, parents first, tags byte for byte, refused addresses, limits, the credential. They also run as root on Linux in the image build, with the clone dropped to UID 1000.
- Worker tests with a real authority and R2 and a fake container: a history with diverged branches, a merge and both kinds of tag, read back and cloned through the platform's own Git, from the stored pack and from objects alone.
- The real `yoneda-runtime` on real GitHub over https, through the real authority and R2 in workerd (a one-off check, no test holds it on real data):

| Repository | Refs | Commits | Objects | Clone, s | Clone to refs landed, s | Refs different from GitHub |
|---|---|---|---|---|---|---|
| spf13/pflag | 19 | 440 | 1,573 | 1.0 | 1.6 | 0 |
| openai/whisper | 29 | 198 | 916 | 1.4 | 2.1 | 0 |
| pallets/flask | 73 | 5,607 | 26,372 | 1.6 | 7.3 | 0 |
| expressjs/express | 331 | 6,449 | 33,707 | 1.5 | 18.3 | 0 |

`master` is the default in pflag and express. Main stood at GitHub's commit, as it does now, though these runs predate `master` keeping its name beside it. These are local R2 and Durable Objects, so hosted times will be longer.

- Flask's clone built from R2 objects alone, with no stored pack: real Git's `index-pack` takes it, `fsck --connectivity-only` passes, and all 5,607 commits are reachable from its 73 refs.

**Not proved: anything hosted.** That the instance reaches GitHub, its cold start, disk use, Worker memory and CPU on a large repository, and a pack build from the seed after a push on a large repository.
