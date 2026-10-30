---
title: API reference
summary: The REST API and the MCP tools. Both run the same operations with the same scopes.
---

## Basics

- Base URL: `https://api.yonedarepo.com/api/v1`.
- Authenticate with `Authorization: Bearer <token>`: a `ypat_` personal access token or a `yrp_` repository token; see [Tokens and access](/docs/guides/tokens). The web app uses its session cookie.
- Request and response bodies are JSON. Errors answer `{error: {code, message}}` with an HTTP status; overload answers 503 `OVERLOADED` with `Retry-After`.
- Reads take `at=<version>` to answer as of a landed version of the transaction log.
- Every repository operation is also an MCP tool (below), dispatched through the same operation table with the same scopes.

```sh
curl -H "Authorization: Bearer $YONEDA_TOKEN" https://api.yonedarepo.com/api/v1/repos
```

## Account

| Method and path | What it does |
|---|---|
| `GET /repos` | Repositories you can use |
| `POST /repos` | Create a repository, optionally with files and a policy |
| `POST /repos/import` | Import a public HTTPS Git remote as a new repository; see [Import](/docs/guides/import) |
| `GET`, `POST`, `DELETE /tokens[/<id>]` | Personal access tokens (create from a signed-in session) |
| `GET`, `POST`, `DELETE /ssh-keys[/<id>]` | SSH keys |
| `GET`, `PUT`, `DELETE /account/avatar` | Your picture: `PUT` the image as the body (PNG, JPEG or WebP, up to 1 MB; signed-in session only); `DELETE` falls back to your GitHub or Google picture |
| `GET /avatars/<account>` | An account's picture, no sign-in needed: the uploaded image, or a redirect to its GitHub or Google picture; 404 when it has none |
| `POST /device/code`, `POST /device/token` | Device login (RFC 8628) |
| `GET /activity` | Your account's recent activity |
| `GET`, `POST /orgs`; `GET`, `DELETE /orgs/<org>` | Organizations |
| `GET /orgs/<org>/repos`; `POST /orgs/<org>/members` | An organization's repositories and members |
| `POST /mcp` | The account MCP endpoint |

## Repository: reading

All paths start with `/repos/<id>`.

| Method and path | What it does |
|---|---|
| `GET /` | Head refs, log version and landing policy |
| `GET /refs`, `GET /log`, `GET /txlog` | Branches, first-parent history, the transaction log |
| `GET /tree`, `GET /blob` | A directory listing, a file |
| `POST /objects` | Git objects by id, up to a response budget |
| `GET /diff`, `GET /merge-base` | A diff (`patch=1` for hunks), a merge base |
| `GET /search`, `GET /blame` | Search (code, memories, commits, sessions, changes), blame |
| `GET /symbols`, `GET /symbol`, `GET /contract` | Symbols, one symbol, its contract |
| `GET /views/agent`, `GET /views/human` | A symbol with contract, callers and callees; the subsystem Overview |
| `GET /commits/<sha>` | One commit with its checks, reviews and landing gates |
| `GET /context`, `GET /context/relevant` | What a new coding session should know; context ranked for paths, symbols or a query |
| `GET /sessions`, `GET /sessions/<n>`, `GET /sessions/<n>/transcript` | Recorded coding sessions and their transcripts |
| `GET /commits/<sha>/sessions` | The sessions recorded on one commit |
| `GET /memories`, `GET /memories/<n>` | Memories |
| `GET /check-runs/<id>[/log]` | A check run and its log |
| `GET /import` | Progress of an import |

## Repository: writing and landing

