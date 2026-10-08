# 07. Agent harness integration

[Index](index.md) · [Previous](06-rust-crate-apis.md) · [Next](08-claude-and-codex.md)

*Substantive turn 7 of 18, in original conversation order.*

## User

So this would be built into the agents how?

## ChatGPT

Exactly—but I **wouldn't build the repository machinery into each agent**. I'd build a small **agent protocol/SDK** into the harness that runs every agent.

The agent should think it's working in a normal workspace. The platform handles snapshots, ChangeSets, provenance, and concurrency around it.

Conceptually:

```
                    AGENTIC REPO PLATFORM
                            │
                     ExecutionSpec
                            │
                            ▼
                    ┌──────────────┐
                    │ Agent Harness│
                    │   Rust SDK   │
                    ├──────────────┤
                    │ workspace    │
                    │ context      │
                    │ artifacts    │
                    │ report()     │
                    └──────┬───────┘
                           │
                           ▼
                    Claude / Codex /
                    custom coding agent
```

The distinction is:

> **Agent = intelligence. Harness = repository participant.**

##### What the agent receives

When the platform launches an agent, don't give it git checkout main.

Give the harness an immutable ExecutionSpec:

```
pub struct ExecutionSpec {
    pub execution_id: ExecutionId,
    pub run_id: RunId,

    pub repository: RepoId,

    pub base: SnapshotId,

    pub intent: Intent,

    pub task: Task,

    pub constraints: Vec<Constraint>,
}
```

For example:

```
Execution: exec-392

Base:
    snapshot 8ac731...

Intent:
    Add passkey authentication.

Task:
    Implement the authentication adapter.

Constraints:
    - password authentication must continue working
    - don't modify database migrations
    - all auth tests must pass
```

The harness materializes that snapshot into an isolated filesystem.

The coding agent sees:

```
/workspace
├── Cargo.toml
├── src/
├── tests/
└── ...
```

and can operate normally.

---

#### The agent-facing Rust SDK

I'd give agents a deliberately tiny interface:

```
pub trait AgentWorkspace {
    async fn read(
        &self,
        path: &RepoPath,
    ) -> Result<Vec<u8>>;

    async fn write(
        &mut self,
        path: &RepoPath,
        bytes: &[u8],
    ) -> Result<()>;

    async fn delete(
        &mut self,
        path: &RepoPath,
    ) -> Result<()>;

    async fn search(
        &self,
        query: &str,
    ) -> Result<Vec<SearchResult>>;

    async fn report(
        &mut self,
        report: AgentReport,
    ) -> Result<()>;
}
```

But **not**:

```
agent.merge()
agent.push()
agent.update_head()
agent.accept_changeset()
```

Those APIs simply don't exist.

That's important.

The agent cannot accidentally—or maliciously—make itself canonical.

---

### What Codex/Claude actually sees

If you're integrating an existing coding agent, you don't necessarily change the model itself.

Instead, expose tools such as:

```
repo.read
repo.search
repo.write
repo.delete

task.status
task.report

artifact.write

test.run
```

So its tool environment becomes:

```
                    LLM
                     │
               tool request
                     │
                     ▼
              Agent Harness
             /      |       \
            /       |        \
      workspace   tests    context
```

The agent might do:

```
repo.search("authenticate")

repo.read("src/auth/provider.rs")

repo.write(
    "src/auth/passkey.rs",
    ...
)

test.run("auth")

task.report({
    summary:
      "Implemented passkey provider while retaining password fallback"
})
```

From the agent's perspective, that's basically normal coding.

---

### The harness creates the ChangeSet

This is the key point.

**Don't ask the LLM to construct ChangeSets.**

When the agent finishes:

```
          immutable S0
               │
               ▼
        materialized workspace
               │
               ▼
             Agent
               │
          edits files
               │
               ▼
         workspace diff
               │
               ▼
           operations
               │
               ▼
           ChangeSet
               │
               ▼
              S1
```

The trusted harness calculates:

```
let operations =
    workspace.diff_against(base).await?;

let result =
    repository.apply(base, &operations).await?;

let changeset = ChangeSet {
    base,
    result,
    execution,
    operations,
    explanation,
    // ...
};
```

The model doesn't get to claim:

> I changed these files.

The system **observes what it actually changed**.

---

### Then multiply that by agents

This is where your architecture becomes powerful.

The coordinator issues:

```
                    Intent I17
                        │
                       S0
                        │
          ┌─────────────┼─────────────┐
          │             │             │
      Execution A   Execution B   Execution C
          │             │             │
      Harness A     Harness B     Harness C
          │             │             │
       Agent A       Agent B       Agent C
          │             │             │
          ▼             ▼             ▼
        CS-A          CS-B          CS-C
          │             │             │
          ▼             ▼             ▼
         S-A           S-B           S-C
```

No agent even needs to know the others exist.

That's **optimistic speculative concurrency**.

---

### But agents should eventually know about other agents

For V2, I'd add a controlled collaboration API.

Something like:

```
pub trait TeamContext {
    async fn siblings(
        &self,
    ) -> Result<Vec<ExecutionSummary>>;

    async fn inspect(
        &self,
        execution: ExecutionId,
    ) -> Result<AgentReport>;

    async fn artifact(
        &self,
        artifact: ArtifactId,
    ) -> Result<Vec<u8>>;

    async fn publish(
        &self,
        artifact: Artifact,
    ) -> Result<ArtifactId>;
}
```

Now Agent C can discover:

```
Agent A:
    researching authentication architecture

Agent B:
    implementing WebAuthn validation

Agent C:
    implementing API integration
```

But I'd make communication **artifact-based rather than mutable shared state**.

Agent A publishes:

```
ArchitectureAnalysis {
    artifact: A93...
}
```

Agent B consumes A93.

This gives you:

```
Agent A
   │
   ▼
Artifact X
   │
   ▼
Agent B
   │
   ▼
ChangeSet B
```

which becomes part of provenance automatically.

---

### This fits your AgentHero idea extremely well

You effectively have two graphs.

##### Execution DAG

```
Analyze
   │
   ├──────────────┐
   ▼              ▼
Security      Architecture
   │              │
   └──────┬───────┘
          ▼
      Implement
       /  |  \
      A   B   C
       \  |  /
       Evaluate
          │
       Reconcile
```

This graph determines **which agents run**.

And separately:

##### Repository DAG

```
                         S0
                    /    |    \
                  CS1   CS2   CS3
                   │     │     │
                  S1    S2    S3
                         │
                         ▼
                       CS-R
                         │
                         S4
```

This graph records **what those agents produced**.

Don't collapse them into one DAG.

That's an important architectural property.

---

### There are really three layers

I'd structure the whole platform as:

```
┌──────────────────────────────────────────────┐
│                COORDINATOR                   │
│                                              │
│ Intent → Plan → Task DAG → Agent scheduling │
└──────────────────────┬───────────────────────┘
                       │
                ExecutionSpec
                       │
                       ▼
┌──────────────────────────────────────────────┐
│                 HARNESS                      │
│                                              │
│ snapshot → workspace → tools → diff → report│
└──────────────────────┬───────────────────────┘
                       │
                   ChangeSet
                       │
                       ▼
┌──────────────────────────────────────────────┐
│              REPOSITORY ENGINE               │
│                                              │
│ objects → snapshots → DAG → evidence → HEAD │
└──────────────────────────────────────────────┘
```

And then:

```
                    MODEL

           Claude / Codex / GPT / local
                      │
                      ▼
                   Harness
                      │
                      ▼
               Repository Engine
```

That makes the repository **model-independent**.

You could have:

```
Claude
Codex
Gemini
local model
human developer
CI bot
refactoring compiler
```

all implement the exact same participant protocol.

That's more interesting than making an "AI Git."

You're defining a **source-control protocol for autonomous software actors**.

#### One more primitive I'd add

Given where we're taking this, I'd introduce a formal:

```
trait RepositoryActor {
    async fn execute(
        &self,
        execution: ExecutionContext<'_>,
    ) -> Result<ActorReport, ActorError>;
}
```

Then identity:

```
enum Actor {
    Human(HumanId),
    Agent(AgentId),
    Automation(AutomationId),
}
```

All three produce:

```
Actor
  ↓
Execution
  ↓
Operations
  ↓
ChangeSet
  ↓
Evidence
```

**Humans and agents become peers at the repository protocol level.**

The difference is not how source control represents their work; it's **who/what produced the execution and what policy is required before that work becomes canonical**.

And that's probably the deeper product idea: **don't build Git features into agents; build a universal agent-repository protocol into the harness surrounding every coding agent.**
