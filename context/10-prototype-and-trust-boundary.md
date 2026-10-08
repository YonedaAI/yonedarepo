# 10. Cloudflare prototype, control plane, and trust boundary

[Index](index.md) · [Previous](09-cloudflare-runners-and-mcp.md) · [Next](11-complete-rust-architecture.md)

*Substantive turn 10 of 18, in original conversation order.*

## User

For the Cloudflare architecture

*  Define the first end-to-end prototype
*  Map the Cloudflare control plane
*  Design the sandbox trust boundary

## ChatGPT

Yes. I would now freeze the architecture and build a **single vertical slice** before adding generic DAG orchestration, B+ trees, semantic merging, or a large agent protocol.

Cloudflare's current Sandboxes are a particularly good match: they provide isolated Linux execution controlled by a Worker, with the Worker deciding what application data and Internet access the sandbox receives. Cloudflare also explicitly warns that everything reachable *inside one sandbox* should be considered mutually accessible, which strongly supports **one sandbox per agent execution**. [Cloudflare Docs+1](https://developers.cloudflare.com/sandbox/)

#### 1. First end-to-end prototype

The demo should be:

> **One TypeScript/Rust repo + one intent + three Codex agents + three Cloudflare Sandboxes + three immutable ChangeSets + independent tests + choose winner + atomic HEAD advancement.**

Nothing more.

```
User
 │
 │ "Add /health endpoint with tests"
 ▼
Worker API
 │
 ▼
RunDO
 │
 ├───────────────┬───────────────┐
 ▼               ▼               ▼
Execution A     Execution B     Execution C
 │               │               │
 ▼               ▼               ▼
Sandbox A       Sandbox B       Sandbox C
 │               │               │
Codex           Codex           Codex
 │               │               │
 ▼               ▼               ▼
workspace A     workspace B     workspace C
 │               │               │
 └───────┬───────┴───────┬───────┘
         ▼               ▼
      freeze/diff     freeze/diff
         │
    ┌────┼────┐
    ▼    ▼    ▼
   CS-A CS-B CS-C
    │    │    │
   S-A  S-B  S-C
    │    │    │
    ▼    ▼    ▼
    independent evaluator
          │
     91   97★   84
          │
          ▼
       Human selects B
          │
          ▼
        RepoDO
          │
     CAS S0 → S-B
          │
          ▼
         HEAD
```

##### The repo

Make it intentionally tiny:

```
demo/
├── package.json
├── src/
│   ├── server.ts
│   └── version.ts
└── tests/
    └── server.test.ts
```

Intent:

> Add GET /health returning {status, version, uptime}. Existing endpoints must remain unchanged. Add tests.

That's enough complexity for agents to produce meaningfully different solutions without making the demo unreliable.

##### The three agents

Don't even require three different models initially.

Give the same Codex runner three strategy hints:

```
A: minimize implementation size
B: optimize maintainability
C: optimize defensive correctness
```

Each receives the exact same:

```
ExecutionSpec {
    base: S0,
    intent: I0,
    strategy: ...,
    execution: ...,
}
```

The key demonstration is **parallel solution search**, not model diversity.

##### Agent completion

When Codex says it's finished, don't trust its report as repository state.

The control plane:

1. stops/fences further writes,

2. captures the resulting workspace,

3. computes the diff against S0,

4. hashes changed blobs,

5. creates the new tree,

6. creates Snapshot,

7. creates ChangeSet,

8. persists evidence.

Therefore:

```
Agent claims                       Platform establishes

"I changed 3 files"          →     actual diff
"tests pass"                 →     independent evaluator
"this is snapshot X"         →     computed hash
"I completed task"           →     execution completion
```

That distinction is foundational.

---

### 2. Cloudflare control plane

I'd use **four Cloudflare primitives initially**:

```
Workers
Durable Objects
R2
Sandboxes
```

and optionally Queues once execution becomes asynchronous enough to need retry/recovery.

