# Market findings: Entire and others in the space

Researched 2026-11-02 from public sources, linked at the end. Where only one source says something, it says so.

## Next steps

1. Turn on prod analytics (`docs/analytics-plan.md`, phases 1 and 2), so usage and Landing outcomes are counted.
2. Run forgemark, Entire's open-source benchmark, against YonedaRepo and publish the result.
3. Rerun the 1,000-writer burst and write it up as one post: many agents pushing to one repository at once.
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
| **1,000 agents pushing to one repository at once** | The burst test exists; numbers need a fresh run |
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

"Newer technology" is a claim until it's measured: forgemark (next step 2) settles it.

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
