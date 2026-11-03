# Market findings: Entire and others in the space

Researched 2026-11-02 from public sources, linked at the end. Where only one source says something, it says so.

**Positioning (owner, 2026-11-02): YonedaRepo refactors Git.** The comparison is plain Git, not Entire or any other company. Entire is here as research only.

## Next steps

1. Turn on prod analytics (`docs/analytics-plan.md`, phases 1 and 2), so usage and Landing outcomes are counted.
2. Measure plain Git against YonedaRepo on the same test: 1,000 writers pushing to one branch of a stock Git server with fetch, rebase and retry, against 1,000 on YonedaRepo. Count retries and the time until all 1,000 have landed.
3. Write up the home page's "One branch. A thousand writers. No retries." as one post, with a fresh 3-run measure through `git push`. Today's 1,000 of 1,000 (2026-10-30) went through the API.
4. Ship a free first step that works with GitHub, as Entire did: for example, `yoneda` importing a GitHub repository in one command so agents have somewhere to push.
5. Line up 5 teams running agents as design partners, and quote them.
6. Launch on Show HN and in the Cloudflare developer community. Check whether Workers Launchpad has a cohort open.
7. Raise with the benchmark, the usage numbers and the 5 teams in the deck. Target: about $2.5M to grow in the EU and US.

## Entire

| Fact | Detail |
|---|---|
| Founder | Thomas Dohmke, GitHub CEO until August 2025 |
| Round | $60M seed at a $300M valuation, led by Felicis, with Madrona, M12 and Basis Set. Felicis calls it the largest seed ever for a developer tools company |
| Announced | 2026-02-10 |
| Team | About 15, planning about 30 |
| First product | Checkpoints: an MIT-licensed CLI that saves each agent session (transcript, prompts, tool calls) next to the commit, on a separate branch |
| Product now | "The Git forge for agent-human collaboration": Trails in place of pull requests, and hosting regions in India, Australia, the EU and the US |

### How Entire markets

| Move | What they do |
|---|---|
| Famous founder | The ex-GitHub CEO gets press for every step |
| The raise as news | "Largest seed ever" was the launch headline |
| Free open-source first step | Checkpoints works alongside GitHub, so trying it costs nothing |
| A movement, not a product | "Source Control is at a Breaking Point", "Join the rebels" |
| Its own benchmark as proof | Pushes "89× faster" than GitHub, measured with its own open-source forgemark |
| Newsletter as waitlist | "Join the rebellion" for early access |
| Side projects in the open | forgemark, entire-graph, entire-brain |
| No pricing, no customer logos | Only "Get Started" |

What YonedaRepo can copy: the free first step, a published benchmark, and the movement tone. The founder fame and the $60M can't be copied.

### Entire and training data

Entire is not collecting agent sessions to train models. Dohmke told Axios: "We are not training models or building agents, we are integrating with them." Checkpoint data lives in the customer's own git history. One report says Entire copies it to its database only to display it. Its investor's write-up presents sessions as a tool for replaying and auditing work, and says nothing about data or moats. The stated next step is a "semantic reasoning layer" that coordinates agents.

## Others

| Company | What we know |
|---|---|
| Graphite | Code review. Cursor agreed to buy it on 2025-12-19. Axios reported the price was "way over" its last valuation of $290M |
| Cursor | Bought four companies in the second half of 2025. One report says it's launching Origin, its own git hosting, in autumn 2026. Only one source |
| GitButler | Version control for AI workflows. No marketing or funding detail found |

## Where YonedaRepo can stand apart

| Possible claim | Today |
|---|---|
| **1,000 agents on one branch, all landed first time** | On the home page. Measured 2026-10-30: 1,000 of 1,000 landed, 168–424 landings/s, through the API from the bench Worker. Plain Git's 1 of 1,000 follows from its rules, not a run |
| **Built on Cloudflare: no servers, nothing to pay while idle** | True today |
| **Outcome data from Landings** | Flight Path records what an agent changed, which checks ran, what review found, and whether it landed |
| Code kept in the EU | Built on `claude/global`, not switched on. Entire already offers an EU region, so this is not unique |

Recommended pitch: the 1,000-agent claim plus Built on Cloudflare. The likeliest buyer is probably Cloudflare, since YonedaRepo runs on Workers, Durable Objects, R2 and Containers. That is a judgement, not something researched.

### Outcome data

Agent transcripts alone are common: Anthropic, OpenAI and Cursor see every session in their own tools. What YonedaRepo holds that they don't is outcomes: which agent work survived tests and review, and which was refused. Labelled outcomes are worth more than raw transcripts.

