# 11. Complete Rust architecture and Durable Objects

[Index](index.md) · [Previous](10-prototype-and-trust-boundary.md) · [Next](12-competition-mvp-build-plan.md)

*Substantive turn 11 of 18, in original conversation order.*

## User

What is rundo and repodo 


I’m confused I thought is was rust based 



We need the entire architecture

## ChatGPT

Yes — the architecture is **Rust-based**. I caused the confusion by using RepoDO and RunDO as shorthand without defining them.

**DO means Cloudflare Durable Object. It is not a language or framework.** In our design, those Durable Objects are Rust structs compiled to WebAssembly with workers-rs. Cloudflare currently supports Rust Workers, Rust Durable Objects, SQLite-backed DO storage, and even exposes the container handle through Rust's State::container(). [GitHub+1](https://github.com/cloudflare/workers-rs)

I would rename them in the code so the architecture is obvious:

```
#[durable_object]
pub struct RepositoryAuthority { ... }

#[durable_object]
pub struct RunCoordinator { ... }

#[durable_object]
pub struct ExecutionSandbox { ... }
```

So when I said:

```
RepoDO
RunDO
```

I meant:

```
RepositoryAuthority Durable Object
RunCoordinator Durable Object
```

Both implemented in **Rust**.

### The complete architecture

There are two different Rust deployment targets:

```
                    RUST CODEBASE

        ┌──────────────────────────────┐
        │ Shared Rust domain crates    │
        │ Intent / Run / Candidate /   │
        │ Evaluation / Decision        │
        └───────────────┬──────────────┘
                        │
             ┌──────────┴──────────┐
             │                     │
             ▼                     ▼
      wasm32-unknown-unknown     Linux native
             │                     │
             ▼                     ▼
    Cloudflare Workers + DOs   Sandbox binaries
```

That distinction is important.

The **Cloudflare control plane** is Rust compiled to WASM.

The **coding/evaluation environment** contains native Rust programs plus Codex/Claude and normal Linux tooling.

---

### Top-level system

```
                             Browser
                                │
                                ▼
                     ┌────────────────────┐
                     │   API Worker       │
                     │      Rust/WASM     │
                     │                    │
                     │ REST               │
                     │ MCP                │
                     │ auth               │
                     │ live events        │
                     └─────────┬──────────┘
                               │
             ┌─────────────────┼──────────────────┐
             │                 │                  │
             ▼                 ▼                  ▼
   RepositoryAuthority   RunCoordinator          R2
       Rust DO             Rust DO          logs/evidence
             │                 │
             │                 │
             │          ┌──────┼───────┐
             │          ▼      ▼       ▼
             │        Exec A  Exec B  Exec C
             │          │      │       │
             │          ▼      ▼       ▼
             │       ExecutionSandbox DOs
             │           Rust/WASM
             │          /    |    \
             │         /     |     \
             │        ▼      ▼      ▼
             │      Linux  Linux   Linux
             │     Sandbox Sandbox Sandbox
             │        │      │      │
             │      Codex  Claude  Codex
             │        │      │      │
             │        ▼      ▼      ▼
             │     candidate solutions
             │
             ▼
                    Cloudflare Artifacts
                   canonical + fork repos
```