```
                         INTERNET
                             │
                             ▼
                    ┌────────────────┐
                    │ API Worker     │
                    │                │
                    │ HTTP           │
                    │ MCP            │
                    │ WebSocket/SSE  │
                    └───────┬────────┘
                            │
            ┌───────────────┼─────────────────┐
            │               │                 │
            ▼               ▼                 ▼
          RepoDO           RunDO             R2
            │               │                 │
            │               │                 │
          HEAD          executions        immutable
        decisions           │             objects
        policies            │             evidence
                            │
                 ┌──────────┼──────────┐
                 ▼          ▼          ▼
              Sandbox A  Sandbox B  Sandbox C
```

#### Worker = gateway

The Worker should own:

```
authentication
authorization
REST API
MCP endpoint
UI streaming
sandbox provisioning
capability issuance
```

But **not repository serialization**.

Routes could initially be:

```
POST /repos
POST /repos/:repo/runs

GET  /runs/:run
GET  /runs/:run/candidates

POST /runs/:run/accept/:candidate

POST /mcp
```

The browser never communicates directly with R2, a sandbox, or repository storage.

---

### RepoDO = canonical authority

I'd use **one Durable Object per repository**:

```
RepoDO(repo_id)
```

It owns:

```
HEAD
HEAD version

policy

accepted ChangeSets
decisions
idempotency records
```

The central operation is:

```
accept(
    expected_version,
    expected_snapshot,
    validated_candidate
)
```

Conceptually:

```
if HEAD.version != expected_version
    → HEAD_MOVED

if HEAD.snapshot != expected_snapshot
    → HEAD_MOVED

if candidate.validation != current policy
    → INVALID

else
    atomically:
        HEAD.snapshot = candidate.result
        HEAD.version += 1
        record decision
```

**Only RepoDO can change HEAD.**

Not:

```
Worker
RunDO
Sandbox
Agent
Evaluator
MCP server
```

That gives you a beautifully small trust root.

---

### RunDO = exploration coordinator

One Durable Object per run:

```
RunDO(run_id)
```

owns:

```
Intent
base snapshot
execution records
candidate references
evaluation references
run state
```

State machine:

```
CREATED
   ↓
EXPLORING
   ↓
EVALUATING
   ↓
READY
   ↓
ACCEPTED
```

or:

```
FAILED
CANCELLED
```

RunDO does **not** change repository HEAD.

It can say:

> Candidate B won evaluation.

But only RepoDO can say:

> Candidate B is now repository reality.

That separation is important.

---

### R2 = immutable object/evidence layer

Use R2 for:

```
blobs/
trees/
snapshots/
changesets/

artifacts/
logs/
test-results/
agent-reports/
```

