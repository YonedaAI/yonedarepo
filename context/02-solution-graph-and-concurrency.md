# 02. Solution Graph, canonical data model, and concurrency

[Index](index.md) · [Previous](01-platform-vision.md) · [Next](03-smallest-prototype.md)

*Substantive turn 2 of 18, in original conversation order.*

## User

For the agentic repo model

*  Sketch the killer demo
*  Define the canonical data model
*  Design the concurrency model

## ChatGPT

For the repo platform, I’d make the central abstraction **not a repository, branch, or PR, but an immutable Solution Graph**.

#### 1. Killer demo: “10 agents, one feature, zero branches”

The demo needs to make GitHub suddenly feel like the wrong abstraction.

Give the system one requirement:

> “Add passkey authentication without breaking password authentication. Optimize for security, minimal complexity, and backwards compatibility.”

The platform decomposes that into a **task DAG**, then launches several agents concurrently:

```
                         INTENT
              "Add passkey authentication"
                           │
                           ▼
                     Planner DAG
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
     Architecture      Security         Existing-code
       analysis         analysis          analysis
          │                │                │
          └──────────┬─────┴─────┬──────────┘
                     │           │
                     ▼           ▼
                  Solution    Solution
                     A           B
                     │           │
              ┌──────┼─────┐     ├──────────┐
              ▼      ▼     ▼     ▼          ▼
            Agent  Agent  Agent Agent      Agent
              │      │     │     │          │
              ▼      ▼     ▼     ▼          ▼
             CS1    CS2   CS3   CS4        CS5
               \     |     /      \         /
                \    |    /        \       /
                 Evaluation         Evaluation
                     │                  │
                     └────────┬─────────┘
                              ▼
                       RECONCILIATION
                              │
                     synthesized CS6
                              │
                              ▼
                     CANONICAL STATE
```

And **while they're working**, the UI updates live.

The user sees something like:

```
┌─────────────────────────────────────────────────────────────┐
│ Add Passkey Authentication                     7 agents ●  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                         Goal                                │
│                          │                                  │
│          ┌───────────────┼───────────────┐                  │
│          │               │               │                  │
│      Approach A      Approach B      Approach C              │
│      WebAuthn lib    native impl     hybrid                 │
│          │               │               │                  │
│       3 agents         2 agents         2 agents             │
│          │               │               │                  │
│         91              87              96 ★                 │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ Winning solution C                                         │
│ Security       98                                          │
│ Tests          100%                                        │
│ Complexity     92                                          │
│ Performance    +1.8%                                       │
│ Files          14                                          │
│ Conflicts      2 → automatically reconciled                │
└─────────────────────────────────────────────────────────────┘
```

Then click **“Why C?”**

Not a PR.

You get the evidence:

```
C selected because:

✓ preserves existing password flow
✓ passes 184/184 tests
✓ eliminates replay vulnerability found in A
✓ 31% less code than B
✓ benchmark regression <2%
✓ security agent approved
✓ architecture constraints satisfied

Borrowed from A:
    credential migration strategy

Borrowed from B:
    WebAuthn validation tests

Original C:
    authentication adapter
```

That is the demo.

Then hit:

**Ship Solution**

One atomic CAS operation advances canonical repository state.

No PR was ever necessary.

---

### 2. Canonical data model

I would **not** literally make everything B-trees.

Use four primitives:

```
                AGENTIC REPOSITORY

          ┌─────────────────────────┐
          │      Context Graph      │
          │ intent / provenance /   │
          │ agents / decisions      │
          └────────────┬────────────┘
                       │
              ┌────────▼────────┐
              │ ChangeSet DAG   │
              │ history         │
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │ Persistent Tree │
              │ repository state│
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │ Object Store    │
              │ blobs/artifacts │
              └─────────────────┘
```

##### Repository

```
struct Repository {
    id: RepoId,

    canonical: SnapshotId,

    roots: Vec<IntentId>,

    policy: RepositoryPolicy,

    created_at: Timestamp,
}
```

Notice what's missing:

**branches aren't fundamental.**

A branch can exist as a compatibility projection.

---

##### Snapshot

This is immutable repository state.

```
struct Snapshot {
    id: SnapshotId,          // hash
    root: TreeNodeId,
    parents: Vec<SnapshotId>,
    changeset: ChangeSetId,
}
```

The ID should be content-addressed:

```
SnapshotId =
    hash(
        root_tree +
        parent_snapshots +
        changeset
    )
```

Snapshots therefore form the immutable history DAG.

---

### 3. Persistent tree

I would actually consider a **Merkle B+ tree**, rather than Git's current directory-tree representation.

```
                     ROOT
                  hash: A91F
                 /         \
                /           \
             src/           tests/
              │                │
        ┌─────┼─────┐      ┌───┴────┐
        │     │     │      │        │
      auth  api   user    auth     api
       │     │      │      │        │
      H1     H2     H3     H4       H5
```

Agent changes auth.ts.

Copy-on-write produces:

