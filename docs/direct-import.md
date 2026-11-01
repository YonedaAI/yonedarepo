# Direct import

Importing a public GitHub repository as a Git fetch the Worker runs itself, behind `DIRECT_IMPORT`. The owner's question: why not just run a `git clone`? To the platform an import is a big `git push` from GitHub.

## Budget

Written before the code, from the hosted numbers we hold (a Worker to Durable Object call 10-50 ms, an R2 write 200-1000 ms) and a first fetch from a Mac. **Not measured on dev.** The bar is the live 6 s to usable and 1 s for `git clone`.

| Measure | Budget |
|---|---|
| **Request to main usable, pack up to 12 MiB** | **under 3 s, whatever Artifacts does** |
| **Main landed to files shown** | **under 2 s: nothing a reader needs waits for a Workflow** |
| The import request answered | under 1 s: 1 R2 put to keep what starts the Workflow; the Workflow is created behind the answer |
| A look at the import (`GET /import`) | at most 0.3 s of waiting for the Workflow's status |
| Asking GitHub for its head | 1 request, under 300 ms |
| The pack, stored as the first clone's pack | 1 request to GitHub, 1 R2 put or 1 multipart per 5 MiB, under 1.5 s. Listing it among the repository's packs (2 R2 calls) comes after main |
| Reading the pack (every object hashed) | under 2 s of CPU at 12 MiB; never over the isolate's 128 MB |
| The head's files and trees | 1 R2 write per 4 MiB, at most 3 at once, 1 index call per 5,000 objects |
| Landing | 3 authority calls |
| History, pack read back | 1 R2 read, 1 authority call per 250 commits or 1 MiB of changes |
| History, rate | at least 500 commits/s (55 today, limited by tree reads from Artifacts) |
| `git clone` during history, `--depth` and `--filter` too | served from the stored pack, as fast as a stored clone, from the moment main is usable |
| A fetch nothing can serve yet | waits up to 20 s for Artifacts, then is refused, sending nothing and saying so |
| Failure at any step | the Artifacts path, which runs beside it, finishes the import |

Bench: `tools/import-bench.mjs`, 3 runs of each repository, server-side timing, min, median and max.

## Findings

**Recommendation: use it for repositories up to 24 MiB and 40,000 objects, and keep Artifacts behind it.** A Worker asks for the head and has the pack in a median 0.8-2.6 s where Artifacts takes 3.5-4.6 s, and history records at 1,900-3,900 commits/s (406 for whisper), not 55. It is built behind `DIRECT_IMPORT`, on for dev. **Hosted numbers start at section 6**: this table is workerd on a Mac (2026-10-31) against real GitHub, with local R2 and Durable Objects, so R2 writes (200-1000 ms hosted, 1 ms here) and hosted CPU are not in it. All times are min / median / max of 3 runs, in ms.

| Repository | Pack, MiB | Objects | Raw, MiB | Commits (first parent) | Head asked and pack in | Request to main usable | History, commits/s | Wasm, MiB |
|---|---|---|---|---|---|---|---|---|
| spf13/pflag | 0.4 | 1,499 | 9.7 | 430 (233) | 627 / 786 / 1,041 | 978 / 1,263 / 1,461 | 2,913 / 3,530 / 3,820 | 21 |
| openai/whisper | 12.5 | 843 | 32.4 | 171 (169) | 1,442 / 2,611 / 3,635 | 2,126 / 3,230 / 4,423 | 322 / 406 / 471 | 38 |
| spf13/cobra | 2.0 | 4,557 | 31.1 | 1,106 (950) | 844 / 941 / 949 | 1,175 / 1,299 / 1,316 | 3,926 / 3,942 / 3,975 | 21 |
| pallets/flask | 12.0 | 26,239 | 173.6 | 5,566 (2,283) | 1,777 / 1,838 / 1,931 | 2,139 / 2,189 / 2,306 | 1,775 / 1,927 / 1,955 | 55 |
| expressjs/express | 9.5 | 32,561 | 152.5 | 6,183 (3,913) | 1,486 / 1,519 / 1,522 | 1,841 / 1,858 / 1,860 | 3,630 / 3,647 / 3,657 | 52 |

