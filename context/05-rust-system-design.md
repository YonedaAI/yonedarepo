# 05. Rust system design

[Index](index.md) · [Previous](04-cloudflare-platform-mapping.md) · [Next](06-rust-crate-apis.md)

*Substantive turn 5 of 18, in original conversation order.*

## User

Design it in rust

## ChatGPT

Yes. For Rust, I'd make the core **runtime-agnostic**, with Cloudflare as an adapter. The key design rule is that the domain model must not know what R2, D1, Durable Objects, or Workers are.

#### Rust workspace

```
agentic-repo/
├── Cargo.toml
├── crates/
│   ├── core/               # canonical domain model
│   ├── object-store/       # blobs, trees, snapshots
│   ├── repo/               # ChangeSets + canonicalization
│   ├── engine/             # Runs / agents / evaluation
│   ├── reconcile/          # replay + reconciliation
│   ├── cloudflare/         # R2/D1/DO/Queue adapters
│   └── worker/             # HTTP/WebSocket Worker
└── web/
```

Dependencies stay roughly:

```
core
 ↑
object-store
 ↑
repo
 ↑
engine
 ↑
reconcile

cloudflare ── implements storage/runtime traits

worker ────── wires everything together
```

The important thing is **Cloudflare sits at the edge of the architecture**.

---

### 1. Strong content-addressed IDs

Don't pass strings everywhere.

```
use serde::{Deserialize, Serialize};

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash,
    Serialize, Deserialize
)]
pub struct Hash([u8; 32]);

macro_rules! hash_id {
    ($name:ident) => {
        #[derive(
            Clone, Copy, Debug, PartialEq, Eq, Hash,
            Serialize, Deserialize
        )]
        pub struct $name(pub Hash);
    };
}

hash_id!(BlobId);
hash_id!(TreeId);
hash_id!(SnapshotId);
hash_id!(ChangeSetId);
hash_id!(ArtifactId);
```

Then use UUID/ULID-style IDs for identity rather than content:

```
pub struct RepoId(pub uuid::Uuid);
pub struct RunId(pub uuid::Uuid);
pub struct IntentId(pub uuid::Uuid);
pub struct ExecutionId(pub uuid::Uuid);
```

That's an important distinction:

```
Content identity                 Logical identity

BlobId ───── hash                RepoId ───── UUID
TreeId ───── hash                RunId ────── UUID
SnapshotId ─ hash                IntentId ─── UUID
ChangeSetId ─ hash
```

---

### 2. Blob

A blob doesn't need much metadata in the canonical representation.

```
pub struct Blob {
    pub bytes: bytes::Bytes,
}

impl Blob {
    pub fn id(&self) -> BlobId {
        BlobId(hash(&self.bytes))
    }
}
```

Storage interface:

```
#[async_trait::async_trait]
pub trait BlobStore {
    async fn put(&self, blob: &Blob)
        -> Result<BlobId, StoreError>;

    async fn get(&self, id: BlobId)
        -> Result<Option<Blob>, StoreError>;

    async fn exists(&self, id: BlobId)
        -> Result<bool, StoreError>;
}
```

Cloudflare implementation:

```
R2

objects/
  sha256/
    4f/
      4f8ac3...
```

put() is naturally idempotent.

---

### 3. Merkle tree

For v1 I would use a Git-like Merkle tree rather than implementing the B+ tree.

```
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
pub struct Tree {
    pub entries: BTreeMap<String, TreeEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
pub enum TreeEntry {
    Blob {
        id: BlobId,
        executable: bool,
    },

    Tree {
        id: TreeId,
    },
}
```

The BTreeMap is useful even before you have a persistent B+ tree because serialization order is deterministic.

```
impl Tree {
    pub fn id(&self) -> TreeId {
        let canonical = postcard::to_allocvec(self).unwrap();

        TreeId(hash(&canonical))
    }
}
```

Now:

```
Tree {
    "Cargo.toml" → Blob(A)
    "src" → Tree(B)
}
```

is deterministic and content-addressable.

---

### 4. Snapshot

Keep **state** distinct from **history**.

```
#[derive(Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub root: TreeId,

    pub parents: Vec<SnapshotId>,

    pub changeset: Option<ChangeSetId>,
}
```

And:

```
impl Snapshot {
    pub fn id(&self) -> SnapshotId {
        SnapshotId(hash(
            &postcard::to_allocvec(self).unwrap()
        ))
    }
}
```

Now you naturally get:

```
              S0
          ╱   │   ╲
         ╱    │    ╲
       S1A   S1B   S1C
```

without branches existing anywhere in the core model.

---

### 5. Repository mutation

Don't allow arbitrary mutation of trees.

Have a TreeEditor construct new immutable trees.

```
pub struct TreeEditor<'a, S> {
    store: &'a S,
    root: TreeId,
    operations: Vec<Operation>,
}
```

Operations:

```
#[derive(Clone, Serialize, Deserialize)]
pub enum Operation {
    Put {
        path: RepoPath,
        blob: BlobId,
        mode: FileMode,
    },

    Delete {
        path: RepoPath,
    },
}
```

Usage:

```
let next_root = TreeEditor::new(&store, snapshot.root)
    .put("src/auth.rs", blob)?
    .delete("src/legacy.rs")?
    .commit()
    .await?;
```

Internally only the changed path gets reconstructed.

Conceptually:

```
BEFORE

       A
      / \
     B   C
        / \
       D   E


modify E


AFTER

       A'
      /  \
     B    C'
         / \
        D   E'

B + D are reused
```

This sets you up nicely for replacing the tree implementation later.

---

### 6. ChangeSet

This should become the heart of the system.

```
#[derive(Clone, Serialize, Deserialize)]
pub struct ChangeSet {
    pub run: RunId,

    pub task: TaskId,

    pub execution: ExecutionId,

    pub base: SnapshotId,

    pub result: SnapshotId,

    pub operations: Vec<Operation>,

    pub artifacts: Vec<ArtifactId>,
}
```

Notice I wouldn't put mutable status into this object.

Because:

> **Content-addressed objects should be immutable.**

Instead:

```
pub enum ChangeSetState {
    Proposed,
    Evaluating,
    Evaluated,
    Accepted,
    Rejected,
}
```

belongs in metadata:

```
D1

changeset_state
---------------
changeset_id
state
updated_at
```

That's a subtle but important architectural boundary.

---

### 7. Repository

Repository itself is surprisingly tiny.

```
pub struct Repository {
    pub id: RepoId,
    pub name: String,
}
```

Mutable state:

```
#[derive(Clone)]
pub struct RepositoryHead {
    pub snapshot: SnapshotId,
    pub version: u64,
}
```

And define a capability:

```
#[async_trait::async_trait]
pub trait HeadStore {
    async fn head(
        &self,
        repo: RepoId,
    ) -> Result<RepositoryHead, RepoError>;

    async fn compare_and_swap(
        &self,
        repo: RepoId,
        expected: SnapshotId,
        proposed: SnapshotId,
    ) -> Result<CasResult, RepoError>;
}
```

Result:

```
pub enum CasResult {
    Accepted {
        version: u64,
    },

    HeadMoved {
        current: SnapshotId,
        version: u64,
    },
}
```

Now the core concurrency model doesn't know Durable Objects exist.

Cloudflare implements HeadStore.

---

### 8. Durable Object becomes canonicalizer

This is the piece I'd make extremely small.

Conceptually:

```
pub struct RepositoryObject {
    state: State,
}
```

Storage:

```
head    → SnapshotId
version → u64
```

The critical operation:

```
pub async fn accept(
    &mut self,
    expected: SnapshotId,
    proposed: SnapshotId,
) -> Result<CasResult> {
    let current = self.load_head().await?;

    if current.snapshot != expected {
        return Ok(CasResult::HeadMoved {
            current: current.snapshot,
            version: current.version,
        });
    }

    let version = current.version + 1;

    self.persist_head(
        RepositoryHead {
            snapshot: proposed,
            version,
        }
    ).await?;

    Ok(CasResult::Accepted { version })
}
```

That's essentially your entire serialization point.

Everything else is concurrent.

---

### 9. Intent

```
#[derive(Clone, Serialize, Deserialize)]
pub struct Intent {
    pub id: IntentId,

    pub prompt: String,

    pub acceptance: Vec<AcceptanceCriterion>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AcceptanceCriterion {
    pub description: String,
    pub weight: f32,
}
```