```
OLD                             NEW

       R1                              R2
      /  \                            /  \
     A    B                          A'   B
    /|\                             /|\
   X Y Z                           X Y Z'

              B, X, Y shared
```

So creating 100 agent snapshots remains cheap.

This gives you both:

**Merkle properties**

```
content addressing
integrity
deduplication
fast equality
```

and **B+ tree properties**

```
ordered traversal
prefix lookup
range scans
huge repositories
incremental persistence
```

---

### 4. ChangeSet becomes the atomic unit

This is arguably the most important structure.

```
struct ChangeSet {
    id: ChangeSetId,

    intent: IntentId,
    task: TaskId,

    base: SnapshotId,
    result: SnapshotId,

    agent: AgentExecutionId,

    operations: Vec<Operation>,

    dependencies: Vec<ChangeSetId>,

    evidence: Vec<ArtifactId>,

    evaluations: Vec<EvaluationId>,

    status: ChangeSetStatus,
}
```

And don't merely store patches.

Store **operations**:

```
enum Operation {
    Create(Path, BlobId),

    Delete(Path),

    Replace {
        path: Path,
        old: BlobId,
        new: BlobId,
    },

    Move {
        from: Path,
        to: Path,
    },

    SymbolChange {
        symbol: SymbolId,
        before: BlobId,
        after: BlobId,
    },
}
```

That gives the reconciliation engine much more information than textual patches.

---

### 5. Intent is first-class

Git records:

> Matthew changed lines 52–87.

The new system records:

> These lines exist because task T17 implements requirement R4 of intent I381.

```
struct Intent {
    id: IntentId,

    prompt: String,

    constraints: Vec<Constraint>,

    acceptance_criteria: Vec<Criterion>,

    parent: Option<IntentId>,

    task_graph: TaskGraphId,
}
```

Then:

```
Intent
   ↓
Task
   ↓
AgentExecution
   ↓
ChangeSet
   ↓
Snapshot
   ↓
Blob/Symbol
```

Every byte can have provenance.

---

### 6. Task DAG

This is where your DAG-runtime thinking fits almost perfectly.

```
struct Task {
    id: TaskId,

    intent: IntentId,

    dependencies: Vec<TaskId>,

    inputs: Vec<Resource>,

    expected_outputs: Vec<OutputSpec>,

    constraints: Vec<Constraint>,

    execution_policy: ExecutionPolicy,
}
```

For example:

```
                    AUTH-381
                       │
              analyze architecture
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       WebAuthn     security     migration
          │            │            │
          └────────────┼────────────┘
                       ▼
                   implement
                 /      |      \
                A       B       C
                 \      |      /
                  evaluation
                       │
                  reconciliation
                       │
                     ship
```

The **task DAG and repository DAG are different graphs**.

That's important.

Task DAG:

> what should happen?

ChangeSet DAG:

> what actually happened?

---

### 7. AgentExecution

Preserve the environment that created the code.

```
struct AgentExecution {
    id: AgentExecutionId,

    agent: AgentIdentity,

    model: ModelIdentity,

    task: TaskId,

    base_snapshot: SnapshotId,

    context_manifest: ContextManifestId,

    tool_events: Vec<EventId>,

    started_at: Timestamp,
    completed_at: Timestamp,

    output_changesets: Vec<ChangeSetId>,
}
```

But don't dump millions of tokens directly into repository metadata.

Store a **context manifest**:

```
ContextManifest
 ├── system instructions hash
 ├── user intent hash
 ├── files read
 ├── symbols inspected
 ├── docs retrieved
 ├── previous agent outputs
 ├── tool calls
 └── model/version
```

Large artifacts go into object storage.

---

### 8. The concurrency model

This is where I'd depart significantly from Git.

Agents **never write canonical state directly**.

The rule is:

> **Many speculative writers. One canonicalizer.**

Suppose:

```
Canonical snapshot = S100
```

Ten agents begin:

```
                  S100
        ┌──────────┼──────────┐
        ↓          ↓          ↓
       A1         A2         A3
        │          │          │
      S101a      S101b      S101c
```

There is absolutely no lock here.

Agents work against immutable snapshots.

That's essentially MVCC.

---

### 9. Optimistic concurrency everywhere

An agent proposes:

```
Proposal {
    base: S100
    result: S101a
}
```

Meanwhile another ChangeSet ships:

```
S100 → S101
```

The first agent finishes.

Canonicalizer performs:

```
expected_base = S100
current       = S101
```

Mismatch.

But don't immediately call that a conflict.

Run **impact analysis**.

If:

```
Agent A changed:

src/auth/passkey.ts

Canonical change touched:

src/billing/invoice.ts
```

then the system can automatically transplant/rebase A.

```
S100 ────── S101
  \
   \ A
    S101a

becomes

S100 ────── S101 ────── S102
                         ↑
                    rebased A
```

---

### 10. Conflict detection should have levels

Don't define conflict as:

> same line changed.

Use progressively stronger detection:

