# YonedaRepo submission

YonedaRepo treats a development run as a shared intent and a set of concurrent alternatives. Agents preserve typed context while they work. Independent capture and checks attach evidence to exact revisions; the owner selects what ships, and a future agent can query why through MCP.

- **Video:** [current six-minute reviewer walkthrough](https://github.com/MagnetonIO/yonedarepo/releases/download/reviewer-2026-10-10/yonedarepo-reviewer.mp4). Captioned edit of actual October 10 browser captures and live evidence, without narration. See [script and production notes](demo-video.md).
- **Source:** [MagnetonIO/yonedarepo](https://github.com/MagnetonIO/yonedarepo), Apache-2.0.
- **Try it:** [hosted platform](https://yonedarepo.com/). Choose **Have a reviewer access key?** and enter the privately supplied key. Funded provider connections and a sandbox are prepared; choose **Run prepared example**. From the submitted source, `node tools/reviewer.mjs` opens the recorded checked example without installing dependencies. For a read-only CLI rehearsal, use `node tools/reviewer.mjs --key-file /path/to/access.json --checked --no-open`; this reads an owner-private access file, never starts a trial, and prints the review URL. Run `--help` for all options; `--new` explicitly approves another funded trial.
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

The Git-native history and contribution wave is deployed to production at build revision `ca9542c`, Worker version `a23708e4`. Production health and new repository overview/history operations returned successfully. The initial production Durable Object code-adoption delay resolved on retry; it did not require a code change.

The complete local gate passed: 271 Rust tests (174 app, 16 core, 65 runtime, 1 Cloudflare and 15 xtask), 283 Workers tests across 55 files, 52 frontend tests across 13 files, and 11 Node tests (7 reviewer client, 2 relay and 2 profile), together with formatting, Clippy, TypeScript, Wasm and production builds. The pinned Linux runtime image passed 65 tests at `sha256:d936e75493d065ac763314590ee8d684f537dd481feb61b3e1b23e52ff2dc6b7`.

Isolated hosted acceptance at 2026-10-10 20:35:37 UTC used a controlled fixture with no paid inference. It exercised actual Git contribution capture, capacity exhaustion and durable deferrals with refunded attempts, an injected publication acknowledgment loss followed by retry and canonical readback, and a fresh disjoint two-parent refresh. The refreshed revision preserved both files and passed fresh checks. Earlier failed attempts are retained in the record. This is controlled development verification, not human product acceptance. See the machine-readable [platform acceptance record](platform-acceptance.json).

The separate paid Git-native Build Together trial failed after both agents finished editing: the root process could not run Git revision detection because Git rejected `/work/repo` as dubious ownership after `chown`. A Linux regression is being reproduced and fixed. The planned retry is for the same approved run with its existing budget after the runtime-image fix; the hosted end-to-end path is not green. The isolated external Git capture and fresh disjoint merge described above did pass, but do not establish Build Together acceptance. The prior checked Claude `claude-sonnet-5-5` run `reviewer-f07f61a0-97b6-48e9-b9de-521753744063` remains valid historical evidence for the earlier deployed version: candidate `20dc24de9`, canonical published HEAD `3bbe63325`. Candidate and published revisions differ. The checked-in [reviewer acceptance record](reviewer-acceptance.json) describes an earlier run and remains historical. Human rehearsal requires the reviewer key and is not complete. Public source/video refresh is pending; competition form submission and any entry agreement remain the entrant's actions.

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
| Reviewer setup and readability | Dedicated funded sandbox, one-key login, immediate recorded example command, readable evidence trail and optional focused graph. | Measure time to first useful review with an unfamiliar person. |
| Runtime/lifecycle failure | Remote-HEAD reconciliation, capacity deferral, compact digest-bound diff jobs, HTTPS trust and bounded process/report handling. | Exercise deployed capacity exhaustion and publication acknowledgement loss before claiming operational reliability at scale. |
| Agent awareness and conflicts | Same-run peer status, visible task scopes/dependencies, plus source-level conflict inspection, candidate refresh and resolver capture. | Deployed conflict recovery and broader cross-run contention behavior still need acceptance. Automatic semantic merge quality is not claimed. |
| Team iteration | Frozen task inputs and integrated checks, with bounded iterative repair in the current source. | Verify repair behavior under the full gate and deployed runtime; plan amendments remain separately scoped. |
| Scale and Git compatibility | Current source adds Git-native workspaces, paged reads with stable continuation, archive/detail read-through and a six-live-work active cap. | Run the pending capacity, pagination, archive and transport gates, then deploy before making runtime-scale claims. |
| Evaluation and provenance | Exact revision/policy checks, immutable approved test bundles, explicit test-edit approval, and file-level provenance in the current source. | Validate end-to-end capture and reviewer comprehension. Controlled comparisons are still needed to establish context-use benefit. |

No large-scale throughput, semantic merge resolution, or causal context-use benefit is claimed for this prototype.
