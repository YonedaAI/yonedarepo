# 04. Cloudflare platform mapping

[Index](index.md) · [Previous](03-smallest-prototype.md) · [Next](05-rust-system-design.md)

*Substantive turn 4 of 18, in original conversation order.*

## User

Implemented on Cloudflare

## ChatGPT

Yes — if the constraint is **implemented on Cloudflare**, I'd make the prototype aggressively small. Don't build a Git hosting service. Build the minimum system that proves **parallel agent exploration → immutable competing states → evidence → reconciliation → atomic selection**.

#### MVP thesis

The entire prototype needs to prove one thing:

> **One intent can fork into multiple concurrent agent solutions, each producing an immutable repository state, and the platform can evaluate/reconcile those solutions into one canonical state without conventional branches or PRs.**

Everything that doesn't strengthen that demo gets deferred.

##### Minimal architecture

```
                         Cloudflare
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│                         Worker API                           │
│                             │                                │
│              ┌──────────────┼──────────────┐                 │
│              │              │              │                 │
│              ▼              ▼              ▼                 │
│         Repository DO    Run DO         WebSocket/SSE        │
│              │              │                                │
│              │         Task DAG                              │
│              │              │                                │
│              │      ┌───────┼───────┐                        │
│              │      ▼       ▼       ▼                        │
│              │     A1      A2      A3                        │
│              │      │       │       │                        │
│              │      ▼       ▼       ▼                        │
│              │     CS1     CS2     CS3                       │
│              │       \      │      /                         │
│              │        Evaluation                             │
│              │             │                                 │
│              │        Reconciliation                         │
│              │             │                                 │
│              └─────────────▼                                 │
│                       CAS → HEAD                             │
│                                                              │
│ R2                    D1                    Artifacts          │
│ blobs/trees       searchable metadata     tests/builds       │
└──────────────────────────────────────────────────────────────┘
```

I'd implement only **six real primitives**.

#### 1. Blob

Start here.

```
type BlobId = string;

interface Blob {
  id: BlobId;          // hash(content)
  size: number;
  contentType: string;
}
```

Store content in R2:

```
objects/
  ab/
    abcdef123...
```

Content-address everything.

```
BlobId = SHA-256(content)
```

SHA-256 is perfectly adequate for the prototype and avoids making the hash algorithm an interesting distraction.

**Property #1: identical content exists once.**

---

#### 2. Tree

For the hackathon/prototype, **do not build the B+ tree yet.**

That's an important cut.

Implement a Merkle directory tree:

```
interface Tree {
  id: TreeId;

  entries: {
    name: string;
    type: "blob" | "tree";
    id: BlobId | TreeId;
  }[];
}
```

Hash:

```
TreeId = hash(canonicalSerialize(entries))
```

Now you have immutable repository snapshots with structural sharing.

```
                 T1
               /    \
            src      tests
             │
           auth.ts
             │
             B1
```

Agent modifies auth.ts:

```
                 T2
               /    \
            src'     tests ───── shared
             │
           auth.ts
             │
             B2
```

This alone proves the important persistent-state concept.

**B+ tree comes later.**

---

#### 3. Snapshot

This becomes your replacement for "commit" at the state level.

```
interface Snapshot {
  id: SnapshotId;

  root: TreeId;

  parents: SnapshotId[];

  changeset?: ChangeSetId;

  createdAt: number;
}
```

Now:

```
S0
├──── S1-A
├──── S1-B
└──── S1-C
```

Three agents can fork S0 essentially for free.

That's your first visible **post-branch moment**.

---

#### 4. ChangeSet

This is the central primitive.

```
interface ChangeSet {
  id: ChangeSetId;

  runId: RunId;
  taskId: TaskId;

  agentId: AgentId;

  base: SnapshotId;
  result: SnapshotId;

  operations: Operation[];

  evidence: Evidence[];

  status:
    | "proposed"
    | "evaluated"
    | "accepted"
    | "rejected"
    | "reconciled";
}
```

Keep operations stupid initially:

```
type Operation =
  | {
      type: "put";
      path: string;
      blob: BlobId;
    }
  | {
      type: "delete";
      path: string;
    };
```

No AST.

No symbol graph.

No semantic operations.

Yet.

---

#### 5. Intent + Run

Don't build a sophisticated planning language.

```
interface Intent {
  id: IntentId;

  prompt: string;

  acceptanceCriteria: string[];
}

interface Run {
  id: RunId;

  repositoryId: RepoId;
  intent: Intent;

  baseSnapshot: SnapshotId;

  candidates: ChangeSetId[];

  winner?: ChangeSetId;

  status:
    | "running"
    | "evaluating"
    | "reconciling"
    | "ready"
    | "shipped";
}
```

That's enough.

For the MVP, the "task DAG" can literally be:

```
             Intent
                │
       ┌────────┼────────┐
       ▼        ▼        ▼
     Agent A  Agent B  Agent C
       │        │        │
       ▼        ▼        ▼
      CS-A     CS-B     CS-C
       └────────┼────────┘
                ▼
            Evaluate
                │
                ▼
             Decide
```

You don't need a generic DAG engine to prove the idea.

---

#### 6. Repository HEAD

This is where Durable Objects become really compelling.

One Durable Object owns:

```
interface RepositoryState {
  head: SnapshotId;
  version: number;
}
```

And exposes:

```
ship({
  expectedHead,
  proposedHead
})
```

Internally:

```
if (state.head !== expectedHead) {
    return {
        ok: false,
        reason: "HEAD_MOVED",
        currentHead: state.head
    };
}

state.head = proposedHead;
state.version++;

return { ok: true };
```

You've now implemented the central concurrency invariant:

> **Infinite speculative writers; one serialized canonical pointer.**

That's enough for the prototype.

---

### Cloudflare mapping

I'd keep the infrastructure equally constrained.

| Primitive | Cloudflare |
| --- | --- |
| API/UI | Workers |
| canonical repository HEAD | Durable Object |
| run orchestration | Durable Object |
| blobs + Merkle trees | R2 |
| metadata/index | D1 |
| async evaluation | Queues |
| builds/test output | Artifacts |
| live updates | WebSocket/SSE |
| agent inference | Workers AI and/or external model API |

You probably only need **two Durable Object classes**:

```
RepositoryDO
RunDO
```

RepositoryDO owns canonicalization.

RunDO owns the concurrent exploration.

Keep those responsibilities extremely clean.

---

### The killer 3-agent workflow

This should be the development target.

User imports a tiny TypeScript repository.

HEAD:

```
S0
```

Then enters:

> Add a /health endpoint returning application version, uptime and status. Add tests.

Hit:

**Explore**

Three agents start concurrently:

```
                         S0

                ┌────────┼────────┐
                │        │        │
                ▼        ▼        ▼

              Agent A  Agent B  Agent C

                │        │        │
                ▼        ▼        ▼

              CS-A     CS-B     CS-C

                │        │        │
                ▼        ▼        ▼

               S-A      S-B      S-C
```

The UI should visibly show three repository universes existing simultaneously.

That visualization is more important than building 50 backend features.

Then execute tests against all three.

```
             A             B             C

Tests       18/18         18/18         17/18
Files         4             3             7
LOC         +93           +51          +181
Latency     3.1ms         2.8ms         3.0ms
Complexity   12             7            19

Score        89            96 ★          71
```

Then click each solution.

Show:

**implementation**

**diff**

**agent explanation**

**test evidence**

**score**

Then:

```
Select B
```

RepositoryDO performs:

```
CAS(S0 → S-B)
```

And visually:

```
                         S0
                   ┌─────┼─────┐
                   ▼     ▼     ▼
                  S-A   S-B   S-C
                         │
                         ★
                         │
                         ▼
                       HEAD
```

A and C aren't deleted.

They're permanent alternative histories.

That's crucial.

---

### Then demonstrate concurrency failure

This is the second killer moment.

While those agents are working, make another accepted change:

```
S0 → S1
```

Agent B returns expecting:

```
base = S0
```

But:

```
HEAD = S1
```

Don't say:

> Merge conflict.

Show:

```
HEAD advanced while B was exploring.

B touched:
  /src/health.ts
  /tests/health.test.ts

S1 touched:
  /src/billing.ts

Impact intersection: ∅

Replaying B against S1...
```

Produce:

```
S0 ─── S1 ─── S2
       billing   health
```

That demonstrates the concurrency model far better than explaining MVCC on a slide.

---

### Reconciliation should barely make MVP

I'd implement **one constrained reconciliation case**.

Have:

```
Agent A
    adds retry logic

Agent B
    adds configurable timeout
```

Both modify the same small function.

Instead of showing:

```
<<<<<<<
=======
>>>>>>>
```

send:

```
base
A
B
intent
tests
```

to a reconciliation agent.

It produces candidate C:

```
A ──┐
    ├── CS-R
B ──┘
```

Then **run tests again**.

Never let an LLM reconciliation become canonical merely because the LLM says it's correct.

The invariant is:

```
AI proposes.
Evidence validates.
RepositoryDO canonicalizes.
```

That's a strong architecture story.

---

### What NOT to build

This is where I'd be ruthless.

Defer all of this:

- Full Git smart-protocol hosting.

- B+ tree implementation.

- Symbol-level semantic merge.

- CRDTs.

- Generic distributed DAG runtime.

- Hundreds of agents.

- GitHub Actions replacement.

- Issues.

- Organizations/enterprise permissions.

- SSH Git server.

- Fine-grained locking.

- Full provenance graph database.

- IDE.

- Package registry.

- Code search engine.

- Full PR compatibility.

- Sophisticated billing.

- Self-hosted runners.

And especially don't spend the prototype building:

```
git clone
git fetch
git push
```

unless the judging criteria explicitly require it.

Import a GitHub repo once or upload a repository ZIP and export the winning state afterward.

You're proving the **post-Git abstraction**, not implementing Git plumbing.

---

### Build order

I'd build it in this exact sequence:

```
DAY 1
Blob
  ↓
Merkle Tree
  ↓
Snapshot

DAY 2
ChangeSet
  ↓
RepositoryDO
  ↓
CAS HEAD

DAY 3
RunDO
  ↓
3 parallel agents
  ↓
3 immutable snapshots

DAY 4
test execution
  ↓
Artifacts
  ↓
evaluation/scoring

DAY 5
solution-space UI
  ↓
compare candidates
  ↓
ship winner

DAY 6
HEAD-moved/replay demonstration
  ↓
basic reconciliation

DAY 7
polish the visualization
```

If time becomes constrained, **cut reconciliation before cutting the solution-space UI.**

Because the essential demo isn't AI merging.

It's this:

```
                        INTENT
                           │
                           ▼
                          S0
                    ╱      │      ╲
                   ╱       │       ╲
                 S-A      S-B      S-C
                  81       96       87
                           ★
                           │
                      evidence
                           │
                           ▼
                         HEAD
```

That single picture communicates the product.

##### The prototype's six primitives

```
Blob
  ↓
Tree
  ↓
Snapshot
  ↓
ChangeSet

Intent → Run

Repository HEAD
```

Everything else is derived.

And I would make the tagline for the Cloudflare submission something close to:

> **Git stores the history of what humans chose. We store the solution space agents explored.**

That's the conceptual leap worth building around.