A team buying a code platform asks first whether it trains on their code. Entire answers no. The version that keeps those deals:

1. Customer data stays the customer's by default.
2. Customers opt in to share outcome data, in return for credits or a benchmark report on their own agents.
3. YonedaRepo publishes aggregate findings, such as which agents land the most code. That is marketing and data at once.

"Newer technology" is shown against plain Git (next step 2), not against another product.

## Git, transactional

Git's storage, history and the `git` command stay. What changes is the write: every landing is a transaction on a log, merged on the server, so concurrent writers never collide.

A stock `git push` straight to a branch someone else just moved is still refused, by the Git client itself, before anything is sent. The server merge happens when work lands: from a pushed branch, or through the `yoneda` CLI, MCP or the API.

| | Plain Git | YonedaRepo |
|---|---|---|
| Objects, history, `git clone`, `git push` | Git | Same: stock Git works unchanged |
| A write | Moves the branch only if nobody moved it first | A transaction: logged, ordered, all or nothing |
| Two writers at once | One wins; the other fetches, rebases and retries | Both land, merged on the server with Git's three-way merge (`yoneda-core/src/merge.rs`, line-level diff3) |
| Conflicts | Found by each client, one at a time | Decided once, in order, on the server |
| History of writes | Commit history | A transaction log of every landing, with the agent session that made it |

Taglines that keep "no new client":

1. **Git, transactional.**
2. **Same Git. Writes that never collide.**
3. **Git where every push is a transaction.**

## Novelty and prior art

Searched 2026-11-02: papers, patents and other Git servers. Two passes of web search, not a patent attorney's search.

**Credit rule (owner, 2026-11-02):** prior art is cited in a research paper only, never on marketing pages.

### What is new

No system found does all of these together:

1. Landing work from stock Git, merged on the server with **content-level** three-way merge, so two writers editing different lines of one file both land.
2. A transaction log as the repository's authority, with the agent session recorded on each write.
3. Measured for agents: 1,000 writers on one branch, 1,000 landed.

Safe to say publicly: "Git, transactional" and "a new way to write to Git". "First" needs a patent search first.

### How conflicts are handled

Each landing is one transaction: a compare-and-swap on the branch, one hash-chained log entry and the landing record, all or nothing (`repo_store/land.rs`). Busy branches land in batches of up to 256 as one merge commit. When the branch moved since the writer's base, the log decides (`yoneda-core/src/txlog/occ.rs`):

| Since the writer's base | Outcome |
|---|---|
| Nothing moved | Compare-and-swap |
| Others wrote other files | Merge commit on the server, then combined checks |
| Others wrote the same files, nothing this writer read | Three-way line merge; overlapping lines are a conflict |
| Others wrote something this writer read (a file, or a symbol `path#symbol`) | Refused as a stale read: reconcile and check again |

The read check is what stops write skew, where two landings each pass alone and go wrong together: 6,441 to 8,001 log entries checked per run, 0 found.

### Closest prior art, for the research paper

| Work | What it does | How YonedaRepo differs |
|---|---|---|
| **Meta's Mononoke pushrebase** (Sapling server) | Takes stock `git push` over smart HTTP and, on configured branches, rebases the push onto the latest bookmark on the server. Bookmark update and update-log record commit atomically | **Closest.** Rebases only when changed paths don't overlap: two commits touching the same file conflict even on different lines, and the client must retry. Retries up to about 100 times on races. Built for Meta's monorepo, not offered as hosting |
| Mercurial pushrebase extension | Server-side rebase of pushed commits, opt-in with `hg push --onto` | Mercurial, not Git |
| Gerrit "Rebase If Necessary" | Rebases a change on submit | On review submit, not on push |
| GitHub merge queue, GitLab merge trains | Queue changes and test each against those ahead | A queue in front of the branch: writers wait their turn |
| Git servers on Cloudflare Durable Objects: dgit, Gitflare, chr33s/git, alchemy/Git | One Durable Object per repository, SQLite refs and objects, R2 for packs | Same layout, so "a repository per Durable Object" isn't new. None found merges concurrent pushes |
| CoAgent (arXiv 2606.15376) | Optimistic concurrency control for multi-agent systems | Theory for agents in general; notes `git merge` catches only textual conflicts |
| Multi-agent concurrency position paper (arXiv 2608.18092) | Argues multi-agent systems need concurrency control; cites Git branches and merges | Position, no system |
| Agent pull request conflict study (arXiv 2607.04697) | Replays three-way merges: concurrent agent PRs collide often | Evidence for the problem; proposes no server protocol |
| US patent 11914571, optimistic concurrency for a multi-writer database | Writes succeed unless a conflict is found at a log-based store | A database, not Git |

