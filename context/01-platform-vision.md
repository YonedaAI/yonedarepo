# 01. Platform vision: state, history, and Context Graph

[Index](index.md) · [Next](02-solution-graph-and-concurrency.md)

*Substantive turn 1 of 18, in original conversation order.*

## User

Build the next Git platform on Cloudflare

We want you to build your vision for the Git platform of the agentic era using Cloudflare Workers and Artifacts.

You could rethink repositories, branches, pull requests, worktrees, code review, and merge conflicts — or build new ways to preserve agent context, compare multiple changes at the same time, and decide which one should ship.

We aren’t looking for GitHub as it exists today with agents added on top. At a minimum, we want to see multiple agents working on changes concurrently. Beyond that, we want you to get creative — what you think comes next.


What would that look like? Btree + dag+ ???

## ChatGPT

Yes. I’d go below the GitHub abstraction and ask: **what is the correct data model when the primary producer of code is no longer one human working on one branch, but 5–100 agents exploring a solution space concurrently?**

The answer probably looks like:

**B+ tree + content-addressed object store + immutable DAG + provenance graph + ephemeral worktrees + semantic/intent layer.**

### The core architecture

```
                         ┌──────────────────────┐
                         │      Intent / Goal   │
                         │ "Implement feature X"│
                         └──────────┬───────────┘
                                    │
                             Task / Plan DAG
                                    │
                 ┌──────────────────┼──────────────────┐
                 ▼                  ▼                  ▼
             Agent A            Agent B            Agent C
            approach A         approach B         approach C
                 │                  │                  │
          ephemeral WT       ephemeral WT       ephemeral WT
                 │                  │                  │
                 ▼                  ▼                  ▼
           ChangeSet DAG      ChangeSet DAG      ChangeSet DAG
                 └──────────────────┼──────────────────┘
                                    │
                            Evaluation Layer
                      tests / review / AI judges
                       benchmarks / constraints
                                    │
                                    ▼
                           Winning ChangeSet
                                    │
                                    ▼
                              Canonical DAG
```

Git already has part of the right primitive: **content-addressed immutable objects forming a DAG**. I wouldn't throw that away. I'd make it much more explicit and stop treating the *branch* as the fundamental unit.

The fundamental object becomes a **ChangeSet**.

```
ChangeSet
 ├── id: hash
 ├── parent ChangeSet(s)
 ├── base snapshot
 ├── changed objects
 ├── agent
 ├── task
 ├── intent
 ├── prompt/context hash
 ├── tool calls
 ├── dependencies
 ├── test results
 ├── evaluation scores
 ├── provenance
 └── merge/reconciliation decisions
```

So instead of:

> branch → commits → PR → merge

you get:

> **intent → task DAG → parallel ChangeSets → evaluation → reconciliation → accepted state**

That is a much more agent-native model.

### Where the B+ tree comes in

I would separate **history** from **state**.

The DAG answers:

> How did we get here?

The B+ tree answers:

> What is here right now?

Imagine every repository state represented by a persistent copy-on-write B+ tree:

```
Root
 │
 ├── /src
 │    ├── auth.ts       → blob hash
 │    ├── users.ts      → blob hash
 │    └── billing.ts    → blob hash
 │
 ├── /tests
 │    └── ...
 │
 └── package.json       → blob hash
```

Changing one file doesn't conceptually create another giant repository snapshot. You copy the affected path through the persistent tree and reuse everything else.

```
Snapshot A                    Snapshot B

      R1                           R2
     /  \                         /  \
    A    B                       A    B'
        / \                          / \
       C   D                        C   D'

shared ────────────────────────►
```

That gives you cheap immutable snapshots, structural sharing, range/prefix queries, and extremely cheap agent forks.

### But I'd add a third structure

This is where I think the project becomes interesting.

**B+ tree = state**

**DAG = history/computation**

**Graph = meaning/provenance**

Call the third layer the **Context Graph**.

```
                 requirement
                     │
                     ▼
                   task
                 /  │  \
                /   │   \
             agent agent agent
               │     │     │
               ▼     ▼     ▼
             CS-17 CS-18 CS-19
               │     │     │
               ├─────┼─────┤
               ▼     ▼     ▼
             symbols / files
                 │
                 ▼
               tests
                 │
                 ▼
             benchmark
                 │
                 ▼
              decision
```

Now the platform can answer questions Git cannot answer:

> Why does this line exist?

> Which agent produced it?

> What requirement caused it?

> What context did the agent see?

> What alternatives were attempted?

> Why was approach B rejected?

> Which tests justified selecting approach C?

> What other ChangeSets modify this symbol?

> What assumptions become invalid if I change this API?

That's the **agentic Git platform**.