Cloudflare Workers can be written entirely in Rust, and workers-rs provides bindings for Durable Objects, R2, Queues and other platform services. [Cloudflare Docs+1](https://developers.cloudflare.com/workers/languages/rust/)

---

### And Artifacts changes our earlier storage design

This is important.

For **this Cloudflare competition**, I would **not build our own Git object database or Merkle B+ tree in v1**.

Cloudflare Artifacts already gives us:

- Git-compatible repositories

- commits

- trees

- refs

- durable versioned state

- forks

- per-repository access tokens

- standard Git remotes

and Cloudflare explicitly positions it for parallel agent sessions and forks. [Cloudflare Docs+1](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/)

So the agentic model becomes an abstraction **above Artifacts**.

```
OUR MODEL                    PHYSICAL REPRESENTATION

Repository            →      Artifacts repository

Snapshot              →      Git commit SHA

Candidate             →      Artifacts fork + commit

Canonical state       →      main commit

ChangeSet             →      metadata describing
                              base → candidate

Run                   →      parallel solution graph

Evidence              →      R2 objects

Decision              →      RepositoryAuthority record
```

That is much cleaner.

---

### 1. agrepo-core

Pure Rust.

No Cloudflare imports.

```
crates/agrepo-core
```

It defines:

```
pub struct Intent {
    pub id: IntentId,
    pub prompt: String,
    pub criteria: Vec<Criterion>,
}

pub struct Run {
    pub id: RunId,
    pub repository: RepositoryId,
    pub base: Revision,
}

pub struct Revision {
    pub repository: ArtifactRepoId,
    pub commit: CommitSha,
}

pub struct Execution {
    pub id: ExecutionId,
    pub run: RunId,
    pub strategy: Strategy,
}

pub struct Candidate {
    pub execution: ExecutionId,

    pub base: Revision,
    pub result: Revision,

    pub summary: String,
}

pub struct Evaluation {
    pub candidate: CandidateId,

    pub suite: SuiteDigest,

    pub checks: Vec<CheckResult>,
}

pub struct Decision {
    pub repository: RepositoryId,

    pub expected: Revision,
    pub accepted: CandidateId,

    pub result: Revision,
}
```

Notice:

```
Revision != custom Merkle tree
```

For the MVP:

```
Revision = Artifacts repo + Git commit SHA
```

---

### 2. agrepo-artifacts

Rust interface for Cloudflare Artifacts.

```
pub trait ArtifactRepository {
    async fn create(...);
    async fn import(...);

    async fn fork(
        &self,
        source: &Revision,
        name: &str,
    ) -> Result<ArtifactRepo>;

    async fn revision(
        &self,
        repo: &ArtifactRepoId,
        commit: &CommitSha,
    ) -> Result<Revision>;

    async fn read_file(...);

    async fn issue_token(...);
}
```

Cloudflare Artifacts itself creates durable Git repos on demand and supports repository forking; each repo has its own history, refs, remote and access tokens. [Cloudflare Docs+1](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/)

One current implementation detail: the documented Artifacts Workers binding is currently presented primarily through generated Workers/TypeScript bindings. For the Rust version, I'd isolate the Cloudflare-specific implementation behind this Rust trait, using either the REST API from the Rust Worker or a narrow wasm-bindgen wrapper around the platform binding. The rest of the architecture does not care which adapter is used. [Cloudflare Docs](https://developers.cloudflare.com/artifacts/api/workers-binding/)

---

### 3. RepositoryAuthority

This is what I previously called RepoDO.

Rust:

```
#[durable_object]
pub struct RepositoryAuthority {
    state: State,
    env: Env,
}
```

There is exactly one logical instance per repository:

```
Repository 123
      │
      ▼
RepositoryAuthority("repo-123")
```

It owns **decisions**, not the entire source tree.

```
canonical revision
version
acceptance policy
accepted candidates
decision history
pending publication
```

Conceptually:

```
struct RepositoryState {
    canonical: Revision,
    version: u64,
    policy: PolicyId,
}
```

Only this component may authorize:

```
candidate → canonical
```

Durable Objects are a particularly good fit because a given DO ID is globally unique and gives you consistent coordination/storage. [Cloudflare Docs](https://developers.cloudflare.com/workers/platform/storage-options/)

---

### 4. RunCoordinator

Previously RunDO.

Again, just Rust:

```
#[durable_object]
pub struct RunCoordinator {
    state: State,
    env: Env,
}
```

There is one per exploration run:

```
Intent:

"Add passkey authentication"
             │
             ▼
        Run 92
             │
       RunCoordinator
```

It owns:

```
intent
base revision
task DAG
executions
candidate states
evaluation states
winner ranking
live UI state
```

Not source code.

And importantly:

```
RunCoordinator CAN:
    launch agents
    track them
    rank candidates

RunCoordinator CANNOT:
    update canonical repository state
```

That remains RepositoryAuthority.

---

### 5. ExecutionSandbox

This is the third Rust Durable Object.

One instance per agent:

```
#[durable_object]
pub struct ExecutionSandbox {
    state: State,
    env: Env,
}
```

The Rust Workers SDK now exposes:

```
state.container()
```

so a Rust Durable Object can control its bound Cloudflare container. [Docs.rs](https://docs.rs/worker/latest/worker/durable/struct.State.html)

Cloudflare's current container architecture is explicitly:

```
Worker
   ↓
Durable Object
   ↓
ctx.container
   ↓
Linux VM/container
```

and Cloudflare recommends the Durable Object Container API for new applications. [Cloudflare Docs](https://developers.cloudflare.com/containers/api/durable-object-container/)

Our Rust equivalent is:

```
ExecutionSandbox Rust DO
           │
           │ State::container()
           ▼
     Linux Sandbox
```

---

### 6. The Linux sandbox

Inside the container is a custom image:

```
agent-runner image

/usr/local/bin/agrepo-runner
/usr/local/bin/codex
/usr/local/bin/claude

/usr/bin/git
/usr/bin/rg

Rust
Node
Python
Go
etc.

/workspace
```

agrepo-runner is **also Rust**, but native Linux Rust rather than Worker/WASM Rust.

```
#[tokio::main]
async fn main() {
    let spec = load_execution_spec().await?;

    materialize_workspace(&spec).await?;

    match spec.agent {
        Agent::Codex => run_codex(&spec).await?,
        Agent::Claude => run_claude(&spec).await?,
    }

    report_complete(&spec).await?;
}
```

So:

```
Cloudflare control plane       Sandbox execution plane

Rust/WASM                      Rust/native
workers-rs                     tokio/etc
Durable Objects                Linux process
                               +
                               Codex/Claude
```

---

### 7. Agent repository isolation

This is where Artifacts fits beautifully.

Canonical repo:

```
Artifacts

yoneda/app
    main
    commit A123
```

Start a run.

The platform creates three forks:

```
yoneda/app
   A123
    │
    ├──── fork → run92-agent-a
    │
    ├──── fork → run92-agent-b
    │
    └──── fork → run92-agent-c
```

Cloudflare explicitly supports this model and says Artifacts can be used one repository per agent/session/task and for parallel exploration. [Cloudflare Docs+1](https://developers.cloudflare.com/artifacts/concepts/repositories/)

Then:

```
run92-agent-a
     A123 → C101

run92-agent-b
     A123 → C205

run92-agent-c
     A123 → C992
```

Candidate objects become:

```
Candidate {
    base: Revision {
        repo: "yoneda/app",
        commit: "A123",
    },

    result: Revision {
        repo: "run92-agent-b",
        commit: "C205",
    },
}
```

You no longer need to invent branch semantics.

---

### 8. Important security property

The coding agent **never gets canonical-repository write authority**.

At most it can modify:

```
run92-agent-b
```

Never:

```
yoneda/app/main
```

Artifacts supports repo-scoped tokens, which fits this isolation model directly. [Cloudflare Docs+1](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/)

Even better, for the strongest trust boundary I wouldn't put the Artifacts secret in the coding sandbox at all.

The Rust control plane materializes the workspace.

Agent edits:

```
/workspace
```

Then trusted infrastructure captures the result.

---

### 9. MCP server

Also Rust.

It lives in the main Worker.

```
#[event(fetch)]
pub async fn fetch(
    req: Request,
    env: Env,
    _ctx: Context,
) -> Result<Response> {
    match req.path().as_str() {
        "/mcp" => mcp::handle(req, env).await,
        _ => api::handle(req, env).await,
    }
}
```

The minimal contract remains:

```
repo_context()

artifact_get(id)

artifact_publish(...)

execution_status(...)

execution_complete(...)
```

MCP is **not source control**.

The agent edits normal files.

MCP lets it interact with the orchestration system.

---

### 10. Candidate capture

When Codex finishes:

```
ExecutionSandbox
       │
       ▼
freeze agent
       │
       ▼
trusted agrepo-runner
       │
       ▼
workspace diff
       │
       ▼
candidate commit
       │
       ▼
Artifacts fork
```

For example:

```
base:

A123

agent edits:
  src/health.ts
  tests/health.ts

result:

A123 → B827
```

The system records:

```
Candidate {
    execution: ExecB,

    base: canonical/A123,

    result: fork_b/B827,
}
```

---

### 11. Evaluation

Don't evaluate inside the coding sandbox.

Launch another ExecutionSandbox in evaluator mode:

```
Candidate B827
       │
       ▼
EvaluationSandbox
       │
       ├── no model
       ├── no credentials
       ├── no Internet
       └── trusted test harness
               │
               ▼
         build + test + lint
               │
               ▼
          Evaluation E42
```

That evaluator binary can also be Rust:

```
agrepo-evaluator
```

and outputs:

```
Evaluation {
    candidate: candidate_b,

    checks: vec![
        Build::Pass,
        Test { passed: 184, failed: 0 },
        Lint::Pass,
    ],
}
```

Large logs go to R2.

---

### 12. Why R2 still exists

Artifacts stores **source revisions**.

R2 stores **non-source evidence**:

```
stdout
stderr
test reports
benchmarks
coverage
agent transcripts
model traces
screenshots
build artifacts
evaluation bundles
```

So the split is:

```
Artifacts
    source and versioned code

R2
    evidence and large immutable artifacts

Durable Objects
    coordination and decisions
```

Very clean.

R2 is strongly consistent, so immutable evidence can be uploaded before its reference is published into authoritative state. [Cloudflare Docs](https://developers.cloudflare.com/r2/how-r2-works/)

---

### 13. Acceptance/publishing

Suppose:

```
canonical:
A123

candidates:

A → B111   score 88
B → B827   score 97
C → B922   score 91
```

User selects B.

Request goes to:

```
RepositoryAuthority
```

It verifies:

```
expected canonical = A123
actual canonical   = A123

evaluation B = valid
policy       = satisfied
```

Then it schedules a trusted publisher.

```
RepositoryAuthority
        │
        ▼
Trusted Publisher Sandbox
        │
        ├── fetch canonical
        ├── fetch winner
        ├── verify ancestry
        └── push accepted result
                │
                ▼
         Artifacts canonical
```

Result:

```
yoneda/app

A123 → B827
        ↑
       main
```

The publisher executes **no candidate code**.

It only performs controlled Git operations.

---

### 14. Why a trusted publisher exists

This avoids handing:

```
canonical write token
```

to Codex or Claude.

The agent sandbox is untrusted.

The publisher is a different image:

```
agent image

Codex
Claude
compilers
shell
NO canonical credentials
```

versus:

```
publisher image

agrepo-publisher
git

canonical write capability

NO LLM
NO arbitrary shell access
NO code execution
```

That is a much better boundary.

---

### 15. HEAD race handling

Suppose all candidates started from:

```
A123
```

but meanwhile another run ships:

```
A123 → A500
```

B tries to ship.

RepositoryAuthority sees:

```
candidate.base = A123

canonical      = A500
```

Result:

```
HEAD_MOVED
```

No merge.

No silent rebase.

No branch conflict.

The candidate stays alive:

```
fork_b/B827
```

Then a later reconciliation process can decide what to do.

---

### 16. Future reconciliation

Later:

```
                    A123
                   /    \
                A500    B827
                   \    /
                    \  /
                 reconciler
                     │
                     ▼
                    C900
```

A reconciliation agent receives:

```
base A123
current A500
candidate B827
intent
evaluation evidence
```

and creates **another candidate**, not a direct merge:

```
Candidate {
    kind: Reconciliation,
    parents: [A500, B827],
    result: C900,
}
```

Then it gets evaluated like everything else.

No special back door.

---

### 17. The actual Rust workspace

I'd now restructure what we previously designed into:

```
agentic-repo/
│
├── Cargo.toml
│
├── crates/
│
│   ├── core/
│   │   └── pure domain types
│   │
│   ├── artifacts/
│   │   └── Cloudflare Artifacts abstraction
│   │
│   ├── repository/
│   │   └── candidate + acceptance logic
│   │
│   ├── orchestrator/
│   │   └── runs + task DAG + scheduling
│   │
│   ├── evaluation/
│   │   └── policies + evidence
│   │
│   ├── mcp/
│   │   └── five-tool MCP protocol
│   │
│   ├── cloudflare/
│   │   └── R2 / DO / Queue / Artifacts adapters
│   │
│   └── worker/
│       └── Rust Cloudflare Worker
│
├── bins/
│
│   ├── agent-runner/
│   │   └── native Rust
│   │
│   ├── evaluator/
│   │   └── native Rust
│   │
│   └── publisher/
│       └── native Rust
│
└── images/
    ├── agent.Dockerfile
    ├── evaluator.Dockerfile
    └── publisher.Dockerfile
```

And compilation:

```
crates/worker
     ↓
wasm32-unknown-unknown

bins/agent-runner
bins/evaluator
bins/publisher
     ↓
x86_64 Linux
```

That's what **Rust-based** means here.

---

### 18. Cloudflare resources

The complete mapping is:

| Architecture | Cloudflare |
| --- | --- |
| API gateway | Rust Worker |
| MCP server | Rust Worker |
| repository authority | Rust Durable Object |
| run orchestration | Rust Durable Object |
| sandbox lifecycle | Rust Durable Object + Container |
| coding compute | Cloudflare Container |
| evaluation compute | Cloudflare Container |
| trusted publisher | Cloudflare Container |
| source/version history | **Cloudflare Artifacts** |
| evidence/logs | R2 |
| retries | Queues |
| live updates | Durable Object WebSockets |
| global search/listing later | D1 |
| model intelligence | Codex / Claude |

Cloudflare's current Rust SDK confirms that Durable Objects can be defined in Rust, and current State exposes the attached container via container(). [GitHub+1](https://github.com/cloudflare/workers-rs)

---

### 19. Whole execution sequence

Here's the entire system in one picture:

```
USER
 │
 │ "Implement passkeys"
 ▼
Rust API Worker
 │
 ▼
RunCoordinator
 │
 │ base = artifacts/main@A123
 │
 ├────────────────┬────────────────┐
 ▼                ▼                ▼
Exec A            Exec B           Exec C
 │                 │                │
 ▼                 ▼                ▼
Rust               Rust             Rust
ExecutionDO        ExecutionDO      ExecutionDO
 │                 │                │
 ▼                 ▼                ▼
CF Container       CF Container     CF Container
 │                 │                │
Codex             Claude           Codex
 │                 │                │
 ▼                 ▼                ▼
workspace          workspace        workspace
 │                 │                │
 ▼                 ▼                ▼
Artifacts fork A  Artifacts fork B Artifacts fork C
 B111              B827             B922
 │                 │                │
 └──────────────┬──┴───────────────┘
                │
                ▼
       Evaluation containers
                │
        ┌───────┼───────┐
        ▼       ▼       ▼
       88      97★      91
                │
                ▼
          RunCoordinator
                │
          candidate B wins
                │
           user accepts
                ▼
       RepositoryAuthority
                │
        verify main=A123
                │
                ▼
       trusted Publisher
                │
                ▼
      Cloudflare Artifacts

          A123 → B827
                  ↑
                 main
```

That is the architecture I would commit to.

#### And the conceptual layers become extremely simple

```
                    AGENTIC LAYER
       Intent → Run → Candidates → Evidence → Decision

                         ↓

                    SOURCE LAYER
                 Cloudflare Artifacts

                         ↓

                  EXECUTION LAYER
                Cloudflare Containers

                         ↓

                 COORDINATION LAYER
            Rust Workers + Durable Objects
```

And I would **drop the custom B+ tree from the first implementation entirely**. Cloudflare is explicitly asking competitors to build on Artifacts, and Artifacts already gives us the versioned Git layer we need. The innovation should be above Git:

> **Artifacts stores every possible code future. The Rust agentic layer stores why those futures were explored, how they were evaluated, and which one became reality.**

That is the entire system rather than "a Rust app with some mysterious RunDO/RepoDO pieces." [Cloudflare Docs+1](https://developers.cloudflare.com/artifacts/)
