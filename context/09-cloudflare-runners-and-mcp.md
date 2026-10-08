# 09. Cloudflare runners and minimal MCP contract

[Index](index.md) · [Previous](08-claude-and-codex.md) · [Next](10-prototype-and-trust-boundary.md)

*Substantive turn 9 of 18, in original conversation order.*

## User

This needs to run on cloudflare

For the Claude/Codex integration

*  Compare local and managed Codex runners
*  Define the minimal MCP tool contract

## ChatGPT

Yes. If **Cloudflare must be the platform**, I would change the recommendation slightly:

> **Cloudflare owns the control plane, repository state, MCP server, and execution sandboxes. Claude/Codex are interchangeable agent brains.**

For Codex, the strongest architecture is actually a **hybrid of “managed harness + Cloudflare-hosted execution.”** OpenAI's Agents API supports self-hosted environments: OpenAI runs the Codex harness, while codex exec-server runs inside infrastructure you control and connects outbound over WebSocket. A Cloudflare Sandbox/Container is a plausible environment for that executor. [OpenAI Developers+1](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)

#### Local vs managed Codex runner

There are three relevant choices:

|  | Codex CLI in Cloudflare Sandbox | Managed Codex + OpenAI sandbox | Managed Codex + Cloudflare sandbox |
| --- | --- | --- | --- |
| Harness | You | OpenAI | OpenAI |
| Code execution | Cloudflare | OpenAI | **Cloudflare** |
| Repository authority | Cloudflare | Cloudflare | Cloudflare |
| MCP | Cloudflare | Cloudflare remote MCP | Cloudflare / environment |
| Isolation | Cloudflare Container | OpenAI sandbox | **Cloudflare Container** |
| Orchestration burden | Higher | Lowest | Medium |
| Environment control | Excellent | Less | **Excellent** |
| Cloudflare-native story | Excellent | Weakest | **Excellent** |
| My choice | MVP alternative | No | **Target architecture** |

Cloudflare's current Sandboxes are isolated Linux microVM/container environments controlled by Workers, specifically intended for things such as coding agents, generated code, builds, and CI. The Worker decides what data and network access each sandbox gets. [Cloudflare Docs+1](https://developers.cloudflare.com/sandbox/)

##### Option A — Codex CLI entirely inside Cloudflare

This is the most Cloudflare-native implementation:

```
Cloudflare Worker
       │
       ▼
     RunDO
       │
       ▼
 Cloudflare Sandbox
 ┌───────────────────────────┐
 │ /workspace                │
 │                           │
 │ Codex CLI                 │
 │ git/ripgrep/compiler      │
 │ AgentRepo MCP client      │
 │                           │
 │ exec-A filesystem         │
 └─────────────┬─────────────┘
               │
               ▼
        AgentRepo MCP
               │
               ▼
           RepoDO
```

Cloudflare's container environment is a full Linux environment and can run arbitrary languages/processes; custom images let you preinstall the Codex CLI, Rust, Git, Node, test tools, etc. [Cloudflare Docs+1](https://developers.cloudflare.com/sandbox/)

You could therefore build an image containing:

```
FROM <cloudflare sandbox base>

RUN npm install -g @openai/codex

RUN apt-get install -y \
    git \
    ripgrep \
    build-essential

RUN rustup ...
```

Then your Worker essentially does:

```
create sandbox(exec_id)
      ↓
materialize S0
      ↓
start Codex
      ↓
Codex edits /workspace
      ↓
tests
      ↓
diff workspace against S0
      ↓
ChangeSet
```

You control everything except inference.

##### Why I wouldn't make this the final architecture

You'd also be taking responsibility for Codex process lifecycle, session recovery, compaction, orchestration behavior, upgrades, etc.

