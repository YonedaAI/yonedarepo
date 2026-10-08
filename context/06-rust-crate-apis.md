# 06. Rust crate APIs, trait boundaries, and Worker skeleton

[Index](index.md) · [Previous](05-rust-system-design.md) · [Next](07-agent-harness-integration.md)

*Substantive turn 6 of 18, in original conversation order.*

## User

Define the Rust crate APIs and trait boundaries for core, storage, repository, engine, and Cloudflare adapters.


For this Rust architecture

*  Write the Cloudflare Worker skeleton

## ChatGPT

I’ve written a **six-crate Rust workspace** with the domain APIs, Cloudflare adapters, Worker entrypoints, SQLite schema, and configuration.

**Verification:** All **14 local SQL tests passed**, and the TOML and shell scripts passed syntax checks. Nine Rust tests are included, but **I could not compile or run the Rust code because this environment has no Rust toolchain**. Nothing has been deployed.

The central boundary is:

> **Agents propose changes. The engine records evidence. The repository validates acceptance. Only the repository authority advances HEAD.**

### 1. Crate boundaries

```
agrepo-worker
    │
    ├── agrepo-cloudflare
    │       │
    │       ├── R2Objects
    │       ├── SqlRepo
    │       ├── RemoteLedger
    │       ├── CloudflareQueue
    │       ├── HttpAgent / HttpEvaluator
    │       └── ArtifactsRest
    │
    └── agrepo-engine
            │
            └── agrepo-repository
                    │
                    └── agrepo-storage
                            │
                            └── agrepo-core
```

These arrows show dependency direction; higher layers also use core types directly.

| Crate | Owns | Must not own |
| --- | --- | --- |
| agrepo-core | IDs, paths, canonical encoding, immutable domain objects, execution DTOs | I/O, clocks, SQL, Cloudflare types |
| agrepo-storage | Immutable object storage and source-reading ports | HEAD, acceptance, execution status |
| agrepo-repository | Applying changes, validating snapshots and evidence, HEAD authority contract | Agent scheduling or model calls |
| agrepo-engine | Executions, claims, dispatch, agent and evaluator contracts | SQL, HTTP clients, direct HEAD mutation |
| agrepo-cloudflare | Implementations using R2, Durable Objects, Queues, service bindings, Artifacts REST | Independent business rules |
| agrepo-worker | Authentication, routing, entrypoints, dependency construction | Repository algorithms |

**Traits belong to the layer that consumes the capability.** For example, HeadAuthority belongs to repository, while ExecutionLedger belongs to engine.

There is deliberately no giant CloudflareBackend trait exposing everything to every component.

#### Async boundary

The ports use:

```
#[async_trait::async_trait(?Send)]
```