### Kill the Pull Request

I'd make the biggest UX departure here.

A PR is fundamentally designed around:

```
human
  ↓
branch
  ↓
diff
  ↓
humans review
  ↓
merge
```

Instead have a **Decision Space**.

Suppose five agents implement the same feature.

```
                FEATURE #381
                     │
        ┌────────────┼─────────────┐
        ▼            ▼             ▼
   Approach A    Approach B    Approach C
   14 files      8 files       11 files
   +421 LOC       +190 LOC       +260 LOC

   tests 100%     tests 100%      tests 100%
   perf +3%       perf +17%       perf +12%
   risk MED       risk LOW        risk LOW
   complexity 7   complexity 3    complexity 4

        └────────────┬─────────────┘
                     ▼
              Reconciliation Agent
                     │
             ┌───────┴────────┐
             ▼                ▼
          choose B        synthesize B+C
```

The UI isn't primarily a diff anymore.

It's an **exploration tree**.

```
Goal
│
├── Solution A
│   ├── implementation
│   ├── evidence
│   └── evaluation
│
├── Solution B ★
│   ├── implementation
│   ├── evidence
│   └── evaluation
│
└── Solution C
    ├── implementation
    ├── evidence
    └── evaluation
```

You can still drill down to traditional diffs, but the first question changes from **"what changed?"** to **"which solution should become reality, and why?"**

### Merge conflicts become reconciliation

This is another place I'd abandon Git's mental model.

A text conflict:

```
<<<<<<< agent-a
retry(3)
=======
retry(config.maxRetries)
>>>>>>> agent-b
```

throws away almost all the useful information.

Your system knows:

```
Agent A intent:
"prevent transient API failures"

Agent B intent:
"make retry behavior configurable"

A tests:
✓ timeout
✓ 503 recovery

B tests:
✓ configuration
✓ timeout
✓ 503 recovery
```

The platform can construct:

```
retry(config.maxRetries ?? 3)
```

and explain:

> Synthesized A's safe default with B's configurability; all relevant tests pass.

So you get **semantic reconciliation**, with the resolution itself becoming another immutable ChangeSet in the DAG.

### Cloudflare actually fits this unusually well

I'd roughly map the platform as:

```
Cloudflare Workers
    │
    ├── API / orchestration
    ├── agent scheduling
    └── evaluation coordination
           │
           ▼
     Durable Objects
           │
           ├── repository coordinator
           ├── task coordinator
           └── concurrency/locking
           
R2
 └── immutable blobs / snapshots / artifacts

D1
 └── metadata + searchable indexes

Queues
 └── agent jobs / evaluation / reconciliation

Workers AI
 └── semantic review / intent / reconciliation

Artifacts
 └── builds, test output, agent output,
     previews, reports, evidence
```

And critically, I would make **Git an interoperability protocol**, not the internal database.

```
          git clone / push
                │
                ▼
        Git compatibility layer
                │
                ▼
┌─────────────────────────────────┐
│         Agentic Repo Engine     │
│                                 │
│  Persistent B+ Tree             │
│       +                         │
│  Immutable ChangeSet DAG        │
│       +                         │
│  Context / Provenance Graph     │
│       +                         │
│  Artifact / Evidence Store      │
└─────────────────────────────────┘
```

Existing developers can still:

```
git clone
git checkout
git commit
git push
```

But internally you've built something much richer.

### The really novel concept: repository as computation

This connects strongly with the DAG orchestration architecture you've been thinking about.

Don't model a repo merely as **files with history**.

Model it as a continuously evolving **computation graph**:

```
Intent
  ↓
Plan
  ↓
Task DAG
  ↓
Agent executions
  ↓
ChangeSets
  ↓
Artifacts
  ↓
Evaluations
  ↓
Decisions
  ↓
Repository state
  ↓
new Intent...
```

Then an agent run isn't external CI metadata. **It is part of repository history.**

A future agent can traverse:

```
code
 ↓
ChangeSet
 ↓
task
 ↓
conversation/context
 ↓
decision
 ↓
alternative implementations
 ↓
evaluation evidence
```

That solves one of the enormous problems we're about to have with coding agents: **agents currently produce code, but we discard most of the reasoning environment that produced it.**

I'd summarize the underlying primitive as:

> **Persistent tree + ChangeSet DAG + Context Graph + Artifact Store.**

Or, more conceptually:

> **State + History + Intent + Evidence.**

That feels much closer to a genuine **post-Git platform** than "GitHub with an AI agent button." And the killer demo would be 10 agents simultaneously attacking one feature, producing a visible solution tree, automatically evaluating competing implementations, semantically reconciling the best pieces, and preserving the entire decision lineage—not merely showing ten branches.