```
L0   Blob conflict
     same bytes

L1   Path conflict
     same file

L2   Symbol conflict
     same function/class/interface

L3   Dependency conflict
     A changes API consumed by B

L4   Semantic conflict
     logically incompatible behavior

L5   Intent conflict
     agents are satisfying incompatible requirements
```

This becomes a major differentiator.

Two agents can modify the same file without conflicting.

Two agents can modify completely different files and **still conflict semantically**.

Git is almost blind to that.

---

### 11. Leases, not locks

There are places where speculation is wasteful.

For example:

```
database schema
dependency lockfile
generated API
migration numbering
```

Use optional scoped leases:

```
Lease {
    resource: ResourceSelector,
    owner: AgentExecutionId,
    expires_at: Timestamp,
    mode: LeaseMode,
}
```

Possible resources:

```
/path/package-lock.json

/symbol/AuthProvider

/schema/users

/api/auth/*

/migration-sequence
```

But leases are advisory scheduling mechanisms.

They don't define repository correctness.

---

### 12. One canonical writer

I'd use a Durable Object per repository or repository partition as the **serialization authority**.

Conceptually:

```
Agents
  │
  ├─────────┐
  │         │
  ▼         ▼
proposal   proposal
  │         │
  └────┬────┘
       ▼
 Repository
 Coordinator
 Durable Object
       │
       │ CAS
       ▼
 canonical_root
```

Shipping becomes approximately:

```
compare_and_swap(
    expected_snapshot,
    proposed_snapshot
)
```

That tiny operation is the only place requiring serialization.

Everything expensive happens outside it:

```
coding
testing
building
benchmarking
review
AI evaluation
security analysis
reconciliation
```

Therefore 1,000 agents can theoretically speculate concurrently while the authoritative mutation surface remains tiny.

---

### 13. Reconciliation is itself an agent operation

This is important architecturally.

Don't hide automatic merging.

Create another ChangeSet:

```
CS-101    Agent A
CS-102    Agent B
   \        /
    \      /
     CS-108
     reconciliation
```

CS-108 records:

```
inputs:
    CS-101
    CS-102

conflicts:
    AuthProvider.authenticate()

resolution:
    retained A's retry behavior
    retained B's configurable policy

evidence:
    test-suite-9821
    benchmark-882
    security-review-29
```

Therefore **even AI merge decisions have provenance**.

---

### 14. Cloudflare implementation

I'd make the deployment something like:

```
                     Browser
                        │
                 Cloudflare Worker
                        │
             ┌──────────┼───────────┐
             │          │           │
             ▼          ▼           ▼
         Repo DO     Task DO     Live DO
             │          │           │
             └──────────┼───────────┘
                        │
              Agent orchestration
                        │
          ┌─────────────┼──────────────┐
          ▼             ▼              ▼
       Agent A        Agent B         Agent C
          │             │              │
          └─────────────┼──────────────┘
                        ▼
                    Queues
                        │
                 Evaluators
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
       R2              D1             Artifacts
     objects          index           builds/tests
```

R2 becomes the content-addressed backing store.

Something like:

```
/objects/blake3/ab/cdef...
/trees/blake3/13/...
/snapshots/...
/contexts/...
/artifacts/...
```

I'd probably use **BLAKE3 internally** unless interoperability requirements pushed SHA-256.

---

### 15. The product's primitive

I'd give the abstraction a name rather than calling it a PR.

Maybe:

**Workspace → Exploration → Decision**

or simply:

**Run**

A Run is:

```
Run
│
├── Intent
│
├── Task DAG
│
├── Explorations
│    ├── Solution A
│    ├── Solution B
│    └── Solution C
│
├── Evidence
│
├── Reconciliation
│
└── Decision
```

And the home screen isn't:

```
Repositories
Issues
Pull Requests
Actions
```

It's closer to:

```
┌──────────────────────────────────────────────────────────┐
│ YonedaCode                                               │
├────────────┬─────────────────────────────────────────────┤
│            │                                             │
│ Intent     │  Implement distributed cache                │
│            │                                             │
│ Explore    │       A────A1────A2      87                 │
│            │      /                                      │
│ Agents  12 │ Goal──B────B1────B2────B3  ★ 96            │
│            │      \                                      │
│ Evidence   │       C────C1          79                   │
│            │                                             │
│ Decisions  │  12 agents · 37 changesets · 4m 21s        │
│            │                                             │
│ History    │  [Compare solutions]     [Ship B]           │
└────────────┴─────────────────────────────────────────────┘
```

That's the piece I think could make the Cloudflare submission memorable:

**Don't demonstrate agents committing faster. Demonstrate that branches, PRs, and line-oriented merge conflicts stop being the right abstractions once software development becomes massively parallel.**

The architecture underneath becomes:

> **Merkle B+ Tree for state + ChangeSet DAG for history + Task DAG for computation + Context Graph for provenance + CAS canonicalization for concurrency.**

That is a coherent new source-control model rather than GitHub with agents bolted onto it.