**Whisper misses the 3 s budget here**, at a median of 3.2 s: GitHub took 1.1-3.3 s for its 12.5 MiB, and hosted R2 will add to it. Its history rate is one read of that pack (0.3-0.5 s) over 169 commits. The usable column holds 0.3-0.5 s of the local create, the same on both paths.

Checked with real Git on what the platform served, during history and after it: `git index-pack`, `git fsck --connectivity-only` and `git rev-list` on pflag (430 commits) and flask (5,566) match GitHub. The recorded log equals `git rev-list --first-parent` (233 and 2,283), and each sampled commit's changes equal `git diff-tree -r --no-renames` against its first parent (233 and 153 commits, none different).

### 1. Can a Worker fetch it?

Yes: `ls-refs` with a ref prefix, so a large repository's pull refs never travel, then `fetch` for the one commit, the pack streaming into the session that a push uses and into R2. Indexing fits: flask's 26,239 objects hash in under 1 s of CPU here.

Memory is the limit, not time. Axios's 28 MiB pack held 93 MiB of Wasm in a fresh isolate, against 128 MB for everything, so the limit is **24 MiB**.

It is not a push, for three reasons:

- **Size.** A push stores every version of every file. Flask's 12 MiB pack is 173.6 MiB raw, 44 bundles, each an R2 write. Direct writes the head alone: 282 objects, 1.7 MiB.
- **Refusal.** The push path decodes trees strictly, and flask holds five old trees with mode `040000`, so its push would be refused. History now reads them as Git does (`decode_tree_loose`); new trees stay strict. A head tree that is not canonical is declined, as reads of it would fail.
- **Scanning.** A push refuses a file that looks like a credential. A public repository's test fixtures may hold one, and an import has never scanned.

### 2. Where is the limit?

| Rule | Checked | Cost of finding out |
|---|---|---|
| Over 40,000 objects | The pack's header, by the session | 0.7 s (svelte, vuejs/core) |
| Over 24 MiB | Bytes as they arrive | 3.1 s (axios) |
| Nothing in 20 s | The deadline | 20 s (torvalds/linux: no first byte) |

GitHub's API is not needed. Artifacts races beside the fetch, so a decline costs nothing but the bytes.

Large repositories need no container. Artifacts already imports them, and the import path does not change. A `PackBuilder` route would need an outbound `github.internal` handler (it has no internet) and would still store everything raw. **Its hosted cold start is not measured here**: `start_ms` in a pack-build report has it on dev. Locally the image's port is ready in 216-237 ms under emulation, which says nothing of a Cloudflare placement; the check container's hosted cold start was 110-180 s (2026-10-20). Svelte's 114 MiB pack takes 3.5-5.4 s to fetch from a Mac.

### 3. Does anything still need Artifacts?

**Yes.** An import records first parents only, and the walk behind a clone built from bundles drops any parent with no row (`RecordedGraph::parents`). So:

- A clone of the imported head is served from the stored pack, at once, at any depth and with any filter: the pack holds all of the history, so it can only give more than was asked. `--depth 1` is that clone with the head marked shallow, and the client keeps up to 24 MiB it did not need; a filter gets every file, as on the mirror. A deeper clone gets the whole history unmarked, because the commits at depth 5 need the graph no record holds yet. All of this was served by the mirror before, after Artifacts finished, which is what made `--depth 1` slower than a full clone.
- **Any other fetch** (after a push, by a client with some history, `--deepen`) still needs the mirror. It waits for Artifacts for up to 20 s, then is refused with nothing sent, saying how long it waited.
- **The head's commit is left out of the bundles on purpose**: `refuseMirrorOnly` reads "the oldest commit is in the store of record" as "the walk can serve this". Bundling it would send a client holding the head's first parent a pack without the merged branch.

Reads of older files wait for history, which waits for Artifacts: history starts only after the mirror holds it, so a recorded commit is always readable. The one gap is a read of the head commit's old side in the seconds before Artifacts finishes (NOT_FOUND).

**Retiring Artifacts** needs every commit recorded, not first parents: an authority change to the fill, and a way to build clones past the stored pack. Not attempted here.

### 4. Does history work from a pack?

Yes, and trees stop being the limit: they come from the pack's own bytes, so what remains is reading the pack once and one authority call per 250 commits. One Workflow step does it all, and a repeat is skipped by the authority. If the pack cannot be read, the waves read Artifacts as before. Output matches the wave path: same limit of 10,000 changed files, same `history_stopped`, and a rename is its delete and add.

