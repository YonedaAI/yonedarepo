# 08. Claude Code and Codex integration

[Index](index.md) · [Previous](07-agent-harness-integration.md) · [Next](09-cloudflare-runners-and-mcp.md)

*Substantive turn 8 of 18, in original conversation order.*

## User

How to build into Claude or codex?

## ChatGPT

Yes. For **Claude Code and Codex specifically**, I would integrate this at the **harness/tool layer**, not modify either model.

The architecture becomes:

```
                    Your Agentic Repo
                           │
                    ExecutionSpec
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
        Claude Code                   Codex
             │                           │
             └─────────────┬─────────────┘
                           │
                    AgentRepo MCP
                           │
                    workspace tools
                           │
                           ▼
                Cloudflare control plane
```

Both ecosystems already support MCP-style tool integration, and Codex can additionally be driven through OpenAI's managed Agents API or run as an MCP server itself. [OpenAI Developers+2](https://developers.openai.com/learn/docs-mcp)

#### 1. Build agrepo-mcp

This is the compatibility layer I'd build first.

Expose perhaps eight tools:

```
agrepo.context
agrepo.read
agrepo.search

agrepo.write
agrepo.delete

agrepo.test

agrepo.publish_artifact
agrepo.complete
```

For example:

```
#[derive(Deserialize)]
pub struct WriteRequest {
    pub execution_id: ExecutionId,
    pub path: RepoPath,
    pub content: String,
}

#[derive(Serialize)]
pub struct WriteResult {
    pub operation_id: OperationId,
    pub path: RepoPath,
}
```

But the MCP server knows:

```
execution_id → run
             → immutable base snapshot
             → isolated workspace
             → permissions
             → intent
             → task
```

The model doesn't control those values.

That's your security boundary.

---

### 2. Claude Code

For Claude Code, I'd connect your MCP server directly.

Conceptually:

```
claude mcp add --transport http \
  agrepo \
  https://repo.yourdomain.com/mcp
```

