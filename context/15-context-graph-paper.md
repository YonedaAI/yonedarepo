# 15. YonedaRepo Context Graph research paper

[Index](index.md) · [Previous](14-intentional-history.md) · [Next](16-paper-drive-sharing.md)

*Substantive turn 15 of 18, in original conversation order.*

## User

Write arxiv style paper latex and pdf 20-30 pages long on the design, architecture, and “theory” of context graph “YonedaRepo”

The Context Graph is a persistent causal graph connecting production code to the intent, context, decisions, alternatives, and evidence that created it.

Using conte t within this session and other projects online including cloudflare 

Author 
Matthew Long
The YonedaAI Collaboration
Magneton Independent Research Programme
Chicago, IL
research@yonedaai.com·matthew.long@yonedaai.com

## ChatGPT

### YonedaRepo: Intentional History and Context Graphs for Agentic Software Engineering

Completed as a **28-page arXiv-style research preprint**, with your specified author, affiliations, and contact information.

The paper includes **34 references, four architecture diagrams, formal definitions, conditional propositions, and reproducible specification checks**.

It develops four main areas:

- **Context Graph theory:** typed provenance, intent, assumptions, alternatives, temporal scope, witness closure, and a carefully bounded connection to the Yoneda lemma.

- **Engineering architecture:** Rust/Wasm Workers and Durable Objects, native Rust execution containers, Cloudflare Artifacts for source history, and R2 for context and evidence.

- **Cross-harness integration:** Codex CLI and Claude Code using the same Rust MCP interface, with capture, verification, and publication outside the agents’ authority.

- **Maintenance and evaluation:** an illustrative database-timeout investigation, assumption monitoring, and a proposed study comparing intentional history with Git, ADRs, transcripts, and retrieval systems.

The central framing is **a context and decision layer above Git—not a replacement for Git**. The paper distinguishes recorded process provenance from proof of causation, and explicit rationale from hidden model reasoning.

Both LaTeX versions were compiled successfully, and all 28 PDF pages were rendered and reviewed. The bundle contains the executed finite-model checks and their results; it does **not** claim a deployed Cloudflare application or measured maintenance improvements.

### Referenced artifacts

The original response attached or offered `YonedaRepo_Context_Graphs.pdf`, `YonedaRepo_Context_Graphs.tex`, and `YonedaRepo_LaTeX_Source.zip`. This export preserves the discussion turn; those separately generated artifacts are not embedded. The following turn preserves the available Drive link.