### 5. Security

- **Host.** `githubRemote` accepts only `https://github.com/<owner>/<repo>[.git]` and rebuilds the URL from the two names. No user info, port, query, fragment or other path.
- **Redirects.** Every request uses `redirect: 'manual'`, and anything but a 200 with Git's content type declines.
- **Credentials.** None are sent, and no cookie. A private repository answers 401 and goes to Artifacts, which says why.
- **Limits.** 24 MiB, 40,000 objects, 100 MiB per file, 20 s.
- **Content.** Every object is hashed, the trailer is checked, and a pack missing a commit or tree of the head declines before main lands.
- **Refs.** A branch name outside a strict character set never reaches a pkt-line.

### 6. Where the seconds went

Dev at `c3bedf17`, 3 runs: the server landed cobra in 1.6-1.8 s and the client read its files at 5.1-5.9 s. Pflag, whisper and cobra all stayed at 4.7 s or more whatever the server did: whisper landed at 2.6 s and read at 4.7-5.4 s, and landed at 4.6 s and read at 5.4 s. So reading after landing took under 0.8 s, and the floor is something the client waits for before it can look.

Local bench: workerd on a Mac with real GitHub, the real Worker and Durable Objects, R2 delayed to match dev's `store_ms` (get 100 ms, put 400 ms, part 600 ms, complete 300 ms, each ±20%, the head holder's too), Artifacts faked over real Git.

| Suspect | Finding | Proved? |
|---|---|---|
| The first read of a new repository | 0.3 s | Locally |
| The head snapshot (`refreshHead`) | `head.fetch` 4 ms; no read waits for a refresh | Locally |
| The bench's poll | 0-0.5 s plus the request | Locally |
| `POST /repos/import` waiting for `PLATFORM_IMPORT.create` | With create delayed 4 s, the old code answers at 4.9 s, reads files 3.4-3.5 s after landing and is usable at 5.5-5.8 s: dev's shape. Undelayed locally it answers in 0.3 s | **Inferred for dev**: create's hosted time is not measured, and a slow Workflow `status()` on the bench's first look would look the same |

The Workflow is the one step left that only exists hosted, and both of its calls are now out of a reader's way. `Server-Timing` on the POST has `import.owner`, `name`, `init`, `branch`, `list`, `tokens` and `workflow`; the bench prints the answer, the poll, the first read and the slowest look; the Workflow's output has `workflow_ms`, and `import.workflow_created` logs create's own time.

What changed:

| Change | Local result |
|---|---|
| The POST keeps what starts the Workflow in R2 (`repo-import-start.ts`), and creates it behind the answer. A look at the import reads `queued` until it exists, and creates it again past 30 s. If the R2 put fails, the POST waits for create as before | With create delayed 4 s: answered in 0.5-0.8 s, was 4.9 s |
| `GET /import` waits at most 0.3 s for the Workflow's status | Slowest look 0.1-0.2 s |
| Listing the stored pack (`#keep`, 2 R2 calls) comes after main | Cobra stored in 0.45-0.48 s, was 0.91-0.97 s |
| The import starts before the D1 listing write | Hosted saving unmeasured; one write less before it |

**The pack itself still completes before main lands.** Letting it finish after would save at most the last part and the complete call on a multipart pack (0.5-0.8 s here), and a clone in that gap would meet the mirror's wait. A plain clone working the moment main does is worth more.

**Why flask stopped the bench.** The refusal was the bench's `--depth 1` clone, not the plain one, and the old message and bench did not say which. Locally, with Artifacts held at 40 s and the old code, the whole flask clone was served in 120 ms and the depth clone was refused at 20,009 ms with dev's exact message. Dev's Artifacts time for flask is not measured, so this cause is inferred for dev. Pack size, multipart and limits are ruled out: flask's and a 6 MiB test pack's multipart stores serve whole clones.

**Why `--depth 1` was slower than a full clone.** It alone waited for Artifacts to finish, then for Artifacts' pack: 2.1 s locally with Artifacts at 4 s, 5.5 s with Artifacts at 8 s, where the whole clone took 0.2 s. It now takes the stored pack, at the cost of the bytes (section 3).