OpenAI already provides that as the managed Codex harness through Agents API. [OpenAI Developers](https://developers.openai.com/api/docs/guides/agents-api/overview)

So there's a cleaner option.

---

### Managed Codex + Cloudflare execution

This is the architecture I'd target.

```
                       YOUR PLATFORM
                         Cloudflare
                            │
                            ▼
                       Worker API
                            │
                    ┌───────┴────────┐
                    │                │
                  RunDO            RepoDO
                    │                │
                    │                ├── HEAD
                    │                ├── ChangeSets
                    │                └── decisions
                    │
                    ▼
              OpenAI Agents API
                    │
             managed Codex harness
                    │
                    │ commands
                    ▼
           Cloudflare Sandbox
        ┌────────────────────────┐
        │ codex exec-server      │
        │                        │
        │ /workspace             │
        │ compiler               │
        │ tests                  │
        │ git/ripgrep/etc.       │
        └───────────┬────────────┘
                    │
                    ▼
               AgentRepo MCP
                    │
                    ▼
                 Worker
```

OpenAI explicitly supports this arrangement: the managed harness can use a **self-hosted sandbox**, where codex exec-server runs in your environment, handles shell/files/local MCP, and connects outbound to OpenAI. [OpenAI Developers](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)

That means Cloudflare still owns the actual code execution.

And the Cloudflare sandbox can be network-restricted.

That's important.

---

### Claude gets the same abstraction

Then Claude shouldn't change your architecture at all:

```
                       RunDO
                         │
                  AgentRuntime
                    /        \
                   /          \
              Claude          Codex
                │               │
                └──────┬────────┘
                       ▼
              Cloudflare Sandbox
                       │
                    workspace
                       │
                       ▼
                 AgentRepo MCP
```

Different adapter.

Same protocol.

So your Rust core sees:

```
pub enum AgentRuntimeKind {
    Claude,
    Codex,
}
```

not fundamentally different repository semantics.

---

### Minimal MCP contract

And I'd make this **much smaller** than the earlier version.

The agent already has:

```
filesystem
shell
grep
compiler
tests
```

inside its Cloudflare Sandbox.

Therefore MCP should **not** duplicate:

```
read_file
write_file
delete_file
grep
shell
```

That's wasted complexity.

MCP exists for **coordination with AgentRepo**.

I think you need only **five tools**.

#### repo_context

Called when execution starts.

```
struct RepoContextInput {}

struct RepoContextOutput {
    execution: ExecutionId,
    run: RunId,

    intent: String,
    task: String,

    base_snapshot: SnapshotId,

    constraints: Vec<String>,

    dependencies: Vec<ArtifactRef>,
}
```

The server derives execution identity from authentication.

The model cannot request:

```
execution = someone else's execution
```

That's important.

---

### artifact_get

Consume an upstream agent artifact.

```
struct ArtifactGetInput {
    artifact: ArtifactId,
}
```

Example:

```
artifact_get(A41)

→

Security analysis:

AuthProvider currently...
```

Only artifacts authorized by the execution DAG are readable.

---

### artifact_publish

Publish reusable agent knowledge.

```
struct ArtifactPublishInput {
    kind: ArtifactKind,

    title: String,

    body: String,
}
```

Kinds could initially be:

```
enum ArtifactKind {
    Analysis,
    Plan,
    Finding,
    ApiContract,
    TestResult,
}
```

This is how agents communicate.

Not arbitrary direct messages.

---

### execution_status

Optional but useful for longer runs:

```
struct ExecutionStatusInput {
    phase: ExecutionPhase,
    message: String,
}
```

For example:

```
execution_status({
    phase: "testing",
    message: "Implementation complete; running auth suite"
})
```

This powers your UI:

```
Claude A     analyzing
Codex B      testing
Codex C      implementing
```

It isn't repository state.

---

### execution_complete

This is the critical one.

```
struct ExecutionCompleteInput {
    summary: String,

    published_artifacts: Vec<ArtifactId>,
}
```

That's basically it.

Not:

```
changeset_id
snapshot_id
files_changed
tests_passed
score
```

because **the agent should not be trusted to tell you those things.**

Instead:

```
Agent
  │
  │ execution_complete()
  ▼
Harness
  │
  ├── freeze workspace
  │
  ├── diff against S0
  │
  ├── hash blobs
  │
  ├── construct operations
  │
  ├── construct Snapshot
  │
  └── construct ChangeSet
  │
  ▼
Evaluator
```

That's an extremely important trust boundary.

---

### So the entire MCP contract is

```
┌─────────────────────────────────────────┐
│              AgentRepo MCP              │
├─────────────────────────────────────────┤
│                                         │
│ repo_context()                          │
│                                         │
│ artifact_get(id)                        │
│ artifact_publish(kind, title, body)     │
│                                         │
│ execution_status(phase, message)        │
│ execution_complete(summary, artifacts) │
│                                         │
└─────────────────────────────────────────┘
```

Five tools.

I wouldn't add another one until the prototype proves it needs it.

MCP guidance itself recommends exposing narrow tools tied to recognizable goals rather than exposing infrastructure wholesale. [OpenAI Developers](https://developers.openai.com/plugins/build/mcp-server)

---

### MCP runs on Cloudflare Worker

This is also nice architecturally.

Your MCP endpoint is simply:

```
https://api.agentrepo.dev/mcp
```

implemented by your Cloudflare Worker:

```
                    Internet
                       │
              /mcp Streamable HTTP
                       │
                       ▼
                Cloudflare Worker
                       │
           ┌───────────┼────────────┐
           ▼           ▼            ▼
         RepoDO       RunDO         R2
```

Both Codex and Claude Code support remote HTTP MCP-style integrations; Codex can connect directly to an HTTP MCP server from the managed service as well. [OpenAI Developers+1](https://developers.openai.com/learn/docs-mcp)

So **you don't need an MCP process inside every sandbox**.

The sandbox needs a client connection to your Cloudflare endpoint.

---

### Authentication

I'd issue an **execution-scoped capability token** when the sandbox starts.

Something conceptually like:

```
execution_token =
    signed {
        repo: repo_123
        run: run_456
        execution: exec_789

        capabilities: [
            context:read,
            artifact:read:dependencies,
            artifact:publish,
            execution:status,
            execution:complete
        ]

        expires: ...
    }
```

Then:

```
Authorization:
Bearer <execution-token>
```

The MCP server derives:

```
repository
run
execution
permissions
```

from that token.

Never accept them as authoritative tool arguments.

Thus this is impossible:

```
artifact_get(
    repo = microsoft/windows,
    artifact = ...
)
```

because the execution token establishes the namespace.

---

### Sandbox network policy

I'd make the sandbox extremely constrained.

Conceptually:

```
ALLOW

api.openai.com
Codex environment WebSocket
api.agentrepo.dev

DENY

everything else
```

Cloudflare explicitly gives the Worker control over whether sandbox code gets public Internet access, and their sandbox architecture supports controlled connections back into Worker bindings. [Cloudflare Docs+1](https://developers.cloudflare.com/sandbox/)

This prevents an agent from bypassing:

```
AgentRepo MCP
```

and mutating infrastructure directly.

---

### Then your multi-agent run becomes

```
                         INTENT
                            │
                         RunDO
                            │
             ┌──────────────┼──────────────┐
             │              │              │
             ▼              ▼              ▼
          exec-A          exec-B          exec-C
             │              │              │
          Claude          Codex          Codex
             │              │              │
             ▼              ▼              ▼
        CF Sandbox A   CF Sandbox B   CF Sandbox C
             │              │              │
           work A          work B         work C
             │              │              │
             └──── complete ┼──── complete ┘
                            │
                            ▼
                      freeze + diff
                            │
                ┌───────────┼───────────┐
                ▼           ▼           ▼
              CS-A        CS-B        CS-C
                │           │           │
                ▼           ▼           ▼
               S-A         S-B         S-C
                │           │           │
                └───────────┼───────────┘
                            ▼
                         evaluate
                            │
                         winner
                            │
                            ▼
                          RepoDO
                            │
                            CAS
                            ▼
                           HEAD
```

#### What I'd build first

For the Cloudflare submission, I'd actually start with **Codex CLI inside Cloudflare Sandbox** because it makes the demonstration self-contained:

> "Here are three Cloudflare sandboxes. Each is running an autonomous coding agent against the exact same immutable snapshot."

Cloudflare documents Sandboxes specifically as suitable for coding agents and build pipelines, and they're built on isolated Containers controlled through Workers. [Cloudflare Docs](https://developers.cloudflare.com/sandbox/)

Once that works, replace the Codex CLI runner with **managed Codex harness + codex exec-server in the same Cloudflare Sandbox**. Your repository protocol, MCP API, Snapshot/ChangeSet model, evaluation system, and UI don't change. [OpenAI Developers+1](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)

That gives you the right separation:

> **Cloudflare owns state + compute + isolation + orchestration. OpenAI/Anthropic provide intelligence. MCP is the narrow protocol connecting the intelligence to your agentic repository.**

[Cloudflare Sandboxes documentation](https://developers.cloudflare.com/sandbox/)

[OpenAI self-hosted Codex environments](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)

[OpenAI MCP connections for Agents API](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp)
