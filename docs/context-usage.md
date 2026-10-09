# Context evidence for agents

Agents are the primary consumers of YonedaRepo's context graph. `context_usage` is the structured MCP interface for inspecting recorded delivery, explicit citations and resulting captured revisions. The web console projects the same evidence for the workspace owner's oversight.

Hosted agents query `context_usage` without a run ID: the active container lease supplies the run, execution and epoch. A local agent initializes the Streamable HTTP MCP endpoint with its repository-scoped grant, retains the returned `Mcp-Session-Id`, and calls `attempt_begin` in that session. Successful subsequent reads are attributed to that contribution. Earlier reads remain grant/session-level; the server does not retroactively assign them to a run. Stateless clients remain supported with grant-level attribution. Sessions expire within 24 hours and never outlive their grant; revocation and repository scope still apply on every request.

The query accepts `execution_id`, `epoch`, `cursor` and `limit` (default 50, maximum 100). Remote grants may also request a repository-local `run_id`; a bound session defaults to its contribution. Its response includes:

- `coverage`: recorded, partial or unavailable, activation time and an explanation.
- `counts`: run-wide distinct assigned, returned, opened and cited records; revision check events and read calls.
- `assigned`: records committed to the execution's frozen input. Assignment is delivery, not proof of reading.
- `entries`: chronological successful calls, runtime-derived recipient, attempt epoch, session, target IDs and available artifact digests.
- `citations`: explicit assertion links, contributing execution, its independently captured candidate and exact evaluation.
- `checked`: exact candidate revision, evaluator ID, policy, checks and evidence digest.
- `next_cursor`, `has_more`, and `citations_truncated`: explicit pagination and detail limits.

Search results are `returned`; opened record or artifact bodies are `opened`. Failed reads produce no delivery receipt. Artifacts are recorded only after R2 content passes digest verification. Querying usage does not record itself. Access receipts and the lightweight `context.accessed` event commit together, so the console can refresh without waiting for unrelated graph writes.

The inspectable chain is **prior record → delivery/retrieval → explicitly linked assertion → captured revision → independent checks**. Missing links stay missing. A check establishes the tested behavior of that revision; it does not verify an arbitrary statement an agent made. A capture from the citing execution is lineage, not proof that a particular line of code addressed its citation. Cross-agent and later-run handoffs are supported only by actual assignments or successful reads of earlier records.

The v7 Repo DO migration adds indexed receipt/session storage and records activation time. Historical reads cannot be reconstructed. New reads in older runs have partial coverage; earlier activity remains unavailable. D1 is discovery only. Receipt authority and queries stay in Rust; the Worker handles successful transport delivery and verified object reads. Local checks require no provider key or paid inference.

New tracked hosted runs require the container's `context_usage: 1` capability; study runs additionally require `context_study: 1`. During mixed Worker/container rollout, incompatible images fail before model calls and enter the existing bounded boot recovery. Legacy jobs retain their previous protocol. Deploy the Worker and current runtime image together, and wait for rollout completion before paid acceptance runs.

The console panel is attached to each run. Retrieval filters narrow chronological entries; counts and citation/check lineage remain run-wide. It preserves filters during live refresh and distinguishes loading, errors, empty new runs and unknowable history. The owner HTTP projection is `/api/repos/:repo/context_usage?run_id=...&cursor=...&limit=...`; agent grants use MCP rather than owner APIs.

See the dated [implementation and verification evidence](context-evidence-verification.md) for local checks, development deployment, browser acceptance and the incomplete usefulness pilot.