Local, with the new code, Workflow create delayed 4 s (min / median / max, s). Flask and express ran with Artifacts held at 25 s, past the old refusal, the others at 4 s. GitHub answering a Mac costs 0.2 s to name its head where dev took 0.03 s, and more for the pack, so **`usable` here is not dev's**.

| Repository | Answered | Usable | Landed to files read | Stored | Our clone | `--depth 1` | History, commits/s |
|---|---|---|---|---|---|---|---|
| spf13/pflag | 0.7 / 0.7 / 0.7 | 1.8 / 1.8 / 2.5 | 0.3 / 0.5 / 1 | 0.36 / 0.44 / 0.47 | 0.2 / 0.2 / 0.2 | 0.2 / 0.2 / 0.2 | 589 / 607 / 611 |
| openai/whisper | 0.5 / 0.6 / 0.7 | 3.7 / 4.2 / 4.6 | 0.5 / 0.7 / 0.7 | 1.40 / 1.50 / 1.52 | 0.4 / 0.4 / 0.7 | 0.4 / 0.4 / 0.7 | 266 / 280 / 283 |
| spf13/cobra | 0.7 / 0.7 / 0.8 | 2.4 / 2.5 / 2.5 | 0.8 / 0.8 / 0.9 | 0.45 / 0.48 / 0.48 | 0.2 / 0.2 / 0.3 | 0.2 / 0.2 / 0.3 | 1,784 / 1,801 / 1,832 |
| pallets/flask | 0.7 / 0.8 / 0.8 | 4.5 / 4.5 / 4.5 | 0.7 / 0.8 / 0.8 | 1.20 / 1.31 / 1.32 | 0.5 / 0.5 / 0.5 | 0.5 / 0.5 / 0.5 | 1,514 / 1,578 / 1,580 |
| expressjs/express | 0.6 / 0.7 / 0.8 | 3.7 / 3.8 / 4.4 | 0.8 / 0.8 / 1 | 1.02 / 1.11 / 1.50 | 0.5 / 0.5 / 0.5 | 0.5 / 0.5 / 0.5 | 2,247 / 2,749 / 2,806 |

Every run's clones passed `git fsck --connectivity-only`, the whole clone's first-parent count equalled what was recorded, and each depth clone read as 1 commit.

### What can go wrong

| Case | What happens |
|---|---|
| Any failure before main lands | Nothing landed. Artifacts' path finishes the import |
| Artifacts' path lands first | The direct fetch finds it landed and stops |
| The remote moves between the two fetches, so the mirror is ahead of main | Main stays what was fetched, and the mirror is pushed back to it with the stored pack (`moveMirror`). **Not tried on real Artifacts: it may refuse that push, and the Workflow then errors with history ended at the head** |
| Artifacts refuses for good after main landed | History ends at the head with a note, the repository takes work, and the import reads as errored |
| The Worker dies after landing | The Workflow carries on from the head |
| Workflow create fails behind the answer, or the Worker dies first | Main still lands. The import reads `queued`, and a look at it past 30 s creates the Workflow from what R2 kept. **Nothing creates it until someone looks**; history waits until then |
| The pack is not listed after main lands | Nothing a reader sees; the pack is kept until the repository goes rather than evicted |

### Open

- Hosted usable time and hosted memory: the bench below. Whether repositories near 12 MiB are under 3 s on dev is not known: locally they are 3.7-4.6 s, with a Mac's GitHub in it.
- Which Workflow call was dev's floor: the bench's `answer_timing`, `import_look_s` and `workflow_ms` will say.
- Artifacts taking `moveMirror`'s non-fast-forward push.
- Anonymous fetches from Cloudflare's shared addresses may meet GitHub's limits; any refusal falls back.

### Bench on dev

Set `"DIRECT_IMPORT": "on"` in `infra/envs/dev.json`, run `cargo xtask infra gen --env dev`, deploy with `cargo xtask deploy --env dev`, then:

```sh
set -a; . <dev owner credentials>; set +a
node tools/import-bench.mjs --url https://dev.yonedarepo.com --git https://api.dev.yonedarepo.com \
  --repos spf13/pflag,openai/whisper,spf13/cobra,pallets/flask,expressjs/express --runs 3
```

Each repository prints who landed it (`direct`, `request` or `workflow`) and the direct stages. The bar is the budget above: under 3 s, against about 6 s today.
