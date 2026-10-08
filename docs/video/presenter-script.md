# YonedaRepo presenter script

Production target: **8:48**. Spoken lines are below; visual directions are not narration. Use the measured voice takes and reading holds to meet each scene boundary. This script does not replace the released MP4 until rendered and checked.

## 00:00 to 00:45: What I want a repository to remember

I'm building YonedaRepo because I want a repository to remember why we chose the code that shipped. When several agents work on the same goal, they produce different implementations, make assumptions, and discover things the next agent needs to know. YonedaRepo keeps that context beside the source. This Garden website came from two agents working concurrently on Cloudflare. I'll show their alternatives, a browser failure that shaped the next run, and a fresh agent continuing through MCP. You're watching an edited walkthrough of real product captures, with an AI presenter and voice.

Screen direction: Presenter full-screen for the opening sentence; title lower third Published Juniper Garden site, then checked alternatives from the recorded Garden run

Overlay: Cloudflare Workers + Artifacts | Actual captures, edited walkthrough | AI presenter and voice

## 00:45 to 01:38: A workspace with your own agents

The entry point is a normal website. You create an account with a username and password, save the recovery code, and add a repository. The starter gives you a real Git repository in Cloudflare Artifacts. In Agent providers, you can save named connections for OpenAI, Anthropic, MiMo, ZAI, or Gemini, including more than one key for the same provider. The Worker encrypts those keys and uses them through a scoped proxy. If you already work with a local coding agent, Connect local agent gives you a repository-scoped MCP and Git connection instead. That route keeps your model credentials on your machine.

Screen direction: Current Create account screen; hide password and recovery-code fields Named provider connections dialog with provider options New repository dialog, then local-agent setup with all tokens covered

Overlay: Choose hosted agents with your keys, or connect your local agent

## 01:38 to 02:30: One brief, several approaches

A run starts with the goal and the checks that will count as evidence. For a small website, that includes the expected pages, browser behavior, and static output. You choose between two and four hosted approaches, give each a strategy, and select the context they should share. The run freezes the source revision, context, model and connection before work starts. In the recorded Garden run, Luna took a botanical editorial approach. Sonnet built a compact community noticeboard. Both started with the same approved brief. They worked in separate source forks, so one agent could change the design without overwriting the other's work.

Screen direction: Current New development run dialog, showing four approach fields; do not submit Cut to recorded Garden run with Luna and Sonnet

Overlay: Composer shown as a draft | Recorded Garden run used two real hosted agents

## 02:30 to 03:26: Concurrent work and independent evidence

Their runtime records show just over eighty-seven seconds of overlapping harness execution. That measures the agents doing work, rather than jobs waiting in a queue. Each execution has its own attempt identity and transcript. When an agent finishes, the platform validates the files and creates a fresh captured Git revision. A separate evaluator checks that exact revision in a clean environment. The resulting card shows the source changes, check evidence, and a website preview. I care about that separation because an agent saying it finished is a claim. The capture and evaluation give the reviewer something concrete to inspect. Passing a limited test still has a limited meaning.

Screen direction: Concurrency diagram from release evidence; separate agent execution bars Captured revision and independent check details on an actual candidate

Overlay: 87.117 seconds of measured harness overlap | Fresh capture -> separate evaluation

## 03:26 to 04:19: A failure worth remembering

An earlier Garden candidate passed its HTML and anchor checks. Then browser review found that choosing an event category changed the selected button but left all the cards visible. We recorded that failure as a typed finding. The next run received it as part of the approved context, and both agents referred to it in their requirements and alternatives. Their new previews hid the nonmatching cards and restored them when All was selected. This is the part I want future agents to inherit: the failed behavior, the evidence, and what changed because of it. The graph records those relationships without treating every agent-written explanation as a verified fact.

Screen direction: Recorded filter failure finding with its provenance Actual captured All/category filter transitions from the two Garden previews

Overlay: Earlier HTML checks passed; browser review found a defect | Finding reused in the next run

## 04:19 to 05:22: The shipping decision belongs in the product