Eventually criteria become machine-verifiable constraints.

For v1 strings are enough.

---

### 10. Run

The Run represents an exploration.

```
pub struct Run {
    pub id: RunId,

    pub repo: RepoId,

    pub intent: IntentId,

    pub base: SnapshotId,

    pub strategy: ExplorationStrategy,
}
```

Strategy:

```
pub struct ExplorationStrategy {
    pub candidates: usize,

    pub evaluator: EvaluatorPolicy,

    pub reconciliation: ReconciliationPolicy,
}
```

For MVP:

```
ExplorationStrategy {
    candidates: 3,
    evaluator: EvaluatorPolicy::TestsAndJudge,
    reconciliation: ReconciliationPolicy::None,
}
```

---

### 11. Agent execution

The agent shouldn't receive a mutable repository.

Give it a capability scoped to one immutable snapshot.

```
pub struct AgentContext<'a> {
    pub repo: RepoId,

    pub base: SnapshotId,

    pub fs: SnapshotFs<'a>,

    pub artifacts: &'a dyn ArtifactStore,
}
```

Then:

```
#[async_trait::async_trait]
pub trait Agent {
    async fn execute(
        &self,
        task: &AgentTask,
        context: AgentContext<'_>,
    ) -> Result<AgentResult, AgentError>;
}
```

Result:

```
pub struct AgentResult {
    pub operations: Vec<Operation>,

    pub explanation: String,

    pub artifacts: Vec<ArtifactId>,
}
```

This creates a powerful invariant:

> **Agents cannot mutate repository state. They can only propose operations.**

That should be enforced by Rust's API design, not merely documentation.

---

### 12. Materialized workspace

Agents still need actual files to run compilers and tests against.

So distinguish:

```
Snapshot
    │
    │ materialize()
    ▼
Workspace
    │
    │ agent modifies
    ▼
diff()
    │
    ▼
Operations
    │
    ▼
ChangeSet
```

Trait:

```
#[async_trait::async_trait]
pub trait Workspace {
    async fn materialize(
        &self,
        snapshot: SnapshotId,
    ) -> Result<WorkspaceHandle, WorkspaceError>;

    async fn diff(
        &self,
        workspace: &WorkspaceHandle,
    ) -> Result<Vec<Operation>, WorkspaceError>;
}
```

This is where Cloudflare's execution/artifact environment gets abstracted.

---

### 13. Parallel execution

The engine is beautifully simple in Rust.

Conceptually:

```
pub async fn explore(
    run: &Run,
    agents: Vec<Arc<dyn Agent>>,
) -> Result<Vec<Candidate>> {
    let futures = agents
        .into_iter()
        .map(|agent| execute_candidate(run, agent));

    futures::future::try_join_all(futures).await
}
```

All candidates receive exactly:

```
base = S0
```

So:

```
                        S0

           ┌────────────┼────────────┐
           │            │            │
           ▼            ▼            ▼

         Future       Future       Future

           │            │            │
           ▼            ▼            ▼

          CS-A         CS-B         CS-C

           │            │            │
           ▼            ▼            ▼

           SA           SB           SC
```

No shared mutable repository state exists.

Rust is a particularly good fit for this model.

---

### 14. Evaluation

Don't let the evaluator mutate anything either.

```
#[async_trait::async_trait]
pub trait Evaluator {
    async fn evaluate(
        &self,
        context: &EvaluationContext,
        candidate: &Candidate,
    ) -> Result<Evaluation, EvaluationError>;
}
```

Evaluation:

```
pub struct Evaluation {
    pub candidate: ChangeSetId,

    pub checks: Vec<CheckResult>,

    pub score: Score,

    pub artifacts: Vec<ArtifactId>,
}
```

Checks:

```
pub enum CheckResult {
    Tests {
        passed: u32,
        failed: u32,
    },

    Lint {
        errors: u32,
    },

    Benchmark {
        metric: String,
        value: f64,
    },

    Judge {
        criterion: String,
        score: f32,
        explanation: String,
    },
}
```

And scoring should be deterministic after the subjective judge outputs are recorded.

```
pub struct Score {
    pub correctness: f32,
    pub simplicity: f32,
    pub performance: f32,
    pub intent_match: f32,

    pub total: f32,
}
```