Claude Code supports remote HTTP MCP servers, so this is already a natural extension point. [OpenAI Developers](https://developers.openai.com/learn/docs-mcp)

Then Claude sees tools resembling:

```
agrepo__context
agrepo__read
agrepo__search
agrepo__write
agrepo__delete
agrepo__test
agrepo__complete
```

Your execution prompt could be extremely small:

```
You are execution exec_481.

Implement the assigned task.

The agrepo tools are the authoritative repository interface.
Do not publish, merge, push, or alter canonical repository state.
When finished, call agrepo.complete.
```

Claude works normally:

```
Claude
  │
  ├── agrepo.context()
  │
  ├── agrepo.search("AuthProvider")
  │
  ├── agrepo.read(...)
  │
  ├── agrepo.write(...)
  │
  ├── agrepo.test("auth")
  │
  └── agrepo.complete(...)
```

complete() doesn't merge anything.

It tells your harness:

> Agent has finished proposing changes.

The harness computes the ChangeSet.

---

### 3. Codex

There are actually **three good Codex integrations** now.

##### Option A — Codex + MCP

For a local/CLI Codex experience, connect your MCP server similarly. Codex's MCP configuration is shared between its CLI and IDE extension. [OpenAI Developers](https://developers.openai.com/learn/docs-mcp)

Then put the repository protocol into AGENTS.md.

Codex automatically discovers and injects AGENTS.md instructions, including hierarchical instructions from the repository root toward the working directory. [OpenAI Developers](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.3-codex)

For example:

```
# Agentic Repository Protocol

This repository is managed by AgentRepo.

Use the `agrepo` MCP tools for repository operations.

You are working against an immutable base snapshot.

Never:
- push
- merge
- update canonical HEAD
- create Git branches as coordination mechanisms

You may:
- inspect the assigned snapshot
- modify your isolated workspace
- run approved tests
- publish artifacts

When the task is complete, call `agrepo.complete`.
```

Now Codex naturally participates in your protocol.

---

### 4. Codex Agents API is even more interesting

For the actual Cloudflare product, this may eventually be the cleanest Codex integration.

OpenAI's Agents API provides a **managed Codex harness** where the application supplies tools and chooses the execution environment. It supports sandboxes, MCP servers, sessions, durable execution, and agent orchestration. [OpenAI Developers+1](https://developers.openai.com/api/docs/guides/agents-api/overview)

So instead of:

```
Cloudflare
    ↓
launch Codex CLI
    ↓
manage process
```

you can have:

```
Cloudflare RunDO
       │
       │ ExecutionSpec
       ▼
 OpenAI Agents API
       │
       ▼
   Codex harness
       │
       ├── sandbox
       │
       └── AgentRepo MCP
                │
                ▼
          Cloudflare Worker
```

Your application remains the repository authority.

OpenAI manages the Codex execution environment.

That's a very clean separation.

---

### 5. And Codex can run *as* an MCP server

There's another architecture worth paying attention to.

OpenAI documents running Codex CLI itself as an MCP server, exposing Codex operations to an external orchestrator. They've specifically demonstrated multi-agent workflows built this way. [OpenAI Developers](https://developers.openai.com/cookbook/examples/codex/codex_mcp_agents_sdk/building_consistent_workflows_codex_cli_agents_sdk)

That gives you:

```
                    AgentHero / RunDO
                           │
                    orchestration DAG
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
          Codex MCP    Codex MCP    Claude
              │            │            │
             Exec A       Exec B       Exec C
              │            │            │
              └────────────┼────────────┘
                           ▼
                     AgentRepo
```

That fits your DAG architecture particularly well.

---

### 6. But don't replace their filesystem

Here's one thing I'd change from my earlier design.

**Let Claude/Codex use their normal filesystem tools inside an isolated workspace.**

Don't force every:

```
read()
write()
grep()
```

through Cloudflare.

That would be slow and make the agents worse.

Instead:

```
             immutable Snapshot S0
                      │
                materialize
                      ↓
              /workspace/exec-A
                      │
              ┌───────┴────────┐
              │ Claude / Codex │
              │                │
              │ normal tools:  │
              │ read           │
              │ grep           │
              │ edit           │
              │ shell          │
              └───────┬────────┘
                      │
                   finish
                      ↓
               trusted harness
                      │
              diff(S0, workspace)
                      ↓
                  ChangeSet
```

This is substantially better.

The **MCP server is for coordination**, not every byte operation.

So reduce its interface to something more like:

```
agrepo.context

agrepo.task.status
agrepo.task.report

agrepo.artifact.publish
agrepo.artifact.read

agrepo.team.list
agrepo.team.inspect

agrepo.complete
```

The actual code editing stays local.

---

### 7. The harness wraps Claude/Codex

The actual Rust runner becomes roughly:

```
pub trait CodingHarness {
    async fn execute(
        &self,
        spec: ExecutionSpec,
        workspace: Workspace,
    ) -> Result<ExecutionResult>;
}
```

Implementations:

```
pub struct ClaudeCodeHarness {
    // Claude process/API configuration
}

pub struct CodexHarness {
    // Codex process/API configuration
}
```

Then:

```
impl CodingHarness for ClaudeCodeHarness { ... }

impl CodingHarness for CodexHarness { ... }
```

The engine doesn't care which one runs.

```
let harness: Arc<dyn CodingHarness> =
    match execution.agent {
        AgentKind::ClaudeCode => Arc::new(claude),
        AgentKind::Codex => Arc::new(codex),
    };

let result = harness
    .execute(spec, workspace)
    .await?;
```

That's the correct abstraction.

---

### 8. Now heterogeneous agents become powerful

An intent could deliberately launch:

```
                   INTENT
                      │
           "implement auth"
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
      Claude       Codex       Codex
      Opus         GPT-x       GPT-x
          │           │           │
     security     minimal      performance
     approach     approach       approach
          │           │           │
          ▼           ▼           ▼
        CS-A        CS-B        CS-C
          │           │           │
          └───────────┼───────────┘
                      ▼
                  Evaluator
```

Now you're not merely running agents in parallel.

You're treating **models themselves as competing search strategies**.

That's a much stronger idea.

---

### 9. Agents can collaborate through artifacts

Don't have Claude send arbitrary chat messages directly to Codex.

Have Claude publish:

```
ArchitectureAnalysis
SecurityFinding
ImplementationPlan
TestFinding
APIContract
```

Then:

```
Claude
   │
   │ publish
   ▼
Artifact A42
   │
   │ dependency
   ▼
Codex
   │
   ▼
ChangeSet C91
```

Now the repository knows:

```
Why does C91 exist?

C91
 ↑
Codex execution
 ↑
Task 42
 ↑
Artifact A42
 ↑
Claude execution
 ↑
Architecture task
 ↑
Intent 17
```

That's **machine-readable provenance between agents**.

---

### 10. The final architecture

I'd evolve what we've designed into this:

```
                        USER INTENT
                             │
                             ▼
                       AgentRepo Run
                             │
                         Task DAG
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
    Claude Harness      Codex Harness      Codex Harness
          │                  │                  │
          │             Agents API              │
          │                  │                  │
          └──────────────┬───┴──────────────────┘
                         │
                    AgentRepo MCP
                         │
                 artifacts/context
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
      Workspace A    Workspace B    Workspace C
          │              │              │
          ▼              ▼              ▼
        diff()          diff()          diff()
          │              │              │
          ▼              ▼              ▼
        CS-A            CS-B            CS-C
          │              │              │
          └──────────────┼──────────────┘
                         ▼
                    Evaluation
                         │
                    Reconcile
                         │
                         ▼
                    RepositoryDO
                         │
                        CAS
                         │
                         ▼
                       HEAD
```

The important realization is that **you don't need Anthropic or OpenAI to add native support for your source-control model**.

You can build it today because Claude Code and Codex already have the two things you need: an isolated coding harness and extensible tool/context mechanisms. Codex's current APIs go further by explicitly allowing applications to supply tools and execution environments to its managed harness. [OpenAI Developers+1](https://developers.openai.com/api/docs/guides/agents-api/overview)

So I would make **agrepo-mcp + agrepo-harness the next two Rust crates**. Those become the universal adapter that turns existing Claude/Codex coding agents into native participants in your agentic repository protocol.
