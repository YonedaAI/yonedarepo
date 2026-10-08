# 13. Engineering and business framing: a layer above Git

[Index](index.md) · [Previous](12-competition-mvp-build-plan.md) · [Next](14-intentional-history.md)

*Substantive turn 13 of 18, in original conversation order.*

## User

So what exactly are we building in engineering and business language - show the architecture- it is not new git - but something else? Context Graph

## ChatGPT

Yes. The cleanest framing is:

> **We are not building a new Git. We are building the coordination, context, provenance, and decision layer for parallel software agents.**

Git/Cloudflare Artifacts remains underneath as the source/versioning substrate.

The new thing is the **Agentic Development Graph** above it.

#### Business language

Today, coding agents are mostly treated like faster developers:

> Agent gets task → edits branch → opens PR → human reviews.

That model breaks when you have 10, 100, or eventually 1,000 agents simultaneously researching, implementing, testing, criticizing, and combining solutions.

Our product turns software development from a **linear branch-and-merge workflow** into a **parallel solution-search system**.

A user says:

> “Implement passkey authentication.”

The platform can automatically create several competing approaches:

```
                         INTENT
              "Implement passkey auth"
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
          Claude          Codex         Codex
         Security        Minimal      Architecture
             │             │             │
             ▼             ▼             ▼
        Solution A     Solution B     Solution C
             │             │             │
             └─────────────┼─────────────┘
                           ▼
                     EVALUATION
                           │
                     tests/security/
                    cost/performance
                           │
                           ▼
                       DECISION
                           │
                           ▼
                    CANONICAL CODE
```

Git records the final code history.

**We record the search process that produced it.**

That's the business distinction.

---

### Engineering language

Technically, we're building a:

> **Distributed multi-agent software-development control plane with immutable execution provenance and a context graph layered over Git-compatible source storage.**

There are really **four graphs**.

```
                    AGENTIC DEVELOPMENT GRAPH

 ┌───────────────────────────────────────────────────────────┐
 │                                                           │
 │  1. INTENT GRAPH        Why are we doing this?            │
 │                                                           │
 │  2. EXECUTION DAG       What work should happen?          │
 │                                                           │
 │  3. CONTEXT GRAPH       What did agents know/use?         │
 │                                                           │
 │  4. SOLUTION GRAPH      What alternatives resulted?       │
 │                                                           │
 └────────────────────────────┬──────────────────────────────┘
                              │
                              ▼
                   Cloudflare Artifacts
                              │
                              ▼
                     Git repositories
```

Git is underneath the graph.

It isn't being replaced.

---

### 1. Intent Graph

This records **why work exists**.

```
Product Requirement
       │
       ▼
     Intent
       │
       ├──────────────┐
       ▼              ▼
Security goal    Compatibility goal
       │              │
       └──────┬───────┘
              ▼
        Acceptance Criteria
```

Example:

```
Intent I-481

"Implement passkeys"

├── must preserve passwords
├── must support WebAuthn
├── no schema breaking changes
└── auth suite must pass
```

Git doesn't contain this as a first-class structure.

---

### 2. Execution DAG

This records **what work agents perform**.

```
                    Intent
                      │
                architecture
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
      security                 research
          │                       │
          └───────────┬───────────┘
                      ▼
                 implementation
               /       |       \
              A        B        C
               \       |       /
                \      |      /
                   evaluate
                      │
                   decide
```

This is where your DAG/orchestration thinking belongs.

Nodes are:

```
Task
Agent execution
Evaluation
Reconciliation
Decision
```

Edges mean:

```
depends-on
produced-by
consumed-by
evaluates
supersedes
```

---

### 3. Context Graph

**This is probably the actual core IP/product abstraction.**

Every agent execution gets a precise record of what context influenced it.

Suppose Claude performs architecture research:

```
Claude Execution E17
       │
       ▼
Architecture Finding A91
```

Codex consumes it:

```
A91
 │
 ▼
Codex Execution E22
 │
 ▼
ChangeSet C84
```

Now you have:

```
Requirement
    │
    ▼
 Intent
    │
    ▼
 Task
    │
    ▼
Claude E17
    │
    ▼
Artifact A91
    │
    ▼
Codex E22
    │
    ▼
Candidate C84
    │
    ▼
Evaluation E92
    │
    ▼
Decision D12
```

