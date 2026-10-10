# YonedaRepo submission

YonedaRepo treats a development run as a shared intent and a set of concurrent alternatives. Agents preserve typed context while they work. Independent capture and checks attach evidence to exact revisions; the owner selects what ships, and a future agent can query why through MCP.

- **Video:** [October 10 reviewer walkthrough](https://github.com/MagnetonIO/yonedarepo/releases/download/reviewer-2026-10-10/yonedarepo-reviewer.mp4), a captioned edit of actual browser captures and live evidence. It documents the earlier release; fresh captures and refresh for the current source wave remain pending. The current video has not been reviewed as current evidence. See [script and production notes](demo-video.md).
- **Source:** [MagnetonIO/yonedarepo](https://github.com/MagnetonIO/yonedarepo), Apache-2.0. Revision `5d32ac4` passed follow-up pnpm checks/tests and is deployed to the development Worker as version `a12a0a89-0064-4a9d-a2d5-b4c0a7f1ce6f`; the full gate remains the `6f39290` result below.
- **Try it:** [hosted platform](https://yonedarepo.com/). Native run `a2f` passed all five checks for eligible, unpublished candidate `005af7274ee1811a7d81dfd0de80f13ca790fd29`; its two agents overlapped for 43.099 seconds and it produced four file receipts. See the lead-maintained [native acceptance record](git-native-acceptance.json). Earlier history includes ownership failure `e5` and a repair attempt that failed after scheduling reset to legacy transport and the fork was missing. A second 48-request trial under the unchanged $0.20 Codex / $4.80 Claude spending caps has launched to exercise the actual repair. Human rehearsal remains pending until development is complete and has not been performed. From the public source, `node tools/reviewer.mjs` opens the recorded checked example without installing dependencies. For read-only CLI inspection, use `node tools/reviewer.mjs --key-file /path/to/access.json --checked --no-open`; this reads an owner-private access file, does not start a trial, and prints the review URL. Run `--help` for all options. `--new` explicitly approves another funded trial.
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

Source revision `6f39290` passed its full source gate. Follow-up revision `5d32ac4` passed pnpm checks/tests and is deployed to the development Worker as version `a12a0a89-0064-4a9d-a2d5-b4c0a7f1ce6f` running code `5d32ac4`. The pinned Linux runtime image is unchanged and passed 71 tests at `sha256:4b5439bb9e9504b3ee0466bf73edfa77ae02addea599707e1b3a7615f2f197b6`.

The full `6f39290` source gate passed: 283 Rust tests (186 app, 16 core, 65 runtime, 1 Cloudflare and 15 xtask), 55 frontend tests and 11 Node tests. Follow-up `5d32ac4` passed pnpm checks/tests, bringing Workers coverage to 290 tests across 59 files. Formatting, Clippy, TypeScript, Wasm and production builds passed in the full gate.

Isolated hosted acceptance at 2026-10-10 20:35:37 UTC used a controlled fixture with no paid inference. It exercised Git contribution capture, controlled capacity deferrals with refunded attempts, injected publication acknowledgment loss followed by retry and canonical readback, and a disjoint two-parent refresh whose fresh evaluation passed. This demonstrates those bounded scenarios; it does not establish broad capacity, scale, overlapping conflict resolution, or human acceptance. See the machine-readable [platform acceptance record](platform-acceptance.json).

Native run `a2f` passed all five checks for eligible, unpublished candidate `005af7274ee1811a7d81dfd0de80f13ca790fd29`. The recorded two-agent overlap was 43.099 seconds and capture produced four file receipts; details are in the lead-maintained [native acceptance record](git-native-acceptance.json). Keep the failure history visible: initial run `e5` exposed root Git ownership rejection; a repair round failed after scheduling reset to legacy transport and the fork was missing. The next 48-request trial under the unchanged $0.20 Codex / $4.80 Claude spending caps has launched to exercise actual repair. Human rehearsal after development has not been performed. Fresh video captures are pending. The prior checked Claude run `reviewer-f07f61a0-97b6-48e9-b9de-521753744063` remains historical evidence for an earlier deployed version: candidate `20dc24de9`, canonical published HEAD `3bbe63325`. Candidate and published revisions differ. The checked-in [reviewer acceptance record](reviewer-acceptance.json) is older historical evidence; competition form submission and any entry agreement remain the entrant's actions.

## Delivered source wave

The source wave includes Git-native isolated workspaces and revision-based external contribution capture; paged repository history with a stable watermark and on-demand run detail; verified archive storage with hot-history compaction and detail read-through; and an active-work cap based on live jobs and executions rather than lifetime run totals. Metadata pages omit graph nodes and diffs; detail reads fetch them on demand. It also includes bounded iterative repair, immutable test bundles with approval for test-set edits, file-level provenance, and Git conflict inspection, refresh and resolver workflows. Native run `a2f` passed its five checks; the second trial is exercising actual repair, and neither result establishes human acceptance or broad throughput.

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
| Team iteration | Frozen task inputs, integrated checks and bounded iterative repair are in source; native run `a2f` passed all five checks. Earlier ownership and missing-fork/legacy-transport failures remain in the run history. | The next 48-request trial under the same cost cap has launched to exercise actual repair; then conduct the human reviewer rehearsal. Both outcomes remain pending. |
| Scale and Git compatibility | Git-native workspaces, paged reads, archive/detail read-through and the six-live-work cap passed the current local gate; the hosted fixture covered only bounded capacity deferrals. | Measure sustained and parallel load before making runtime-scale claims. |
| Evaluation and provenance | Exact revision/policy checks, immutable approved test bundles, explicit test-edit approval and file-level provenance are in current source; current local gate passed. | Human reviewer comprehension and controlled comparisons are still needed to establish context-use benefit. |

No large-scale throughput, semantic merge resolution, or causal context-use benefit is claimed for this prototype.
