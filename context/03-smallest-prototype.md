# 03. Smallest end-to-end prototype

[Index](index.md) · [Previous](02-solution-graph-and-concurrency.md) · [Next](04-cloudflare-platform-mapping.md)

*Substantive turn 3 of 18, in original conversation order.*

## User

Define the smallest end-to-end prototype that proves the agentic repo model, including which primitives to implement first and which features to defer.

## ChatGPT

The smallest prototype should prove one thing:

> **Multiple agents can independently explore the same intent, produce immutable competing ChangeSets, get evaluated, and have one result canonically accepted without using branches or PRs.**

Everything else is secondary.

### MVP scope

Build exactly this end-to-end flow:

```
Intent
  ↓
2–3 parallel agents
  ↓
isolated immutable snapshots
  ↓
ChangeSets
  ↓
tests + simple scoring
  ↓
winner selection
  ↓
canonical repository state advances atomically
  ↓
full provenance remains inspectable
```

If that works cleanly, you've proven the model.

#### The first primitives to implement

Implement these in this order:

1. **Blob**

2. **Tree / Snapshot**

3. **ChangeSet**

4. **Intent**

5. **AgentExecution**

6. **Evaluation**

7. **CanonicalHead**

8. **Run**

You do **not** need the full context graph, semantic merge engine, leases, or Git compatibility yet.

A minimal canonical schema could be:

```
struct Blob {
    id: Hash,
    bytes: Vec<u8>,
}

struct Snapshot {
    id: Hash,
    files: BTreeMap<Path, BlobId>,
    parent: Option<SnapshotId>,
    changeset: Option<ChangeSetId>,
}

struct Intent {
    id: IntentId,
    prompt: String,
    acceptance_criteria: Vec<String>,
}

struct AgentExecution {
    id: AgentExecutionId,
    intent: IntentId,
    base_snapshot: SnapshotId,
    agent_name: String,
    status: ExecutionStatus,
}

struct ChangeSet {
    id: ChangeSetId,
    base_snapshot: SnapshotId,
    result_snapshot: SnapshotId,
    agent_execution: AgentExecutionId,
    changed_paths: Vec<Path>,
}

struct Evaluation {
    id: EvaluationId,
    changeset: ChangeSetId,
    tests_passed: u32,
    tests_failed: u32,
    score: f64,
}

struct CanonicalHead {
    repository_id: RepoId,
    snapshot_id: SnapshotId,
    version: u64,
}

struct Run {
    id: RunId,
    intent: IntentId,
    base_snapshot: SnapshotId,
    executions: Vec<AgentExecutionId>,
    winner: Option<ChangeSetId>,
}
```

For the prototype, a snapshot can literally be a BTreeMap<Path, BlobId>.

Don't build a real Merkle B+ tree first.

That's an implementation optimization, not the conceptual proof.

### The killer MVP demo

Use one tiny repository, maybe a TypeScript API:

```
/src/counter.ts
/tests/counter.test.ts
package.json
```

Give all agents the same goal:

> Add persistence to the counter while preserving the current API.

Launch three strategies:

```
Agent A → file-backed storage
Agent B → SQLite
Agent C → in-memory adapter + pluggable persistence
```

Each begins from:

```
Snapshot S0
```

and independently produces:

```
S0
├── CSA → SA
├── CSB → SB
└── CSC → SC
```

Run:

```
npm test
lint
small benchmark
```

Then score:

```
score =
  50% test correctness
  20% simplicity
  20% acceptance-criteria match
  10% diff size
```

The UI shows:

```
Intent: Add persistence

A  82
B  89
C  96  ← winner

Tests
A  18/18
B  18/18
C  18/18

Files changed
A  5
B  8
C  4
```

Then click:

**Accept C**

The repository coordinator performs:

```
CAS(
  expected = S0,
  new      = SC
)
```

Canonical state becomes:

```
HEAD = SC
```

That alone proves the concurrency model.

### The concurrency model for MVP

Keep it brutally simple:

**Immutable speculative state + optimistic canonicalization.**

Every execution has:

```
base_snapshot
result_snapshot
```

Agents can write freely to private workspaces because none of them mutate canonical state.

The only serialized operation is:

```
fn accept(
    expected_base: SnapshotId,
    candidate: SnapshotId,
) -> Result<(), HeadMoved>
```

Conceptually:

```
if canonical_head == expected_base:
    canonical_head = candidate
else:
    reject with HeadMoved
```

Cloudflare Durable Object is ideal for this single authoritative transition.

You don't need distributed locks.

You don't need CRDTs.

You don't need branch locking.

You need one tiny serialized pointer update.

### Cloudflare MVP mapping

Keep the platform thin:

```
Worker
  ├── POST /runs
  ├── GET  /runs/:id
  ├── POST /runs/:id/accept
  └── GET  /snapshots/:id

Durable Object
  └── canonical repo head + CAS

R2
  └── blobs / snapshots / artifacts

D1
  └── metadata:
      intents
      runs
      executions
      changesets
      evaluations

Queues
  └── agent/evaluation jobs
```

You can even avoid Workers AI initially if external model calls are easier.

The platform idea does not depend on the model provider.

### Artifact layout

Make provenance visible from day one.

For every execution, persist:

```
/run/{run_id}
/execution/{execution_id}
/changeset/{changeset_id}
/snapshot/{snapshot_id}
/evaluation/{evaluation_id}
```

And store artifacts like:

```
prompt.txt
agent-output.json
patch.diff
test-results.json
benchmark.json
stdout.log
stderr.log
```

Then the UI can answer:

> What did Agent B do?

without needing a full context graph.

### UI scope

Only build three screens.

#### 