That's your **Context Graph**.

And it answers questions Git fundamentally cannot.

---

### “Why does this code exist?”

Today:

```
git blame

Matthew
commit 821cc
March 4
```

Our platform:

```
src/auth/passkey.rs
        │
        ▼
Candidate C84
        │
        ▼
Codex Execution E22
        │
        ├──── consumed architecture A91
        │
        ├──── consumed security A103
        │
        ├──── task T12
        │
        └──── intent I481
                     │
                     ▼
           "Implement passkeys"
```

Then:

```
Why was this implementation selected?

Candidate C84
     │
     ├── 184/184 tests
     ├── security evaluation PASS
     ├── compatibility PASS
     ├── benchmark +0.7%
     │
     ▼
Decision D12
```

That's significantly richer than commit history.

---

### 4. Solution Graph

This records the **alternatives that didn't ship**.

That's another major departure from GitHub.

Traditional Git development usually collapses toward:

```
main
 │
 A
 │
 B
 │
 C
```

We're intentionally preserving:

```
                         S0
                          │
             ┌────────────┼────────────┐
             │            │            │
             ▼            ▼            ▼
        Solution A   Solution B   Solution C
             │            │            │
            81           97★           89
             │            │            │
             │            ▼            │
             │          SHIPPED        │
             │                         │
             └──── preserved ──────────┘
```

The rejected solutions are valuable information.

They tell future agents:

> We already tried this.

That's huge.

---

### Imagine six months later

A new agent receives:

> Optimize authentication latency.

Instead of only seeing the current source tree, it can query the Context Graph:

```
Current implementation
       │
       ▼
Original Decision D12
       │
       ├── Candidate A
       │      rejected: security issue
       │
       ├── Candidate B ★
       │      selected
       │
       └── Candidate C
              rejected: complexity
```

The agent doesn't waste time rediscovering failed approaches.

This creates **organizational memory for autonomous software development**.

That may be more valuable long-term than the source-control component itself.

---

### The canonical object model

I would simplify the entire domain into about ten entities:

```
Repository
Intent
Task
Execution
Artifact
ContextEdge
Candidate
Evaluation
Decision
Revision
```

And relationships:

```
Intent
  │
  ├──has──────► Task
  │
  │             │
  │             └──executed-by──► Execution
  │                                  │
  │                                  ├──consumes──► Artifact
  │                                  │
  │                                  ├──produces──► Artifact
  │                                  │
  │                                  └──produces──► Candidate
  │                                                   │
  │                                                   ▼
  │                                               Revision
  │
  └────────────────────────────────────────────────────┐
                                                       │
Candidate ◄──── evaluates ──── Evaluation               │
    │                                                  │
    └──── considered-by ─────► Decision ───selects─────┘
```

That graph is the product.

---

### Cloudflare architecture

Now map those abstractions onto infrastructure:

```
┌───────────────────────────────────────────────────────────────┐
│                     AGENTIC CONTROL PLANE                     │
│                          Rust/WASM                            │
│                                                               │
│  API │ MCP │ Auth │ Intent │ Runs │ Context Graph │ Decisions│
│                                                               │
└──────────────────────────────┬────────────────────────────────┘
                               │
                    Rust Durable Objects
                               │
              ┌────────────────┼─────────────────┐
              │                │                 │
              ▼                ▼                 ▼
        Coordination       Decisions        Live state
              │
              ▼
┌───────────────────────────────────────────────────────────────┐
│                       EXECUTION PLANE                         │
│                                                               │
│     Cloudflare Container     Cloudflare Container             │
│                                                               │
│          Claude                   Codex                        │
│             │                       │                          │
│             └──────── MCP ──────────┘                          │
│                                                               │
│             Rust AgentRepo Harness                            │
└──────────────────────────────┬────────────────────────────────┘
                               │
                     candidates/evidence
                               │
             ┌─────────────────┼────────────────┐
             ▼                 ▼                ▼

      Cloudflare          Cloudflare        Durable
       Artifacts              R2            Objects

      SOURCE STATE          EVIDENCE         TRUTH
      Git revisions        logs/context     decisions
      candidates           evaluations      coordination
```

