# 12. Cloudflare competition MVP build plan

[Index](index.md) · [Previous](11-complete-rust-architecture.md) · [Next](13-engineering-and-business-framing.md)

*Substantive turn 12 of 18, in original conversation order.*

## User

Put the MVP plan together in a markdown for cloudflare competition- will be built by AI - instructions with links and requirements for completion and execution. Rust based code running on cloudflare with harness using MCP  for cross platform or codex api (needs MVP reasoning to use one or other  to show multiple harness support )

## ChatGPT

The document is written as an **implementation specification for an AI coding agent**, with architecture decisions, crate boundaries, execution instructions, **24 completion gates**, and **28 official reference links**.

### Architecture fixed in the plan

| Layer | MVP implementation |
| --- | --- |
| API and coordination | Rust/Wasm Workers and a Rust RepositoryAuthority Durable Object |
| Run management | Records and orchestration inside that authority—**no separate RunDO** |
| Coding execution | Codex CLI and Claude Code in separate Cloudflare containers |
| Harness integration | The same native Rust MCP server binary, using stdio inside each container |
| Source history | Cloudflare Artifacts repositories, candidate forks, and commits |
| Context and evidence | R2 objects with immutable references and recorded consumption |
| Evaluation | Clean execution environments and an external Rust verifier |
| Acceptance | Atomic logical decision followed by recoverable Git publication |

The Rust SDK exposes the Durable Object container handle, but the plan requires a compatibility test before relying on newer platform features that may not yet have typed Rust wrappers. [Docs.rs+1](https://docs.rs/worker/latest/worker/durable/struct.State.html) Cloudflare Artifacts supplies the source-versioning layer, so the MVP does **not** build another Git object database. [Cloudflare Docs](https://developers.cloudflare.com/artifacts/)

### MCP versus managed Codex: the MVP decision

**Use Codex CLI + Claude Code with shared MCP first.**

Both support stdio MCP integration. That gives the competition demo a concrete interoperability claim: **two different coding harnesses using the same repository protocol**, not two models behind one custom agent loop. [OpenAI Developers+1](https://developers.openai.com/codex/mcp/)

“Local” means **inside Cloudflare containers**, not running on your laptop. Managed Codex is an explicitly deferred adapter; it cannot bypass the same capture, evaluation, and acceptance requirements.

### What the AI builder receives

The Markdown includes eight implementation milestones, from **P0: prove the platform and both harnesses** through deployment, recovery tests, and submission packaging. It defines the five MCP tools, scoped authentication, sandbox boundaries, source capture, independent evaluation, race-safe acceptance, budgets, cleanup, and a reproducible cargo xtask command contract.

Completion requires a real demonstration:

> **One intent → concurrent Codex and Claude executions → shared context → competing Artifacts commits → independent evidence → human acceptance → verified canonical publication.**

It also includes an eight-minute demo storyboard and the source/license/runbook checklist matching the competition’s requested **5–10 minute demo, open-source code, and run instructions**. [Cloudflare](https://www.cloudflare.com/git-competition/)

**This is the build specification, not newly deployed software.** The document’s structure, reference definitions, and JSON/TOML examples were checked. Section **20** contains the kickoff prompt to give the implementation agent; it directs the agent to start with P0 and report real evidence rather than claim scaffolding is complete.

### Referenced artifact

The original response attached `AGENTREPO_CLOUDFLARE_MVP_BUILD_PLAN.md`. This export preserves the discussion turn; the separately generated attachment is not embedded in this file.
