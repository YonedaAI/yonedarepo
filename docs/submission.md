# YonedaRepo submission

YonedaRepo treats a development run as a shared intent and a set of concurrent alternatives. Agents preserve typed context while they work. Independent capture and checks attach evidence to exact revisions; the owner selects what ships, and a future agent can query why through MCP.

- **Video:** [October 10 reviewer walkthrough](https://github.com/MagnetonIO/yonedarepo/releases/download/reviewer-2026-10-10/yonedarepo-reviewer.mp4), a captioned edit of actual browser captures and live evidence. It documents the earlier release; refresh for the current production source is pending. See [script and production notes](demo-video.md).
- **Source:** [MagnetonIO/yonedarepo](https://github.com/MagnetonIO/yonedarepo), Apache-2.0. The public-source refresh to the current production revision is pending.
- **Try it:** [hosted platform](https://yonedarepo.com/). Reviewer access is prepared, but human rehearsal remains pending until the development run is complete. The previously approved paid Git-native Build Together run is awaiting Durable Object code adoption and its repair after the deployed ownership fix; its outcome is unknown. From the public source, `node tools/reviewer.mjs` opens the recorded checked example without installing dependencies. For read-only CLI inspection, use `node tools/reviewer.mjs --key-file /path/to/access.json --checked --no-open`; this reads an owner-private access file, does not start a trial, and prints the review URL. Run `--help` for all options. `--new` explicitly approves another funded trial.
- **Immediate public example:** [Juniper Garden](https://yonedarepo-sites-dev.mlong-f01.workers.dev/p/yoneda-garden-live/), built by concurrent Luna/Sonnet agents and published after an owner-directed selection.
- **Run locally:** [README](../README.md#get-running) and [runbook](runbook.md). The local gate needs no inference keys; local Artifacts access requires Cloudflare authentication and configured resources.
- **Connect your existing agent:** [remote MCP and Git setup](remote-mcp.md), using a revocable repository-scoped key from the website.
- **Evidence and limits:** [release verification](release-evidence.md) and [machine-readable record](release-evidence.json).

## Reviewer hands-on path

1. Enter the reviewer access key. The sandbox opens with configured agents and recorded runs.
2. Choose **Run prepared example** or use `node tools/reviewer.mjs` to open the recorded checked example immediately. The command prompts for the same key without echoing it. Use `--key-file /path/to/access.json --checked --no-open` for read-only CLI inspection; add `--new` only to approve another trial. One trial may run at a time; each trial is limited to $5 within a shared $50 allowance.
3. Watch the two specialists' activity and captured handoffs, then review the integrated exact revision and independent checks.
4. Open **Evidence trail** to read intent, assertions, trusted capture, checks and the owner's rationale at normal text size. **Explore graph** provides the optional relationship view.
5. Select an eligible candidate, record the decision and wait for verified publication. Reviewer publication affects only the sandbox. A failed or conflicting publish can be reconciled using **Recover repository**, which reads the actual canonical Git HEAD and retains the failed decision as history.

Use a project-specific test profile: the starter HTML smoke check does not prove all browser interactions or product requirements. Hosted sites are isolated relative-path static output; full-stack applications and external API calls require a future deployment profile.

## Current verification

Production rollout is complete: Worker version `7a159115-15af-4353-8132-da744dfdae52` runs code revision `68fb72e`, app version 24, with all seven health checks passing. The pinned Linux runtime image passed 71 tests at `sha256:4b5439bb9e9504b3ee0466bf73edfa77ae02addea599707e1b3a7615f2f197b6`. A root-UID Git dubious-ownership failure was reproduced RED and fixed GREEN in `f92aa6f`; the fix is in the deployed image.

The current local gate passed: 278 Rust tests (181 app, 16 core, 65 runtime, 1 Cloudflare and 15 xtask), 286 Workers tests across 56 files, 55 frontend tests across 13 files, and 11 Node tests. Formatting, Clippy, TypeScript, Wasm and production builds also passed.

Isolated hosted acceptance at 2026-10-10 20:35:37 UTC used a controlled fixture with no paid inference. It exercised Git contribution capture, controlled capacity deferrals with refunded attempts, injected publication acknowledgment loss followed by retry and canonical readback, and a disjoint two-parent refresh whose fresh evaluation passed. This demonstrates those bounded scenarios; it does not establish broad capacity, scale, overlapping conflict resolution, or human acceptance. See the machine-readable [platform acceptance record](platform-acceptance.json).

The earlier paid Git-native Build Together run failed after both agents finished editing because Git rejected `/work/repo` as dubious ownership under the root process. The regression was fixed RED to GREEN and deployed; the repair of that same approved run is about to execute, and its result is unknown. This work remains in progress and is not yet Build Together acceptance. The prior checked Claude `claude-sonnet-5-5` run `reviewer-f07f61a0-97b6-48e9-b9de-521753744063` remains historical evidence for an earlier deployed version: candidate `20dc24de9`, canonical published HEAD `3bbe63325`. Candidate and published revisions differ. The checked-in [reviewer acceptance record](reviewer-acceptance.json) is older historical evidence. Human reviewer rehearsal is planned after the development run and remains pending. Public source/video refresh is pending; competition form submission and any entry agreement remain the entrant's actions.

## Delivered source wave

The deployed wave includes Git-native isolated workspaces and revision-based external contribution capture; paged repository history with a stable watermark and on-demand run detail; verified archive storage with hot-history compaction and detail read-through; and an active-work cap based on live jobs and executions rather than lifetime run totals. Metadata pages omit graph nodes and diffs; detail reads fetch them on demand. It also includes bounded iterative repair, immutable test bundles with approval for test-set edits, file-level provenance, and Git conflict inspection, refresh and resolver workflows. Local gate and isolated production acceptance are recorded separately above; the controlled exercise does not establish human acceptance, broad throughput, or a successful paid Build Together reviewer trial.

## Direction and remaining gaps

The useful product direction is an evidence and coordination layer for agent-written code: preserve intent and assertions, capture exact source, independently check it, record a human choice, and make the history available to later agents. The market comparison supports prioritizing that evidence trail, conflict recovery and low-friction review. It does not establish that YonedaRepo is unique or that its context graph improves coding outcomes.

| Primary comparison | Existing capability | Implication for YonedaRepo |
|---|---|---|
| [Cursor worktrees and best-of-n](https://cursor.com/docs/configuration/worktrees) | Parallel models use isolated checkouts; results can be compared and applied. | Parallel alternatives alone provide little differentiation. Make captured evidence and decision lineage the main product. |
| [GitHub Copilot agents](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents) | Delegate work on branches or PRs, track sessions, iterate and review output. | Review/progress are expected capabilities. Explain the assertion → capture → check → decision authority chain clearly. |
| [CAID: Effective Strategies for Asynchronous Software Engineering Agents](https://arxiv.org/abs/2603.21489v2) | Central delegation, dependency plans, concurrent isolated workspaces and tested integration. | Build together follows a supported coordination direction. The current source adds Git-native workspaces, explicit repair and conflict-refresh flows; the paper's reported performance gains are not measurements of this platform. |

| Gap | Current delivery | Next recommendation |
|---|---|---|
| Reviewer setup and readability | Dedicated sandbox, one-key login, recorded example command and readable evidence trail are prepared; human rehearsal remains pending after the development run. | Conduct the clarified post-development reviewer rehearsal and measure time to first useful review. |
| Runtime/lifecycle failure | Root-UID Git ownership regression fixed and deployed; controlled hosted capacity deferrals and publication acknowledgment-loss recovery passed. | Exercise sustained contention and restart combinations before making throughput or scale claims. |
| Agent awareness and conflicts | Same-run peer status, visible task scopes/dependencies, and a controlled disjoint cross-run refresh with a fresh eligible evaluation. | Owner-approved overlapping resolver and broader contention remain unverified. Automatic semantic merge quality is not claimed. |
| Team iteration | Frozen task inputs, integrated checks and bounded iterative repair are in the current source; a same-approved-run hosted repair is about to execute. | Record that repair outcome, then conduct the human reviewer rehearsal. Both remain pending. |
| Scale and Git compatibility | Git-native workspaces, paged reads, archive/detail read-through and the six-live-work cap passed the current local gate; the hosted fixture covered only bounded capacity deferrals. | Measure sustained and parallel load before making runtime-scale claims. |
| Evaluation and provenance | Exact revision/policy checks, immutable approved test bundles, explicit test-edit approval and file-level provenance are in current source; current local gate passed. | Human reviewer comprehension and controlled comparisons are still needed to establish context-use benefit. |

No large-scale throughput, semantic merge resolution, or causal context-use benefit is claimed for this prototype.