R2 is strongly consistent, which is useful for publishing immutable objects before referencing them from authoritative state. [Cloudflare Docs](https://developers.cloudflare.com/r2/how-r2-works/)

Example:

```
/repos/{repo}/objects/blob/{hash}
/repos/{repo}/objects/tree/{hash}
/repos/{repo}/objects/snapshot/{hash}
/repos/{repo}/objects/changeset/{hash}

/repos/{repo}/runs/{run}/executions/{exec}/stdout
/repos/{repo}/runs/{run}/executions/{exec}/evaluation
```

The rule is:

> **Upload immutable objects first; publish references second.**

An interrupted execution might leave orphaned R2 objects.

That's okay.

Never let:

```
HEAD → nonexistent object
```

happen.

---

### Sandbox = disposable execution plane

Use:

```
one execution
=
one sandbox
```

not:

```
one run
=
one sandbox containing three agents
```

Cloudflare states that all processes inside one sandbox share the Linux environment and can access the same files/processes/localhost resources. Separate sandboxes provide the isolation boundary you actually want. [Cloudflare Docs+1](https://developers.cloudflare.com/sandbox/sdk/concepts/security/)

So:

```
Run 281

exec A → sandbox run281-a
exec B → sandbox run281-b
exec C → sandbox run281-c
```

Never:

```
sandbox run281

/workspaces/a
/workspaces/b
/workspaces/c
```

because then malicious/buggy Agent A could inspect B and C.

---

### 3. Sandbox trust boundary

The mental model should be:

> **Assume the agent owns the entire sandbox.**

Not merely /workspace.

Assume it can read:

```
environment variables
filesystem
processes
localhost services
temporary files
shell history
```

Cloudflare explicitly recommends this assumption and notes that processes inside a sandbox share the environment. [Cloudflare Docs](https://developers.cloudflare.com/sandbox/concepts/security/)

Therefore draw the boundary here:

```
TRUSTED                               UNTRUSTED

Cloudflare Worker
RepoDO
RunDO
R2 metadata
Evaluator policy

         │
         │ narrow capability boundary
         ▼

┌──────────────────────────────────────────────┐
│               SANDBOX                       │
│                                              │
│ Codex / Claude                              │
│ generated code                              │
│ dependencies                                │
│ compiler                                    │
│ shell                                       │
│ Git                                         │
│ /workspace                                  │
│ test process                                │
│                                              │
│ EVERYTHING HERE IS UNTRUSTED                │
└──────────────────────────────────────────────┘
```

#### Never inject infrastructure credentials

Do **not** put these in sandbox environment variables:

```
R2 credentials
Cloudflare API token
RepoDO credentials
GitHub PAT
OpenAI master key
Anthropic master key
database credentials
```

Cloudflare's current guidance is explicit: any process in a sandbox can read tokens held by that sandbox; keep credentials in the Worker and proxy only authorized operations. [Cloudflare Docs](https://developers.cloudflare.com/sandbox/network/)

That's perfect for this architecture.

---

### Give the sandbox capabilities, not credentials

Instead of:

```
CF_API_TOKEN=...
R2_SECRET=...
GITHUB_TOKEN=...
```

the sandbox gets effectively:

```
ExecutionCapability {
    repo: R17,
    run: R92,
    execution: E3,

    can: [
        context.read,
        artifact.read_dependencies,
        artifact.publish,
        execution.status,
        execution.complete,
    ],

    expires: ...
}
```

Even better, where possible, don't expose the underlying credential to the sandbox at all.

Use Worker-mediated outbound handling:

```
Sandbox
   │
   │ GET https://agentrepo.internal/context
   ▼
Worker
   │
   │ verifies execution identity
   ▼
RunDO
```

Cloudflare supports sandbox outbound handlers that can expose Worker bindings without putting the actual binding credentials inside the container. [Cloudflare Docs+1](https://developers.cloudflare.com/sandbox/sdk/guides/workers-connections/)

That is exactly what you want.

---

### Disable general Internet access initially

For the prototype:

```
enableInternet = false
```

Then explicitly intercept only what the agent needs.

Cloudflare documents that a container started without Internet access can be limited to hostnames intercepted by your Worker. [Cloudflare Docs](https://developers.cloudflare.com/sandbox/network/)

Conceptually:

```
                       Sandbox
                          │
             ┌────────────┼─────────────X internet
             │            │
             ▼            ▼
       agentrepo.internal model.internal
             │            │
             ▼            ▼
           Worker       Worker
             │            │
             ▼            ▼
          RunDO        model API
```

This is substantially better than putting the model provider's API key in the sandbox.

The Worker can inject it upstream.

---

### Sandbox filesystem

Materialize exactly one immutable base:

```
/workspace/
    source files

/agrepo/
    execution.json
```

But execution.json should contain only non-secret information:

```
{
  "execution": "exec_17",
  "base": "sha256:...",
  "intent": "Add health endpoint",
  "strategy": "maintainability"
}
```

Never treat files under /agrepo as trustworthy after execution begins.

The agent can modify them.

The trusted execution identity lives **outside** the sandbox in RunDO/Worker state.

---

### Don't trust tests run by the coding agent

This deserves its own boundary.

Agent A can run:

```
npm test
```

for feedback.

But those results are **informational only**.

After the workspace freezes:

```
Agent Sandbox
     │
     │ completed workspace
     ▼
Trusted capture
     │
     ▼
Candidate Snapshot
     │
     ▼
NEW evaluation Sandbox
     │
     │ trusted test harness
     ▼
Evaluation
```

I'd actually use a **separate sandbox for evaluation**.

```
Sandbox A
Codex
  │
  ▼
CS-A
  │
  ▼
Evaluator Sandbox A'
```

Why?

Because the coding agent may have:

```
background processes
modified PATH
changed test scripts
poisoned caches
altered environment
```

A clean evaluator gives you:

```
candidate files
+
trusted harness
+
known image
=
evidence
```

Much stronger.

---

### The evaluator gets even fewer capabilities

Coding sandbox:

```
READ base repository
WRITE workspace
READ dependency artifacts
PUBLISH artifacts
CALL model
```

Evaluation sandbox:

```
READ candidate
READ trusted test harness

NO model API
NO MCP publishing
NO repository mutation
NO Internet
```

Then evaluation emits:

```
Evaluation {
    candidate: CS_A,

    environment_digest: ...,
    suite_digest: ...,

    checks: [
        Tests(Pass),
        Build(Pass),
        Lint(Pass),
    ],

    evidence: [...]
}
```

RepoDO accepts only an evaluation matching its current policy.

---

### Sandbox lifecycle

Treat the filesystem as ephemeral.

Cloudflare documents that sandbox/container state can disappear when the container stops; persistent state should therefore live outside the sandbox. [Cloudflare Docs](https://developers.cloudflare.com/sandbox/sdk/concepts/sandboxes/)

So never make:

```
sandbox filesystem
```

the source of truth.

Instead:

```
R2 / RepoDO
      │
      ▼
materialize
      │
      ▼
Sandbox
      │
   execution
      │
      ▼
capture
      │
      ▼
R2 / RunDO
      │
      ▼
destroy sandbox
```

That's a really clean lifecycle.

---

### Complete prototype control flow

Put all three pieces together:

```
1. USER
   │
   │ POST intent
   ▼

2. WORKER
   │
   ▼

3. RUNDO
   │
   │ freeze base S0
   │ create A/B/C
   ▼

4. SANDBOXES

   ┌───────────┬───────────┬───────────┐
   ▼           ▼           ▼
   A           B           C
 Codex       Codex       Codex
   │           │           │
   ▼           ▼           ▼
 workspace   workspace   workspace

   └───────────┬───────────┬───────────┘
               ▼

5. TRUSTED CAPTURE

         diff against S0
               │
       ┌───────┼───────┐
       ▼       ▼       ▼
      CS-A    CS-B    CS-C
       │       │       │
      S-A     S-B     S-C

               │
               ▼

6. CLEAN EVALUATION SANDBOXES

       A'      B'      C'
       │       │       │
       91      97      84
               ★

               │
               ▼

7. RUNDO

       state = READY

               │
        user accepts B
               ▼

8. REPODO

       validate:
       S0 still HEAD?
       evaluation valid?
       policy satisfied?

               │
              YES
               │
               ▼

       atomic decision

          S0 → S-B
                │
                ▼
               HEAD

9. destroy A/B/C/A'/B'/C'
```

#### Prototype definition of done

I wouldn't consider the first version done until you can show, live:

**One intent → three genuinely concurrent Cloudflare sandboxes → three different implementations → three immutable ChangeSets → three independent clean evaluations → visual comparison → one atomic acceptance.**

Then, during the demo, deliberately advance HEAD before accepting another candidate and show:

```
HEAD_MOVED

candidate base: S0
current HEAD:   S1

candidate was NOT silently merged
candidate was NOT lost

→ replay/reconciliation required
```

You don't even need to implement reconciliation yet.

That failure is actually part of the demo because it proves the concurrency invariant.

At that point you've demonstrated something substantially more interesting than "we put Codex in a container":

> **Cloudflare has become the distributed operating system for speculative software development: Durable Objects establish truth, R2 establishes immutable history/evidence, and Sandboxes create disposable parallel universes in which agents can explore competing futures of the same codebase.**

[Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/)

[Cloudflare Sandbox security model](https://developers.cloudflare.com/sandbox/concepts/security/)

[Cloudflare Sandbox credentials and network access](https://developers.cloudflare.com/sandbox/network/)