Not yet checked: Google Patents and USPTO searches for "server-side merge on push", Gitaly's server-side merge calls, Jujutsu's operation log, Pijul, Dolt.

## Sources

- [TechCrunch: Entire's $60M seed at $300M](https://techcrunch.com/2026/02/10/former-github-ceo-raises-record-60m-dev-tool-seed-round-at-300m-valuation/)
- [Axios: former GitHub CEO launches AI coding startup](https://www.axios.com/2026/02/10/former-github-ceo-ai-coding-startup)
- [Entire: $60M seed announcement](https://entire.io/news/former-github-ceo-thomas-dohmke-raises-60-million-seed-round)
- [Entire homepage](https://entire.com/)
- [Entire blog: the CLI](https://entire.io/blog/the-entire-cli-how-it-works-and-where-its-headed)
- [Dohmke on X: launch post](https://x.com/ashtom/status/2021255786966708280)
- [Pure AI: Entire launch](https://pureai.com/articles/2026/02/10/dohmke-launches-startup.aspx)
- [RCP Mag: Entire's git-compatible database](https://rcpmag.com/articles/2026/02/12/ex-github-ceo-thomas-dohmke-unveils-entire.aspx)
- [The New Stack: Dohmke interview](https://thenewstack.io/thomas-dohmke-interview-entire/)
- [Basis Set: Entire's $60M seed](https://basisset.com/insights/entires-60m-seed-and-the-future-of-agentic-development)
- [36Kr: Entire records thought processes in Git](https://eu.36kr.com/en/p/3678623948366473)
- [Ry Walker: Entire research](https://rywalker.com/research/entire)
- [Fortune: Cursor buys Graphite](https://fortune.com/2025/12/19/cursor-ai-coding-startup-graphite-competition-heats-up/)
- [Yahoo Finance: Cursor–Graphite deal](https://finance.yahoo.com/news/cursor-continues-acquisition-spree-graphite-215122810.html)
- [Graphite joins Cursor](https://graphite.com/blog/graphite-joins-cursor)
- [Dealroom: Cursor Origin](https://app.dealroom.co/news/note/cursor-launches-origin-its-own-code-hosting-and-git-platform)
- [TechNews: Cursor's four acquisitions in H2 2025](https://finance.technews.tw/2026/01/04/cursor-acquires-four-companies-in-h2-2025/)
- [The Consensus: GitButler](https://theconsensus.dev/company/gitbutler.html)
- [Mononoke docs (Sapling)](https://github.com/facebook/sapling/tree/main/eden/mononoke/docs)
- [Mononoke pushrebase doc](https://raw.githubusercontent.com/facebook/sapling/main/eden/mononoke/docs/4.1-pushrebase.md)
- [Mononoke Git support doc](https://raw.githubusercontent.com/facebook/sapling/main/eden/mononoke/docs/5.1-git-support.md)
- [Sapling's server, Mononoke](https://github.com/facebook/sapling/blob/main/eden/mononoke/README.md)
- [Mercurial pushrebase extension](https://reviewboard.mozilla.org/r/37317/diff/)
- [Gerrit: Rebase If Necessary](https://opendev.org/opendev/gerrit/commit/00aa4f05ee0f56f9548b17781f527a0a1307edee)
- [Gerrit: submit strategies](https://gerrit.googlesource.com/gerrit/+/d736da341fe1041e879165b0c78177eab9ceed24%5E%21)
- [GitLab merge trains](https://docs.gitlab.com/ee/ci/pipelines/merge_trains.html)
- [Graphite: merge queue comparison](https://graphite.com/guides/merge-queue-comparison-github-gitlab-graphite)
- [GitLab merge-train: pull with merge on failed push](https://gitlab.com/gitlab-org/merge-train/-/merge_requests/47)
- [dgit](https://github.com/littledivy/dgit/wiki)
- [Gitflare](https://www.mintlify.com/mdhruvil/gitflare)
- [chr33s/git](https://github.com/chr33s/git)
- [alchemy Git](https://alchemy.run/git)
- [CoAgent, arXiv 2606.15376](https://arxiv.org/html/2606.15376)
- [Multi-agent concurrency position paper, arXiv 2608.18092](https://arxiv.org/html/2608.18092v1)
- [Agent pull request conflicts, arXiv 2607.04697](https://arxiv.org/html/2607.04697v2)
- [US patent 11914571](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11914571)
