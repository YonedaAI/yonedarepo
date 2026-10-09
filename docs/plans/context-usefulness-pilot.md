# Controlled context usefulness pilot

This is separate from the evidence interface and from the collaborative-run plan. Its purpose is to test whether preserved information helps later agents retain historical requirements while implementing a new request. It must allow an inconclusive or unfavorable result.

## Conditions and cases

Each matched cluster starts from the same synthetic published event-site source and receives the same neutral brief and current acceptance criteria. The historical corpus contains privacy, event-search and capacity requirements that are absent from the new brief. Corpus records are labelled synthetic evaluation data, not genuine owner acceptance.

| Condition | Source | Historical information |
|---|---|---|
| Source only | Identical frozen fixture | No history retrieval or notes |
| Plain notes | Identical frozen fixture | All corpus facts, origins, purposes and links in frozen notes; graph retrieval disabled |
| Graph | Identical frozen fixture | The same historical facts available through MCP retrieval; no initial corpus preload |

The three cases are two concurrent hosted implementations, one hosted root with a separately checked delegated RSVP candidate, and a fresh local continuation through scoped MCP. Current delegation creates independent candidates; it does not integrate a team result. True collaborative integration is planned in `../collaborative-agent-runs-plan.md`.

There are three repetitions per case/condition: 27 clusters, up to 45 agent executions. Condition order rotates in a Latin square; model assignment alternates by repetition and remains matched within each comparison. MiMo and ZAI use the owner's saved model and plan/region. Models are never silently replaced. Hosted groups explicitly allow 60 durably counted provider requests, 4,096 output tokens and ten minutes per execution; local CLI allows 60 turns and ten minutes. CLI turns are not equivalent to proxy requests. Record this limitation rather than claiming identical request accounting.

## Controls and evidence

The Rust ledger resolves corpus IDs and freezes source/configuration at run start. Configuration cannot change after the first trial. Worker restrictions cover graph/get/search/why/decision/artifact retrieval and recursive history in all initial/status surfaces. `execution_status`, `attempt_begin`, `attempt_status` and `delegation_status` cannot leak control records. Plain notes alone expose the corpus in initial responses. The source Git fixture contains neither the corpus nor oracle.

The trusted oracle lives outside the source checkout. A read-only, network-disabled container runs a trusted parent and a permission-restricted subject process. The subject module runs in an isolated realm with imports and string/Wasm code generation disabled, receives only realm-local arguments and storage spies, and has no process/stdout capability. Observations are cloned out; only the parent computes verdicts. Baseline, reference, allowed anonymous storage, forbidden identity storage, intentional regression, forged-verdict and forged-observation controls run before any inference. The privacy corpus permits anonymous event IDs/flags; the oracle checks whether the supplied canary name/email is persisted. This finite observation is not a general privacy proof. The container is the outer isolation boundary; this evaluator is restricted to the fixture API, not a general JavaScript sandbox. Browser-wiring checks are structural, not browser acceptance.

For each trial retain setup failures, model failures, timeouts, missing delegation, receipt pages, assertions/citations, exact captured revisions, independent platform evaluations and separate oracle outcomes. Unobserved tokens and unsupported-claim assessments remain null. A complete delegated cluster needs the expected root and child outcomes. Report graph vs plain notes separately from graph vs source only: the latter also compares availability of historical information. Receipt/citation lineage is required before attributing a pass to context, and still does not prove understanding or a general causal advantage.

## Commands and manual setup

```sh
cargo xtask context-study plan
cargo xtask context-study verify-controls
cargo xtask context-study run --url https://YOUR-PLATFORM --credentials .local/context-study-credentials.json --output artifacts/context-study
cargo xtask context-study recheck --url https://YOUR-PLATFORM --credentials .local/context-study-credentials.json --input artifacts/context-study --output artifacts/context-study-rechecked
```

`plan` writes the balanced manifest without inference. `verify-controls` needs Docker and the pinned Node image; it runs only synthetic controls. `run` explicitly starts paid work in up to three isolated clusters concurrently. Use `--limit 3` for a smoke wave. No paid inference runs in `cargo xtask check`.

`recheck` reads the recorded immutable candidate revisions and reruns only the behavioral oracle. It requires a different output directory, retains previous verdicts, and preserves failed/missing agent outputs. Use this after an oracle correction; never rerun only favorable candidates or silently replace the original report.

Use a dedicated personal test account with saved MiMo and ZAI provider connections. A private, Git-ignored credential file contains `username` and `password`. Fresh local trials additionally need `local_providers.mimo.key` and `local_providers.zai.key`, supplied locally by the operator. Worker vault keys are never exported. Protect the file with mode 0600; do not commit or paste it into a report. Build the current runtime image first:

```sh
docker build -t yonedarepo-runtime:layout -f cloudflare/containers/Dockerfile .
```

The runner creates disposable personal projects, seeds the fixture through a real scoped contribution, captures/checks it, and publishes it as `development_verification`. This is automated fixture preparation, not a human release decision. It then configures the trial and invokes real agents. A local CLI uses a private stdio relay retaining the contribution-bound server session; it starts with fresh HOME/configuration and a non-root container identity. Git hooks are disabled; changes are reconstructed in a separate trusted checkout before submission. Grants are revoked after outcomes; setup failures also attempt revocation. Projects and evidence are retained for inspection. Delete those disposable projects explicitly after exporting evidence.

After a start or acknowledgment-loss error, the runner inspects the trial's dedicated repository for matching study runs, requests cancellation and collects their available evidence before revoking its grant. An unavailable recovery snapshot is recorded as a manual inspection requirement, not reported as successful cleanup. Start paid trials after Worker/container rollout completes; capability checks reject older context tools and study prompt implementations.

`manifest.json`, `results.json` and `report.md` are local ignored artifacts. Known supplied secrets are redacted before results are written. A partial run is labelled with its observed cluster count. Do not promote fixture-control outcomes into agent performance evidence or claim a completed experiment from the planned manifest.