| Method and path | What it does |
|---|---|
| `POST /commits` | A server-side commit |
| `POST /land` | Land a branch's commit on its base |
| `POST /merges`, `POST /commits/<sha>/revert`, `POST /commits/<sha>/cherry-pick` | Merge, revert, cherry-pick on the server; see [Merge and rebase](/docs/guides/merge-rebase) |
| `POST /branches`, `POST /refs/batch` | Create or move branches; move several atomically |
| `POST /branches/<name>/rebase` | Rebase a working branch on the server |
| `POST /tags`, `GET /tags/<name>` | Tags |
| `POST /commits/<sha>/reviews` | Approve or reject a commit |
| `POST /commits/<sha>/checks`, `POST /commits/<sha>/check-runs` | Post a check, request a run |
| `POST /commits/<sha>/sessions` | Record a coding session on a commit |
| `POST /memories`, `POST /memories/<n>/retire` | Add or retire a memory |
| `POST /contracts` | Record a symbol's contract |
| `POST /symbol-edits`, `POST /codemods`, `POST /plans`, `POST /bisect` | Symbol edits, codemods, work plans, bisect |
| `POST /commits/<sha>/pin` | Pin a commit's objects |
| `POST /fork` | Fork the repository |

## Changes, releases and settings

| Method and path | What it does |
|---|---|
| `GET`, `POST /changes` | List or open change requests |
| `GET /changes/<n>` | A change with gates, reviews and comments |
| `GET /changes/<n>/gates` | What the head still needs to land: each requirement ready, waiting or blocked, with why |
| `POST /changes/<n>/comments`, `/close`, `/reopen` | Comment, close, reopen |
| `DELETE /changes/<n>` | Delete a closed change and its comments (author or owner) |
| `GET`, `POST /releases`; `GET`, `DELETE /releases/<tag>` | Releases |
| `PUT`, `GET /releases/<tag>/assets/<name>` | Upload a release asset (the body is the file), download one |
| `PUT /policy`, `PUT /visibility` | Landing rules, public or private |
| `GET`, `PUT /lfs` | The Git LFS quota |
| `GET`, `POST /members`; `DELETE /members/<account>` | Members |
| `GET`, `POST /tokens`; `DELETE /tokens/<name>` | Repository tokens |
| `GET`, `POST /hooks`; `DELETE /hooks/<id>`; `GET /hooks/<id>/deliveries` | Signed [webhooks](/docs/guides/webhooks) |
| `GET`, `POST /quarantine`; `POST /quarantine/<n>/release`, `/purge` | [Quarantine and purge](/docs/guides/quarantine) |
| `POST /break-glass` | Owner-only [recovery and automation pause](/docs/guides/break-glass) (signed-in session) |
| `DELETE /?confirm=<name>` | Delete the repository |
| `POST /mcp` | The repository MCP endpoint |

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED`, `FORBIDDEN` | 401, 403 | No valid credential, or it lacks the scope or role |
| `NOT_FOUND` | 404 | No such resource, or you cannot see it (private repositories answer this) |
| `STALE_HEAD` | 409 | A branch moved since the value you expected; read it again |
| `CONFLICT` | 409 | A merge, rebase, revert or landing conflicts; details name the paths |
| `NOT_READY` | 409 | A commit cannot land yet: its gates are not met |
| `ALREADY_EXISTS` | 409 | A tag, release, asset or open change of that name exists |
| `SECRET_DETECTED` | 422 | The content holds a credential |
| `AUTOMATION_PAUSED` | 423 | The owner paused automation |
| `RATE_LIMITED` | 429 | Too many requests; slow down |
| `QUARANTINED` | 451 | The owner withheld this content |
| `OVERLOADED` | 503 | Retry after the `Retry-After` seconds |

## MCP tools

Each tool takes the repository from its endpoint, or a required `repo` (id or exact name) on the account endpoint. Generated from the platform's own tool list.

| Tool | What it does |
|---|---|
| `git_status` | Repository head refs, current log version and landing policy. |
| `git_refs` | Branch refs, optionally as of a past log version. |
| `git_log` | First-parent history of a branch, newest first, with landing versions. With path, only commits that changed that path (or anything under a dir/ prefix). |
| `git_txlog` | The hash-chained transaction log: every ref move with paths, read set and actor. |
| `git_show` | One commit: message, parents, changed paths, checks, reviews, landings and landing gates. |
| `git_merge_base` | Best common ancestors of two commits. |
| `git_ls_tree` | List a directory at a commit, branch or past version. |
| `git_cat_file` | Read one file at a commit, branch or past version. UTF-8 text is returned as text, other bytes as base64. On main without commit or at, it reads main's published head, which can trail a landing by a few seconds; to read your own landing, pass the version git_land returned as min_version (STALE_READ while main has not reached it: retry). |
| `git_get_objects` | Fetch immutable Git objects by id and kind (tree entries, commit headers, blob bytes as base64), in order, up to a response budget. Resume with after=next. Start from a commit's tree and request only the subtrees and blobs you need (sparse by construction). Path-restricted tokens must pass commit and each object's path inside their grant. |
| `git_grep` | Search the repository in one query: file contents and paths at a commit, branch or past version (results: files ranked whole-word matches first, then path matches, then matches inside words, each by hit count then path, with each line's match ranges and the file's hit count; whole words only with word; case-insensitive with ignore_case; binary files are never listed as not searched), memories whose text holds the query's words (memories), and the commits (message, who recorded it, paths touched, or an id prefix), session records (summary and declared reads) and change requests (title and description) holding all of its words: each of commits, sessions and changes is {count, capped, results}, ranked by where the words appear, then newest first (at most limit, 50, per group). groups narrows the answer (code, memories, commits, sessions, changes); a group left out, and for a path-restricted token memories, sessions and changes, is null, and its commits are those touching its grant. |
| `git_blame` | Line-by-line attribution of a file on a branch: the commit that last changed each line, from the file's first-parent history. |
| `symbol_list` | Symbols (functions, types, methods, modules) in a Rust, TypeScript or JavaScript file at a commit, branch or past version, each with a handle for symbol_edit. A parse failure is reported, never hidden. |
| `symbol_get` | The source text of one symbol (by qualified path like Type::method, or name) with its handle. Read only what you need instead of whole files. |
| `git_diff` | Files changed from base (default: head's first parent) to head, optionally with unified patches. merge_base compares against the common ancestor, like base...head. |
| `git_commit` | Create a commit on the server from file changes against a branch head (or an explicit parent). Nothing is landed: the commit is recorded and must pass checks and review before git_land moves a branch. Declare read_set (paths, dir/ prefixes, or path#symbol entries such as src/lib.rs#Policy::backoff for the symbols you relied on) so concurrent work is checked for independence; the platform derives which symbols your change wrote. |
| `symbol_edit` | Replace one symbol's source on the head of a branch, creating (not landing) a commit. The handle must still match the symbol in the current file; a stale handle (the symbol changed or vanished) is rejected. The edited file must still parse. |
| `symbol_contract` | The contract governing one symbol at a commit, branch or past version: inputs, outputs, effects, errors and invariants. status is authored (a recorded contract matching the symbol's current node digest), derived (from the signature and doc comments) or stale (a recorded contract exists but the symbol changed since; it is reported, never served as the contract). |
| `symbol_contract_record` | Record an authored contract for the symbol a handle names (from symbol_get, symbol_list, symbol_contract or symbol_view). The handle must match the symbol at its commit; the record binds to that commit and the symbol's node digest, so it turns stale when the symbol changes. |
| `symbol_view` | Agent view of one symbol at a revision: its source and handle, its governing contract, and its graph neighbors (callers, callees, members) with handles. Neighbors are resolved lexically by name within the files you can read, so treat them as candidates. |
| `git_codemod` | Literal find/replace across a branch (optionally under a path prefix), computed partition by partition and reduced into one commit (not landed). |
| `git_plan` | Plan proposed work items at one revision of a branch (nothing runs). Items whose symbols share a reference cycle that one of them writes are joined into one item; the rest are staged so items in one stage are independent (neither writes what the other reads or writes) and an item that reads what another writes comes after it. Reads are extended with the symbols their symbols reference (closure_depth). Items with a base_version report stale reads since then. Symbol entries on unparsed files are planned at path level. |
| `git_check` | Record a check result for an exact commit (requires the check scope). |
| `git_check_run` | Ask the platform to execute the policy's check runners on an exact commit (all runners, or one by name). Runs also start automatically when a commit is recorded; results appear in git_show. |
| `git_session_record` | Record which coding session produced a commit you pushed (needs write; only the commit's pusher or the repository owner): the CLI (e.g. claude-code, codex, opencode), the model, a summary of at most 4 KiB (refused if it holds a credential), optional SHA-256 hex digests of the prompts and of the declared read set, an optional transcript_ref (a URL or opaque id of a transcript kept elsewhere), an optional transcript the platform stores and shows to the repository's readers (credentials in it are redacted, never refused), and an optional session_id naming the coding session (e.g. opencode:ses_…) so its records across commits tie together. Posting the same record again answers the first. |
| `git_sessions` | The session records of a commit, oldest first: cli, model, summary, prompt and read-set digests, transcript_ref, the stored transcript's metadata (null when none was stored), session_id, who recorded each and when. |
| `git_sessions_recent` | The repository's session records newest first (default 50, at most 200): commit, its message's first line, cli, model, summary, session_id, how many reads the commit declared, who recorded each and when. Filter by session_id (one coding session), cli, model or ref (the sessions behind a branch's commits); pass next as before for the following page. |
| `git_context` | What a coding session starting work should know, in one read: main's head (and branch's, when named), the landing rules, the newest session records (what earlier sessions did), open change requests, and the newest authored symbol contracts, those on paths first, and the repository's current memories ranked for those paths. |
| `git_memory_add` | Leave a memory for later coding sessions (needs write): a decision, a constraint, a gotcha or a how-to that the code alone does not say, at most 2 KiB of text (refused if it holds a credential). Anchor it to the files, directories (ending in /) or symbols it is about: it is shown to later sessions when they read those files, and reads as stale once the anchored code changes on main. It is written against commit (default: the head of ref, default main). Pass session_id (your $YONEDA_SESSION_ID) to link it to your session, and supersedes to replace an older memory that is now wrong. The same memory posted again answers the first. |
| `git_memory_list` | The repository's memories newest first (default 50, at most 200), each with its anchors and whether the anchored code has changed since (stale). Filter by path (memories on that file, a directory holding it, or under a directory/), kind, status (current: the default, active and drafts; active; stale; draft; retired; superseded; all) or session_id; at reads as of a log version; pass next as before for the following page. |
| `git_memory_show` | One memory: its text, kind, author, commit, source session, what superseded it or it supersedes, whether it was retired (by whom and why), and each anchor with its blob or node digest and whether that code has changed on ref (default main) since. |
| `git_memory_retire` | Retire a memory that is no longer true (needs write). It is kept, marked retired with your reason, and no longer shown to coding sessions. To replace it with a corrected one, use git_memory_add with supersedes instead. |
| `git_context_relevant` | What is relevant to the files, symbols (path#symbol_path) and/or text (e.g. the task) you are working on, ranked in one read: current memories, authored contracts, recent session records and open change requests. Ranked by where each is anchored (a named symbol, then the file, then its directory), plus matching words of query, then fresh before stale, then newest. types narrows it (memory, contract, session, change); limit is at most 50. |
| `git_bisect` | Find the first commit on a branch that breaks a policy check: start with good, bad and check (a policy runner name); the platform runs the check on midpoints and narrows the range as results arrive. Pass id to read progress. |
| `git_pin` | Pin (or unpin) a commit so vacuum never releases its objects, for example while a long job reads it. |
| `git_review` | Approve or reject a commit (requires the review scope; authors cannot review their own commits; rejection needs a reason). |
| `git_merge` | Create (not land) a merge commit of source (a branch or commit id) into branch `into` (default main), using a three-way merge on the server. Returns up_to_date or fast_forward when no merge commit is needed. Conflicts return CONFLICT with diff3-marked text per path to resolve in a follow-up commit. into may be a branch or a commit id. With on_conflict "workspace", conflicts return a two-parent workspace commit with every cleanly merged path (conflicted paths keep into's content) plus the conflicting paths, instead of CONFLICT. |
| `git_revert` | Create (not land) a commit on the server that undoes a commit's changes relative to its first parent, on top of a branch head. Fails with CONFLICT when the branch changed those paths since; reconcile with a three-way merge instead. |
| `git_cherry_pick` | Create (not land) a commit on the server that re-applies a commit's changes on top of a branch head. Fails with CONFLICT when the branch's versions of those paths differ from the commit's parent. |
| `git_rebase` | Rebase a working branch onto another branch's head (default main) on the server: replays the branch's commits not on onto, oldest first, each as a three-way merge, then moves the branch with one compare-and-swap on its planned head. Requires the write scope. A conflict returns CONFLICT with base/ours/theirs per path (details.conflicts, plus details.commit) and leaves the branch unchanged; a branch already on onto answers up_to_date; a push to the branch meanwhile returns STALE_HEAD. Protected branches (main) are refused; merge commits on the branch return NOT_SUPPORTED. |
| `git_branch` | Create or move a working branch (any branch except main) to a recorded commit, by compare-and-swap: expected is the branch's current commit, or null to create it. Requires the write scope; a mismatch returns STALE_HEAD. main moves only through git_land. |
| `git_tag` | Create a tag (refs/tags/<name>) at a recorded commit; with message, an annotated tag (the platform builds the tag object, tagged by tagger or the caller). Tags are immutable: creating the same tag again is a no-op, a different one under an existing name returns ALREADY_EXISTS, and no tool moves or deletes one. Requires the write and land scopes. The tag is logged like a branch move, listed by git_refs (annotated tags under annotated, ref name to tag object id), served to git clone (with the peeled commit) and mirrored to the object store. Annotated tags pushed with git push are accepted too, as is a tag object given as object_b64. REST: GET /tags/<name> answers a tag's commit and its tag object (data_b64) when annotated. REST: POST /tags. |
| `git_land` | Move a branch to a commit that passed its required checks and approvals (requires the land scope). If the branch moved meanwhile, the platform merges on the server: independent or cleanly mergeable work lands as a platform merge commit (post-land checks run on it); a stale read or textual conflict returns CONFLICT with details. With fast_forward_only, the commit lands only if its first parent is the current head; otherwise STALE_HEAD, and nothing is queued or merged. Returns the landing's transaction-log version: reads of main that pass it as min_version see the landing at once, while main's Git commit is projected shortly after (git_commit is null until then). Landing a branch's head on main marks that branch's open change request landed in the same transaction. |
| `git_fork` | Fork this repository: a new repository owned by your account, its branches and tags this one's at the current version, its history shared (nothing is copied; objects are read from this repository). Needs read on the whole repository (directly, as a member, through a team, or because it is public) and an account credential (a session or a personal access token with repo:admin), never a repository token. Open a change back with git_change_create {fork, branch, title} on this repository. A repository with forks cannot be deleted until they are. REST: POST /fork. |
| `git_change_create` | Open a change request: propose landing a branch on a base branch (`base`, default main; another existing branch). The branch must exist and not be main or a release branch; a branch has at most one open change (ALREADY_EXISTS otherwise). Approve or reject with git_review on the head commit and land with git_land {ref: <base>, commit: head} (approvals and required checks gate a protected base such as main; another base takes the write scope); a new push moves the head, so earlier approvals stop counting. Needs the write scope and a whole-repository credential. From a fork: pass `fork` (the fork's id) and a branch of the fork; this needs only read here and write on the fork, the branch's new commits are carried into this repository and the change proposes their mirror forks/<fork>/<branch> (it follows later pushes when shown). REST: POST /changes. |
| `git_change_list` | Change requests, newest first, filtered by status (default open). REST: GET /changes?status=&limit=. |
| `git_change_show` | One change request: the change, its head commit's record (git_show's shape: checks, check_runs, reviews and landing gates), its comments (oldest first), its branch's pushes from the transaction log (newest first) and the diff from the merge base with main to the head (git_diff's shape; for a landed change, against main just before it landed). patch adds unified patches. REST: GET /changes/:number?patch=1. |
| `git_change_gates` | What a change request's head still needs before it can land on its base, in one list: each required check, approvals, unresolved review comments, freshness against the base and a pause, each with state ready, waiting or blocked, one line of why, and whether landing enforces it (checks and approvals only on a protected base). ready is true when every enforced requirement is ready. REST: GET /changes/:number/gates. |
| `git_change_comment` | Comment on a change request (body at most 8000 bytes; credentials are refused). path, line and side anchor it to a diff line at commit (default: the change's head). resolve marks every unresolved comment on that anchor resolved, with or without a new body. Needs the write or review scope and a whole-repository credential. REST: POST /changes/:number/comments. |
| `git_change_close` | Close an open change request without landing it (the branch stays). Its author, the owner or a holder of the land scope may close it. REST: POST /changes/:number/close. |
| `git_change_reopen` | Reopen a closed change request. Its branch must still exist with no other open change. Its author, the owner or a holder of the land scope may reopen it. REST: POST /changes/:number/reopen. |
| `git_change_delete` | Delete a closed change request and its comments (close an open one first; a landed change stays as history). Only its author or the owner may delete it; the branch and its commits stay, and the number is never reused. Sends the change.deleted webhook event. REST: DELETE /changes/:number. |
| `git_release_create` | Publish a release for an existing tag: a title and notes, then assets with git_release_asset_upload. One release per tag (ALREADY_EXISTS otherwise). Needs the write and land scopes and a whole-repository credential. Sends the release.published webhook event. REST: POST /releases. |
| `git_release_list` | List releases, newest first, each with its tag, commit and asset count. REST: GET /releases. |
| `git_release_show` | One release: title, notes, tagged commit, assets (name, size, sha256, content type) and, for an annotated tag, its tag object id, message and tagger. REST: GET /releases/:tag. |
| `git_release_delete` | Delete a release and its assets; the tag stays (tags never move or disappear). Needs the write and land scopes. Sends the release.deleted webhook event. REST: DELETE /releases/:tag. |
| `git_release_asset_upload` | Attach a file to a release (at most 4 MiB here as base64; up to 25 MiB with REST PUT /releases/:tag/assets/:name and the raw bytes as the body). Assets are immutable: a name is used once per release (ALREADY_EXISTS), at most 20 per release. Answers the recorded size and sha256. Needs the write and land scopes. |
| `git_release_asset_download` | Read a release asset (at most 4 MiB here; larger ones with REST GET /releases/:tag/assets/:name, which answers the recorded sha256 in x-yoneda-sha256). Answers the bytes in base64 with the recorded size and sha256. |
| `git_hook_list` | Webhooks of this repository: id, url, events, paths, active, consecutive failures and undelivered count. Secrets are never listed. Needs the owner or repo:admin. |
| `git_hook_create` | Add a webhook: signed POSTs (X-Yoneda-Signature: sha256=<hex HMAC-SHA256 of the body with the secret>, X-Yoneda-Event, X-Yoneda-Delivery) to a public https url for each event, in log order, at least once. Events: land, merged, refused, branch (created/moved/deleted), tag, check (conclusion pass/fail/error), change (change requests: X-Yoneda-Event change.opened, change.commented, change.landed, change.closed or change.deleted; titles and comment text only for hooks without paths), release (release.published or release.deleted), repo (repo.deleted, once, when the repository is deleted); all when omitted. paths limits commit messages to commits inside those paths. Returns the secret once. Needs the owner or repo:admin. |
| `git_hook_delete` | Delete a webhook; undelivered events are dropped. Needs the owner or repo:admin. |
| `git_hook_deliveries` | A webhook's last 50 delivery attempts, newest first: delivery_id, event, attempt, ok, HTTP status, ms, error. Needs the owner or repo:admin. |
| `git_member_list` | Members of this repository: account, role (read, write, land or admin), added_by and added_at. The owner is not listed. Needs the owner or an admin. |
| `git_member_add` | Add an existing account as a member, or change its role. Roles: read (read and clone); write (also commit, push branches, post checks); land (also review and land on protected refs); admin (also act as the owner, except deleting the repository and managing admins). A member's personal token holds only what both its scopes and the role allow. Only the owner grants, changes or removes admin. Needs the owner or an admin. |
| `git_member_remove` | Remove a member; its access ends at once. The owner cannot be removed. Needs the owner or an admin (only the owner removes an admin). |