This supports dynamically dispatched, local async implementations without forcing JavaScript-backed futures into a native multithreaded execution model. Cloudflare’s Rust integration runs through WebAssembly and workers-rs; the core does not assume a Tokio runtime, operating-system threads, or a local filesystem. [Cloudflare Docs+1](https://developers.cloudflare.com/workers/languages/rust/)

This is a deliberate tradeoff: a future native multithreaded host would use an explicitly Send-capable facade or a local task set—not blindly pass these futures to tokio::spawn.

### 2. Core: separate state from history

The most important correction to the earlier model is **removing the circular content hash**.

This cannot work cleanly:

```
Snapshot hash includes ChangeSet ID
ChangeSet hash includes result Snapshot ID
```

Instead:

```
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub root: TreeId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChangeSet {
    pub repository: RepoId,
    pub run: RunId,
    pub execution: ExecutionId,

    pub base: SnapshotId,
    pub result: SnapshotId,

    pub parents: Vec<ChangeSetId>,
    pub operations: Vec<Operation>,
    pub explanation: BlobId,
}
```

**Snapshots describe state. ChangeSets describe history.**

Two different explorations can produce identical files and therefore share a SnapshotId, while retaining distinct ChangeSets and explanations.

For the small prototype, the tree is an ordered manifest:

```
pub struct FileTree {
    pub files: BTreeMap<RepoPath, FileEntry>,
}

pub struct FileEntry {
    pub blob: BlobId,
    pub executable: bool,
}

pub struct Operation {
    pub path: RepoPath,
    pub before: Option<FileEntry>,
    pub after: Option<FileEntry>,
}
```

before is essential. An operation is not merely “write these bytes”; it says:

> Replace this exact prior file state with this new file state.

The repository rejects a proposal when its precondition does not match.

#### Object identity

The workspace uses a versioned, domain-separated hash:

```
SHA-256(
    "agrepo:v1\0"
    + object_kind
    + NUL
    + payload_length
    + canonical_payload
)
```

Canonical encoding sorts object keys and forbids floating-point values. Mutable status and timestamps do not enter immutable ChangeSet objects.

A real persistent Merkle B+ tree is deferred. The initial implementation reuses unchanged blobs but rewrites the small ordered file manifest.

### 3. Storage: immutable objects, not repository semantics

agrepo-storage defines two narrow capabilities:

```
#[async_trait(?Send)]
pub trait ObjectStore {
    async fn get(
        &self,
        key: &ObjectKey,
    ) -> Result<Option<Vec<u8>>, StorageError>;

    async fn put(
        &self,
        key: &ObjectKey,
        bytes: &[u8],
    ) -> Result<(), StorageError>;
}

#[async_trait(?Send)]
pub trait SourceReader {
    async fn read_file(
        &self,
        revision: &SourceRevision,
        path: &RepoPath,
    ) -> Result<Vec<u8>, StorageError>;
}
```

ObjectStore::put must reject bytes that do not match their content address. Repeating an identical write is harmless.

The helper API handles encoding and verification:

```
put_bytes(store, kind, bytes).await?;
get_bytes(store, kind, digest).await?;

put_json(store, kind, &object).await?;
get_json::<Snapshot>(store, kind, digest).await?;
```

There is **no delete method**. Garbage collection should eventually be a separate privileged capability, not something agents or ordinary repository operations receive.

#### Cloudflare Artifacts boundary

Cloudflare Artifacts is **Git-backed versioned storage**, not a generic name for test logs. Its REST API supports reading files at a commit, and uses different authentication from repository Git tokens. [Cloudflare Docs](https://developers.cloudflare.com/artifacts/api/rest-api/)

The included ArtifactsRest adapter implements SourceReader using:

```
Pinned Git commit
    + explicit file manifest
    → Artifacts REST
    → domain Snapshot
```

**The current skeleton imports from Artifacts; it does not yet publish accepted snapshots back to it.** That distinction is explicit in the code and README.

Test logs and other evidence are ordinary content-addressed objects in R2.

### 4. Repository: validation and the HEAD capability

agrepo-repository exposes application operations through Repository:

```
repo.import(files).await?;
repo.tree(&snapshot).await?;
repo.files(&snapshot).await?;

repo.save_policy(&policy).await?;
repo.propose(&execution, agent_output).await?;

repo.validate(&execution, &candidate_reference).await?;
```

The storage authority has a separate interface:

```
#[async_trait(?Send)]
pub trait HeadAuthority {
    async fn head(
        &self,
    ) -> Result<Option<Head>, RepoError>;

    async fn initialize(
        &self,
        request: &RequestId,
        snapshot: &SnapshotId,
        policy: &PolicyId,
    ) -> Result<CommitResult, RepoError>;

    async fn accept(
        &self,
        request: &RequestId,
        candidate: &ValidatedCandidate,
    ) -> Result<CommitResult, RepoError>;
}
```

The mutable head is:

```
pub struct Head {
    pub version: u32,
    pub snapshot: SnapshotId,
    pub changeset: Option<ChangeSetId>,
    pub policy: PolicyId,
}
```

Comparing the **version**, not only the snapshot hash, prevents an ABA problem: HEAD can return to the same file state after intervening changes without making an old proposal current again.

#### ValidatedCandidate is intentionally restricted

```
pub struct ValidatedCandidate {
    repository: RepoId,
    expected: Head,
    reference: CandidateRef,
    result: SnapshotId,
}
```

Its fields are private, and it does not implement Deserialize.

External code cannot construct one by posting:

```
{"validated": true}
```

The repository constructs it only after checking that the recorded evaluation binds to the exact execution, ChangeSet, result snapshot, policy, test suite, and environment.

It also verifies that applying the ChangeSet reconstructs the claimed result.

**This is API discipline, not cryptographic attestation.** The server must still retrieve evidence from the trusted execution ledger rather than accept arbitrary evaluation hashes supplied by the browser.

### 5. Engine: orchestration without infrastructure coupling

The engine owns these ports:

| Port | Responsibility |
| --- | --- |
| RunStore | Atomically record a run and its execution/dispatch records |
| ExecutionLedger | Claim work and accept a fenced completion |
| DispatchOutbox | Enumerate and mark pending dispatches |
| JobQueue | Publish an execution identifier |
| AgentRuntime | Propose edits against supplied immutable inputs |
| Evaluator | Independently evaluate a candidate |

The two execution capabilities are intentionally separate:

```
#[async_trait(?Send)]
pub trait AgentRuntime {
    async fn propose(
        &self,
        input: &AgentInput,
    ) -> Result<AgentOutput, EngineError>;
}

#[async_trait(?Send)]
pub trait Evaluator {
    async fn evaluate(
        &self,
        input: &EvaluationInput,
    ) -> Result<EvaluationOutput, EngineError>;
}
```

Neither receives HeadAuthority.

The engine itself is small:

```
pub struct Engine<'a> {
    pub repository: Repository<'a>,
    pub ledger: &'a dyn ExecutionLedger,
    pub agent: &'a dyn AgentRuntime,
    pub evaluator: &'a dyn Evaluator,
}
```

Its execution sequence is:

```
Claim execution
    ↓
Read frozen base files
    ↓
Agent proposes edits
    ↓
Repository constructs immutable candidate
    ↓
Trusted evaluator executes the frozen harness
    ↓
Store evidence and evaluation
    ↓
Record completion using the claim epoch
```

**Execution completion does not advance HEAD.** Acceptance remains a separate human-triggered operation.

#### Evaluation is a gate, not a weighted popularity contest

The acceptance rule is:

```
Every required check == Pass
AND suite digest matches
AND environment digest matches
AND evidence belongs to this exact candidate
```

A smaller diff or a high AI-review score cannot compensate for a failed or skipped required test.

A failing test produces a completed but unacceptable candidate. An unavailable evaluator produces an infrastructure failure and a retry. Those should not be conflated.

### 6. Cloudflare adapters

For the prototype, I would use **one SQLite-backed Durable Object per repository**, not separate repository/run objects plus D1.

| Adapter | Implements | Backing service |
| --- | --- | --- |
| R2Objects | ObjectStore | R2 |
| ArtifactsRest | SourceReader | Artifacts REST |
| SqlRepo | HeadAuthority, RunStore, ExecutionLedger, DispatchOutbox | RepoDO SQLite |
| RemoteLedger | ExecutionLedger | Internal RepoDO calls |
| CloudflareQueue | JobQueue | Queues |
| HttpAgent | AgentRuntime | AGENT_RUNNER service binding |
| HttpEvaluator | Evaluator | EVALUATOR service binding |

This avoids introducing a distributed transaction between two authoritative databases.

Cloudflare’s SQLite-backed Durable Objects expose synchronous SQL, and the storage API documents transactional behavior. The implementation uses a conditional SQL mutation rather than assuming that arbitrary code surrounding external await calls cannot interleave. [Cloudflare Docs](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

#### HEAD and the acceptance receipt are one record

The latest row in decisions is HEAD.

Acceptance uses this actual SQL from the workspace:

```
INSERT INTO decisions(
    version,
    snapshot,
    changeset,
    policy,
    evaluation,
    request_id,
    fingerprint
)
SELECT
    version + 1,
    ?1,
    ?2,
    policy,
    ?3,
    ?4,
    ?5
FROM decisions
WHERE version = (SELECT MAX(version) FROM decisions)
  AND version = ?6
  AND snapshot = ?7
  AND policy = ?8
  AND version < 4294967295
RETURNING version, snapshot, changeset, policy;
```

That single inserted row records the new canonical state, its evidence, and the successful request’s idempotency receipt.

There is no separate:

```
Update HEAD
    → crash
    → forget to record acceptance
```

Before this statement, the adapter checks whether the request ID already succeeded. The same request replays its original receipt; reusing it with different inputs is rejected.

**R2 uploads and the SQL acceptance are not one transaction.** Objects are uploaded first, and references are published afterward. Interrupted attempts can leave orphaned immutable objects; garbage collection is deferred.

#### Queue retries are part of the model

Cloudflare Queues provides at-least-once delivery, so duplicate executions must be expected. [Cloudflare Docs](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)

The skeleton uses:

```
pub struct Claim {
    pub spec: ExecutionSpec,
    pub epoch: u32,
}
```

The ledger also stores a lease expiry. Completion must match the current epoch **and** arrive before expiry. A late attempt cannot overwrite a newer attempt.

Dispatch follows:

```
Persist run + pending jobs atomically
    ↓
Publish job
    ↓
Mark dispatched
```

A crash after publication but before marking produces a duplicate—not lost work.

This does **not** make model calls exactly-once. Retries can still consume additional tokens.

### 7. Worker skeleton

The complete fetch router and Durable Object handlers are in the archive. Public routes are allowlisted and authenticated; internal claim/finish routes cannot be reached through the public router.

The queue entrypoint shows the intended boundary particularly clearly:

```
use agrepo_cloudflare::*;
use agrepo_core::Job;
use agrepo_engine::Engine;
use agrepo_repository::Repository;
use futures::StreamExt;
use worker::*;

async fn execute_job(
    env: &Env,
    job: &Job,
) -> Result<()> {
    let objects = R2Objects::new(
        env.bucket("OBJECTS")?,
        job.repository.clone(),
    );

    let ledger = RemoteLedger {
        env,
        repository: job.repository.clone(),
    };

    let agent = HttpAgent { env };
    let evaluator = HttpEvaluator { env };

    Engine {
        repository: Repository::new(&objects),
        ledger: &ledger,
        agent: &agent,
        evaluator: &evaluator,
    }
    .execute(job)
    .await
    .map_err(error)
}

#[event(queue)]
pub async fn queue(
    batch: MessageBatch<Job>,
    env: Env,
    _ctx: Context,
) -> Result<()> {
    let messages = batch.messages()?;

    futures::stream::iter(messages)
        .for_each_concurrent(3, |message| {
            let env = &env;

            async move {
                let job = message.body();

                match execute_job(env, job).await {
                    Ok(()) => message.ack(),
                    Err(_) => {
                        console_error!(
                            "execution retry repo={} execution={}",
                            job.repository,
                            job.execution
                        );
                        message.retry();
                    }
                }
            }
        })
        .await;

    Ok(())
}
```

The SDK exposes explicit message acknowledgement and retry methods; the workspace pins worker to **0.8.7**. [Docs.rs](https://docs.rs/worker/latest/worker/trait.MessageExt.html)

The in-memory future collection supplies concurrency during one invocation. **The queue, outbox, and execution ledger supply durability.**

#### The Durable Object’s acceptance path

Inside the handler, after looking up the completed execution:

```
// Evidence comes from the durable engine-issued record,
// not from a browser-supplied "validated" flag.
let valid = repo
    .validate(&execution.spec, &reference)
    .await?;

// HEAD may have changed during the object reads.
// The SQL authority checks the expected head now.
let result = db
    .accept(&request_id, &valid)
    .await?;
```

The full handler maps validation failures and HEAD conflicts into HTTP responses.

### 8. Runtime and configuration boundaries

The Worker is the **control plane**. It is not where arbitrary cargo test, npm test, or shell commands should run.

The agent and evaluator bindings should lead to isolated execution services. Cloudflare Sandbox provides a container-backed execution environment; that is a different capability from the ordinary Worker executing the repository control logic. [Cloudflare Docs](https://developers.cloudflare.com/sandbox/)

The evaluator must keep its trusted harness outside agent-editable files. Otherwise, an agent could “fix” failing tests by changing the test command.

The included wrangler.toml configures:

```
name = "agrepo-control-plane"
main = "entry.mjs"
compatibility_date = "2026-10-03"

[build]
command = "bash ../../scripts/build-worker.sh"

[[r2_buckets]]
binding = "OBJECTS"
bucket_name = "agrepo-objects"

[durable_objects]
bindings = [
  { name = "REPOSITORIES", class_name = "RepoDO" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RepoDO"]

[[queues.producers]]
binding = "JOBS"
queue = "agrepo-jobs"
```

The archive also includes consumer configuration, retries, a dead-letter queue, and commented service bindings to enable once the two execution services exist.

Build and verification commands:

```
rustup target add wasm32-unknown-unknown

cargo install worker-build \
  --version 0.8.7 \
  --locked

cargo generate-lockfile

bash scripts/check.sh
```

Generate and commit Cargo.lock on the first successful build. The archive does not pretend to contain a verified dependency lockfile or generated Wasm bundle.

### 9. What this skeleton does—and what remains

**Written:** domain objects and hashing, immutable R2 storage, bounded Artifacts import, preconditioned edits, candidate validation, atomic HEAD acceptance, durable run creation, dispatch outbox, fenced claims, service adapters, authenticated HTTP routing, queue handling, and test/configuration files.

**Still required for a complete live demo:** the actual agent-runner service and independent evaluator service. Neither is replaced with a fake success implementation.

**Still required for a complete Artifacts platform:** publishing accepted states back to Artifacts and retaining a fuller server-side source-origin record. The current Artifacts integration is deliberately import-only.

Persistent B+ trees, semantic merging, automatic rebasing, D1 projections, a generic DAG runtime, and a graphical solution explorer remain deferred. The prototype also has a deliberately simple periodic recovery alarm and fixed execution lease; production needs idle handling, execution budgets, renewal/cancellation, and better operational recovery.

The architectural result is the boundary you want:

```
Immutable source state
        ↓
Parallel, isolated proposals
        ↓
Independent evidence
        ↓
Repository validation
        ↓
One atomic canonical decision
```

**The next implementation work belongs in the two execution services—not in a new tree engine or another coordination database.**