---

### 15. The engine

Now everything collapses into one clean service:

```
pub struct Engine<B, O, H, W, E> {
    blobs: B,
    objects: O,
    heads: H,
    workspaces: W,
    evaluator: E,
}
```

The high-level operation:

```
impl<B, O, H, W, E> Engine<B, O, H, W, E> {
    pub async fn run(
        &self,
        intent: Intent,
        repo: RepoId,
    ) -> Result<RunResult, EngineError> {

        let base = self.heads
            .head(repo)
            .await?
            .snapshot;

        let candidates =
            self.explore(repo, base, &intent).await?;

        let evaluated =
            self.evaluate(candidates).await?;

        let ranked =
            rank(evaluated);

        Ok(RunResult {
            base,
            candidates: ranked,
        })
    }
}
```

Then shipping is deliberately separate:

```
pub async fn ship(
    &self,
    repo: RepoId,
    candidate: &Candidate,
) -> Result<ShipResult, EngineError>
{
    self.heads
        .compare_and_swap(
            repo,
            candidate.base,
            candidate.result,
        )
        .await
}
```

I strongly prefer that separation.

**Exploration doesn't imply mutation.**

---

### 16. HeadMoved

Now the interesting agentic behavior starts.

```
match engine.ship(repo, winner).await? {
    CasResult::Accepted { version } => {
        // done
    }

    CasResult::HeadMoved { current, .. } => {
        replay(winner, current).await?;
    }
}
```

First compute overlap:

```
pub struct Impact {
    pub paths: BTreeSet<RepoPath>,
}
```

Then:

```
if winner.impact.is_disjoint(&head_change.impact) {
    replay_operations(
        winner.operations,
        current
    )
}
```

So v1 can support safe path-level replay without semantic AI merging.

---

### 17. Reconciliation later

Design the interface now but don't build much of it.

```
#[async_trait::async_trait]
pub trait Reconciler {
    async fn reconcile(
        &self,
        base: SnapshotId,
        left: ChangeSetId,
        right: ChangeSetId,
        intent: IntentId,
    ) -> Result<Reconciliation, ReconcileError>;
}
```

Output:

```
pub struct Reconciliation {
    pub inputs: Vec<ChangeSetId>,

    pub operations: Vec<Operation>,

    pub explanation: String,

    pub confidence: f32,
}
```

Critically:

```
Reconciler
     │
     ▼
proposed operations
     │
     ▼
new ChangeSet
     │
     ▼
Evaluator
     │
     ▼
tests
     │
     ▼
CAS
```

Never:

```
LLM → HEAD
```

---

### 18. Storage architecture

The resulting Rust/Cloudflare architecture becomes:

```
                       Worker
                          │
                       Engine
                          │
        ┌─────────────────┼──────────────────┐
        │                 │                  │
        ▼                 ▼                  ▼
     RunEngine        RepoEngine         Evaluator
        │                 │                  │
        └─────────────┬───┴──────────────┬───┘
                      │                  │
              Rust capability traits
                      │
       ┌──────────────┼───────────────┐
       ▼              ▼               ▼
      R2              D1        Durable Object
       │              │               │
    objects         metadata          HEAD
       │                              │
       └──────────────┬───────────────┘
                      │
                immutable DAG
```

And logically:

```
                    INTENT
                       │
                       ▼
                      RUN
                       │
              ┌────────┼────────┐
              ▼        ▼        ▼
            EXEC-A   EXEC-B   EXEC-C
              │        │        │
              ▼        ▼        ▼
             CS-A     CS-B     CS-C
              │        │        │
              ▼        ▼        ▼
             S-A      S-B      S-C
              │        │        │
             88       97★      91
                       │
                       ▼
                    CAS HEAD
                       │
                       ▼
                      S-B
```

#### What I'd deliberately exploit about Rust

The language can encode the architecture itself.

I'd go as far as using typestate for candidate lifecycle:

```
Candidate<Proposed>
Candidate<Evaluated>
Candidate<Validated>
```

Only:

```
Candidate<Validated>
```

can be passed to:

```
ship()
```

So this doesn't compile:

```
repo.ship(unevaluated_candidate).await?;
```

For the Rust architecture

- Write the Cloudflare Worker skeleton

For this Rust architecture
