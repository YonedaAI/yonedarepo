# Product workflow and portable deployment

The owner should complete the development cycle in the browser. The agent contributes source and typed context through a scoped harness or MCP; selection remains an explicit owner decision recorded in the graph.

The delivery sequence is implemented. [Verification evidence](../ui-workflow-evidence.md) separates the deployed UI, local integration checks and untested fresh-account/paid-provider paths. The README includes manual prerequisites, resource provisioning, private credential backups and repeatable Rust deployment commands.

## Delivery sequence

1. Repair approach selection: open a visible review dialog, focus the rationale field, identify the captured revision, retain errors and distinguish a recorded selection from verified publication.
2. Organize the workspace: dedicated Runs, Context graph and Source history views; clear account creation/sign-in, repository setup, provider and local-agent dialogs; keyboard and mobile navigation.
3. Connect agents: support named independent provider connections, including multiple keys for one provider, and add/remove approaches within the engine's 2–4 concurrent-agent limit. Add Gemini through its native CLI and scoped model proxy rather than an incompatible provider dropdown.
4. Complete the browser path: sign in → create/import repository → connect keys → approve shared brief and checks → watch concurrent work → inspect previews, diffs and context → record decision → observe verified publication → reuse context in a new run or MCP client.
5. Make deployment portable: generate isolated account-specific configs, provision named resources idempotently, preserve DO migrations, deploy both Workers, configure secrets without logging them, bootstrap the starter and verify health. Document billing/beta access and every manual step.
6. Validate source and actual runtime separately: required local gate without inference, real browser checks for dialogs/keyboard/mobile and existing review evidence, container harness smoke checks, deployment/readback. Paid provider acceptance requires a separately recorded real run; a configured key alone is not acceptance.

## Acceptance boundaries

- Expanding a long diff must not hide the selection action's result. Closing review must preserve the unpublished state; errors stay in the review dialog.
- No key is returned by settings, rendered after storage, or substituted from another user's connection. Existing provider records remain readable.
- Run configuration freezes the selected connection, model, source and context. Removed or mismatched connections fail closed.
- Each provider's harness and outbound protocol must agree. Model calls/output remain bounded; Claude retains the existing durable $20 allowance.
- A fresh deployment uses the target account's resources and URLs, never this project's namespace, account ID or provider secrets. Repeating configuration/deployment must not rotate the vault key or reset durable state.
- Static websites are the current publication target. Generic task DAGs, full-stack application hosting and automated semantic merges remain future work.