That's much easier to explain.

##### Infrastructure has three jobs

**Artifacts = code**

```
repositories
commits
candidate forks
canonical revision
```

**R2 = evidence**

```
agent output
test reports
benchmarks
context artifacts
large logs
```

**Durable Objects = truth**

```
intent
run state
execution state
context edges
evaluation state
decision
canonical pointer
```

---

### Where Rust fits

Almost all platform logic is Rust.

```
                    RUST PLATFORM

┌─────────────────────────────────────────────────────┐
│ agrepo-core                                         │
│                                                     │
│ Intent / Task / Execution / Candidate / Decision    │
├─────────────────────────────────────────────────────┤
│ agrepo-context                                      │
│                                                     │
│ Context Graph + provenance                          │
├─────────────────────────────────────────────────────┤
│ agrepo-orchestrator                                 │
│                                                     │
│ execution DAG + scheduling                          │
├─────────────────────────────────────────────────────┤
│ agrepo-repository                                   │
│                                                     │
│ candidate / revision / acceptance                   │
├─────────────────────────────────────────────────────┤
│ agrepo-mcp                                          │
│                                                     │
│ cross-agent protocol                                │
├─────────────────────────────────────────────────────┤
│ agrepo-cloudflare                                   │
│                                                     │
│ DO / R2 / Artifacts / Container adapters            │
├─────────────────────────────────────────────────────┤
│ agrepo-worker                                       │
│                                                     │
│ HTTP + MCP + WebSocket                              │
└─────────────────────────────────────────────────────┘

                    Rust/WASM
                       │
               Cloudflare Workers
```

Plus native Rust inside the execution containers:

```
agrepo-agent-runner
agrepo-evaluator
agrepo-publisher
```

Claude and Codex are essentially plugins to this system.

---

### Where MCP fits

MCP is **not the architecture**.

It's an adapter protocol.

That's an important distinction.

```
Claude ──┐
         │
Codex ───┼── MCP ──► AgentRepo Harness
         │
Future ──┘
Agent
```

MCP gives agents access to:

```
context
artifacts
execution state
completion/reporting
```

It means we don't build:

```
ClaudeRepo
CodexRepo
GeminiRepo
```

We build:

```
AgentRepo Protocol
```

and adapters.

---

### What are we selling?

This is where I'd avoid calling it a "Git platform."

That's underselling it.

##### Developer language

> **A multi-agent software engineering runtime.**

Or:

> **A control plane for parallel coding agents.**

##### Enterprise language

> **A system of record for AI-generated software development.**

That's especially interesting.

Companies are going to have the problem:

> 400 agents changed our software this week. Why?

Git alone won't answer that adequately.

You provide:

```
Who/what changed it?
Why?
What context was used?
What alternatives existed?
What tests ran?
Which model produced it?
Which agent reviewed it?
What evidence justified shipping it?
Who approved it?
What was rejected?
```

That's governance + provenance + orchestration.

---

### The deeper business

GitHub's primary historical object is approximately:

> **the code change.**

Your primary object becomes:

> **the software-development decision.**

A decision includes:

```
                    DECISION

Intent
  │
  ├── context
  ├── requirements
  │
  ├── candidate A
  ├── candidate B
  ├── candidate C
  │
  ├── evaluations
  ├── evidence
  │
  └── selected candidate
             │
             ▼
          Revision
```

That's why I think **Context Graph** is a powerful name for one subsystem, but perhaps not the entire product.

The whole thing is closer to a:

### Agentic Software Control Plane

with three core engines:

```
               AGENTIC SOFTWARE CONTROL PLANE

                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
     Execution         Context          Decision
       Engine           Graph            Engine
          │                │                │
          ▼                ▼                ▼
     What runs?       What did it       What ships?
                       know/do?
```

And underneath:

```
                    Cloudflare Artifacts
                           Git
```

That is the conceptual hierarchy I would lock in.

**Git answers:** *What changed?*

**CI answers:** *Did it pass?*

**AgentRepo answers:** *Why was this solution produced, what other solutions were explored, what evidence supported it, and why did this one become canonical?*

That is not new Git. **It's the missing system of record and control plane above Git for autonomous software engineering.**
