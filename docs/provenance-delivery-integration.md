# Provenance delivery integration

The provenance worktree adds the Rust receipt/query helpers and the Worker Git-tree adapter. The lead-owned capture and HTTP boundaries must call them before this is live end to end.

## Capture and decision hooks

In `cloudflare/worker/broker.ts`, after the capture commit and one-parent/base checks succeed, compute:

```ts
const fileProvenance = await captureFileProvenance(
  captured,
  job.payload.base.commit,
  body.revision.commit,
);
const trustedPaths = [...new Set(fileProvenance.flatMap((file) => [file.path, file.old_path].filter(Boolean)))];
const { diff: _diff, diff_digest: _claimedDigest, file_provenance: _claimedFiles, paths: _claimedPaths, ...metadata } = body;
command = {
  op: 'finish',
  ...identity,
  result: { ...metadata, paths: trustedPaths, diff_digest: stored.digest, file_provenance: fileProvenance },
};
```

This derives IDs solely from `readCommit`/`readTree` on the verified Artifacts repository. Discard body `file_provenance` and `paths` before forming the ledger command; agent/browser values must never override these receipts. Import `captureFileProvenance` from `./provenance`.

In `backend/crates/yoneda-app/src/commands/capture_completion.rs`, call the helper after active-job validation and before the `team::captured` early return:

```rust
let _receipts = super::history::capture_file_provenance(db, j, result, now)?;
```

The helper creates receipt graph nodes keyed to the candidate or exact team handoff revision and edges to the execution. It validates each lease/revision/path/blob field. For task captures it records the deterministic `handoff:{task_id}:{revision}` identity before `team::captured` creates that node; for the integrator it records candidate receipts that can inherit contributor identity only when trusted path/blob IDs match. A missing `file_provenance` is accepted for legacy native captures and `why` reports unknown for that history.

In `acceptance.rs`, after the immutable decision is stored, connect selection evidence:

```rust
super::history::link_file_provenance_to_decision(db, &d, now)?;
```

In `completion.rs::record_publication`, after the canonical remote readback has matched the selected commit, connect publication evidence:

```rust
super::history::link_file_provenance_to_publication(db, decision, commit)?;
```

Selection stays pending publication until the existing readback succeeds. The helpers reject a publication commit that differs from the selected target.

## Browser and route contracts

The browser consumes these owner-authorized routes; they are separate from repository snapshot hydration:

| Route | Contract |
| --- | --- |
| `GET /repos/:id/overview` | `repository_overview: { v, capabilities, repository, counts, watermark }` |
| `GET /repos/:id/runs?limit=25&cursor=…` | `runs_page: { items, next_cursor, watermark, has_more }`, ordered by `created_at DESC, id DESC` |
| `GET /repos/:id/runs/:run_id` | Snapshot-compatible, run-scoped `run_detail` with `runs: [one]`; empty `nodes`/`edges`, `graph_paged: true`, no inline candidate diffs |
| `GET /repos/:id/run_graph_page?run_id=…&limit=250&cursor=…` | Lazy run-scoped graph page, including intent and assertion nodes/edges |
| `GET /repos/:id/candidate?id=…&limit=100&cursor=…` | Candidate detail with a paged diff from Worker `candidateDiffPage` |
| `GET /repos/:id/why?commit=…&path=…` | File lineage, explicit `coverage/status`, decisions, rejected-alternative reasons |
| `GET /repos/:id/conflict_status` | `{ conflicts, overlaps, seq }` |
| `POST /repos/:id/refresh_candidate` | Owner mutation with request ID, candidate ID, optional declared paths, and expected commit/version |
| `POST /repos/:id/resolve_conflict` | Owner mutation with request ID, conflict ID, candidate ID, optional declared paths, required owner brief, and expected commit/version |
| `POST /repos/:id/repair_team` | Owner mutation with task ID, expected task epoch/revision, and expected repository revision/version |

`frontend/src/lib/types.ts` consumes the shared browser interfaces in `shared/provenance.ts`. The run history calls the page/detail/candidate routes directly; graph requests remain lazy and paged. Repository freshness polling uses `repository_overview`, `runs_page`, and only the latest/active `run_detail` records. The global 3-second loop no longer re-fetches full snapshots. `tools/reviewer.mjs` is lead-owned and should use `runs_page` for listing and `run_detail` for the selected run, with the same cursor/watermark semantics.

Resolver contract clarification for C: conflict status is an inventory of `{ conflicts, overlaps }`. `resolve_conflict` needs `conflict_id`, `candidate_id`, optional `declared_paths`, required `owner_brief`, stable `request_id`, and `expected_commit` plus `expected_version`. The UI keeps the exact request body/ID after uncertain failure so a retry is idempotent. Resolution starts a scoped resolver agent and requires fresh trusted capture and checks; there is no keep-current/keep-candidate decision picker. `refresh_candidate` carries the same request ID and repository CAS fields.

## Current implementation boundary

The Rust `why` query follows recorded candidate base→revision links and uses trusted per-file receipts only. It follows rename paths backward, reports deletion, accumulates distinct captured executions through successive modifications and matching team handoff blobs, and returns `unknown` when the chain has no receipt. Optional agent context `file_paths` are checked against the immutable assigned source tree in `hosted-mcp.ts`; they remain assertions with `file_path_authority: assertion_pending_capture_match` and never create trusted receipts or graph edges.