The owner compares eligible approaches and chooses what ships in the website. Select approach opens a review dialog with the captured revision and a reason for the decision. The engine then verifies publication before the UI reports that revision as published. For Garden, the owner chose Sonnet in the implementation conversation, and that explicit choice was entered through the website with its provenance recorded. Sonnet used upcoming October and November dates; Luna's otherwise polished version listed May dates. Canonical Git and the hosted assets read back as the selected revision. On this separate Field Notes follow-up, the dialog is open for review, but I'm closing it without publishing. Its existing website keeps serving the earlier revision. A preview, an eligible candidate, and a published site are different states.

Screen direction: Current review dialog on the unpublished Field Notes follow-up Close review without submitting; published HEAD stays unchanged Recorded owner-directed Garden decision, then public Garden website

Overlay: Garden: owner-directed selection, verified publication | Field Notes follow-up: still unpublished

## 05:22 to 06:12: Browse the reasons behind the source

The workspace has separate views for Runs, Context graph, and Source history. The graph contains typed requirements, assumptions, findings and alternatives, connected to the work that produced them. You can search, filter by type, and follow relationships such as supports or supersedes. Source history begins with an exact revision and path. It traces that source back to the decision, checked candidate and original intent. The discarded approach stays available too. A developer joining later can inspect why the team made a choice and what evidence existed at the time. An assumption that a later agent challenged remains visible as part of that history.

Screen direction: Current Context graph; search for membership and inspect the superseding finding Source history for published Field Notes public/index.html; show automated verification provenance

Overlay: Source revision -> decision -> evaluated candidate -> intent and context

## 06:12 to 07:12: A fresh agent can continue through MCP

We also exercised this with a fresh local Codex process. The first process built Field Notes Club through scoped MCP and Git, then submitted its fork for normal capture and checks. Its first publication was recorded as automated development verification, so the evidence says exactly who made that decision. A second, fresh process queried the intent, history, decision and check artifact. It noticed that the original acceptance scope was static, while the published page implied a working membership signup. It changed the copy to say signup wasn't connected, and recorded a finding that superseded the earlier assumption. That checked follow-up is the one waiting for review. The handoff worked through the repository's recorded context; the second process didn't receive the first process's conversation.

Screen direction: Diagram of fresh process -> scoped MCP queries -> Git fork -> capture/checks Actual follow-up diff showing the honest membership placeholder Read-only MCP evidence excerpts with credentials and capability URLs removed

Overlay: Fresh local process | Scoped MCP + Git | Checked follow-up awaiting owner review

## 07:12 to 08:05: How the Cloudflare pieces fit

Rust owns the domain rules, durable transitions, source capture and verification. A Repo Durable Object holds the authoritative SQLite ledger. State changes, graph records, ordered events and the outbox commit together. Queues drive isolated container jobs; D1 is a discovery index, and live updates tell the browser when to refresh. Artifacts holds the Git repositories and forks. R2 holds evidence and static manifests. A separate sites Worker serves the generated website. For another Cloudflare account, the README lists the manual prerequisites and resource commands. The Rust deployment command generates account-specific configuration, applies migrations, deploys the Workers and container, and initializes the starter. Local checks run without paid model inference.

Screen direction: Architecture diagram matching the actual Repo DO / Queues / Containers / Artifacts / R2 boundaries README deployment commands; hide real IDs, tokens and private files

Overlay: Rust domain + Cloudflare infrastructure | Account-specific deployment scripts

## 08:05 to 08:48: What you can use today

You can try YonedaRepo, connect your agents, compare checked alternatives, publish a static website, and let the next agent recover its context. The source is Apache licensed. Luna and Sonnet have completed live runs; Gemini's native CLI and MCP path passed an offline integration check, with paid acceptance still pending. Full-stack hosting, automatic semantic merges, and questions that pause and resume a run are future work. I want the next Git platform to make concurrent development understandable. YonedaRepo's contribution is preserving the reasons and evidence alongside the revision you choose to ship.

Screen direction: Presenter returns beside the public Garden website End card with source, try-it URL and README; keep links readable for the final six seconds

Overlay: github.com/MagnetonIO/yonedarepo | Apache-2.0 | Try it and deployment instructions in README
