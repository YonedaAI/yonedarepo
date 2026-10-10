# YonedaRepo submission

YonedaRepo treats a development run as a shared intent and a set of concurrent alternatives. Agents preserve typed context while they work. Independent capture and checks attach evidence to exact revisions; the owner selects what ships, and a future agent can query why through MCP.

- **Video:** [current six-minute reviewer walkthrough](https://github.com/MagnetonIO/yonedarepo/releases/download/reviewer-2026-10-10/yonedarepo-reviewer.mp4). Captioned edit of actual October 10 browser captures and live evidence, without narration. See [script and production notes](demo-video.md).
- **Source:** [MagnetonIO/yonedarepo](https://github.com/MagnetonIO/yonedarepo), Apache-2.0.
- **Try it:** [hosted platform](https://yonedarepo.com/). Choose **Have a reviewer access key?** and enter the privately supplied key. Funded provider connections and a sandbox are prepared; choose **Run prepared example**. From the submitted source, `node tools/reviewer.mjs` opens the recorded checked example without installing dependencies; `--new` explicitly approves another funded trial.
- **Immediate public example:** [Juniper Garden](https://yonedarepo-sites-dev.mlong-f01.workers.dev/p/yoneda-garden-live/), built by concurrent Luna/Sonnet agents and published after an owner-directed selection.
- **Run locally:** [README](../README.md#get-running) and [runbook](runbook.md). The local gate needs no inference keys; local Artifacts access requires Cloudflare authentication and configured resources.
- **Connect your existing agent:** [remote MCP and Git setup](remote-mcp.md), using a revocable repository-scoped key from the website.
- **Evidence and limits:** [release verification](release-evidence.md) and [machine-readable record](release-evidence.json).

## Reviewer hands-on path

1. Enter the reviewer access key. The sandbox opens with configured agents and recorded runs.
2. Choose **Run prepared example** or use `node tools/reviewer.mjs` to open the recorded checked example immediately. Add `--new` to approve another trial. The command asks for the same key privately. One trial may run at a time; each trial is limited to $5 within a shared $50 allowance.
3. Watch the two specialists' activity and captured handoffs, then review the integrated exact revision and independent checks.
4. Open **Evidence trail** to read intent, assertions, trusted capture, checks and the owner's rationale at normal text size. **Explore graph** provides the optional relationship view.
5. Select an eligible candidate, record the decision and wait for verified publication. Reviewer publication affects only the sandbox. A failed or conflicting publish can be reconciled using **Recover repository**, which reads the actual canonical Git HEAD and retains the failed decision as history.

Use a project-specific test profile: the starter HTML smoke check does not prove all browser interactions or product requirements. Hosted sites are isolated relative-path static output; full-stack applications and external API calls require a future deployment profile.

## Current verification

October 10: a funded Codex/Claude Build together run produced checked revision `3bbe6332556bdcdc72945dfc590845bc3e071057`. The two specialist job intervals overlap by 53.074 seconds, including startup. All five checks passed under `reviewer-v2`: site, trail-module, bilingual, registry-egress (`npm ci`) and static output capture. The result remains available for human review; no publication decision is claimed. [Exact verification record](reviewer-acceptance.json) preserves the source/policy binding and conservative budget accounting. Earlier interrupted trials and the corrected browser-fixture evaluation remain in history.

The complete local gate passes 213 native Rust tests, 247 workerd tests and 30 Node frontend/profile tests, plus formatting, Clippy, TypeScript and production/Wasm builds. The submitted source provenance records the implementation commit. CI and video release are checked separately; competition form submission and any entry agreement remain the entrant's actions.

## Direction and remaining gaps

The useful product direction is an evidence and coordination layer for agent-written code: preserve intent and assertions, capture exact source, independently check it, record a human choice, and make the history available to later agents. The market comparison supports prioritizing that evidence trail, conflict recovery and low-friction review. It does not establish that YonedaRepo is unique or that its context graph improves coding outcomes.

| Primary comparison | Existing capability | Implication for YonedaRepo |
|---|---|---|
| [Cursor worktrees and best-of-n](https://cursor.com/docs/configuration/worktrees) | Parallel models use isolated checkouts; results can be compared and applied. | Parallel alternatives alone provide little differentiation. Make captured evidence and decision lineage the main product. |
| [GitHub Copilot agents](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents) | Delegate work on branches or PRs, track sessions, iterate and review output. | Review/progress are expected capabilities. Explain the assertion → capture → check → decision authority chain clearly. |
| [CAID: Effective Strategies for Asynchronous Software Engineering Agents](https://arxiv.org/abs/2603.21489v2) | Central delegation, dependency plans, concurrent isolated workspaces and tested integration. | Build together follows a supported coordination direction. Git-native branch/merge and iterative repair are the next architectural gaps. The paper's reported performance gains are not measurements of this platform. |

| Gap | Current delivery | Next recommendation |
|---|---|---|
| Reviewer setup and readability | Dedicated funded sandbox, one-key login, immediate recorded example command, readable evidence trail and optional focused graph. | Measure time to first useful review with an unfamiliar person. |
| Runtime/lifecycle failure | Remote-HEAD reconciliation, capacity deferral, compact digest-bound diff jobs, HTTPS trust and bounded process/report handling. | Exercise deployed capacity exhaustion and publication acknowledgement loss before claiming operational reliability at scale. |
| Agent awareness and conflicts | Same-run peer status, visible task scopes/dependencies, owner-approved fresh runs for stale candidates. | Add cross-run path claims/conflict records and a re-capture/re-evaluate merge queue. Automatic overlapping merge and disjoint auto-rebase are not delivered. |
| Team iteration | Frozen DAG and exact captured inputs; final integrated checks. | Add per-task checks and plan amendments that reopen dependent work. |
| Scale and Git compatibility | Current deployment remains 16 containers; source is bounded to 500 files/8 MiB; retained-run cap and snapshot limits remain. | Move agents to Artifacts-backed Git forks, paginate reads, prune history/outbox/forks and replace lifetime limits with active-work limits. |
| Evaluation and provenance | Exact revision/policy checks, typed authority and adapter-written delivery receipts. | Protect general project test integrity and add file/hunk attribution. Demonstrate context benefit with controlled comparisons. |

No large-scale throughput, semantic merge resolution, or causal context-use benefit is claimed for this prototype.
