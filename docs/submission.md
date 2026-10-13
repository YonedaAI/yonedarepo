# YonedaRepo submission

Review how YonedaRepo turns a goal into coordinated, checked changes with a readable history. A human reviews one integrated result: what changed, why, what was checked and what still needs a decision. Agent coordination and Git/context evidence are available for deeper inspection; the example application is the output of that workflow.

## Reviewer: one key, one command

Use the privately supplied reviewer key at [yonedarepo.com](https://yonedarepo.com/) under **Have a reviewer access key?** No signup or provider key is needed. Alternatively, from the public source with Node 24:

```sh
node tools/reviewer.mjs --checked
```

The command prompts without echoing the key, opens the latest independently checked result in the workspace and does not start or resume inference. A private access file is supported:

```sh
node tools/reviewer.mjs --checked --key-file /path/to/access.json
```

Use `--no-open` for command-line inspection and keep the key private. The reviewer has the ordinary workspace and preconfigured connections. After shared-allowance activation, `--new` and `--resume` open that workspace without starting inference. Use **Start a Run** to approve work; **Connect Agents** manages hosted providers or repository-scoped MCP clients. New work shares the configurable $50 workspace allowance with retained spending. Human publication stays separate from successful checks.

## What to review

1. Read the goal and integrated result. Open **Review changes**, choose files individually and inspect the output against the intent.
2. Check the exact captured revision, independent checks, unresolved issues and why publication awaits a human decision.
3. Inspect specialist contributions and peer coordination. The recorded example retained both specialist captures through one bounded repair without renewing its original budget.
4. Start a follow-up from the same project to inspect how earlier context is retrieved and cited. Optional sample buttons prepare editable briefs; they do not claim completed proof.
5. For conflicting changes, inspect both contributions, the original intent and the freshly checked resolution. The existing recorded result proves integration recovery, not general semantic conflict quality.

The October 13 maintenance acceptance was run `run-699e54e0-d070-443c-a0df-9e8272835c5c`, revision `53033856054d10a35f8c967f39b609c30b629732`. It fixed a request-key ownership bug using prior run context; all six protected tests passed after one automatic repair. Only `booking.mjs` changed. It used one GLM agent in sequential roles, 68 requests and $0.421615 in conservative accounting. At acceptance, its working branch was at version 2 and canonical source remained at version 0, awaiting a human decision. The earlier `reviewer-booking-20261012-s1-r2` revision `4c330e0` remains dated concurrent GLM/Codex initial-build evidence. These identifiers describe recorded acceptance, not a guarantee that the current workspace still lists those projects.

## Compare alternatives with a recorded review

Choose **Compare two approaches** for two builders plus a separate read-only Auto reviewer. Review begins after both captured alternatives have independent checks. The selected output shows why it won, why the other approach lost and remaining risks. If neither meets the intent, the reviewer may repair the more promising alternative up to twice; fresh capture, checks and review are required. You can override a checked choice with a reason and decide separately whether to publish. **Review now** adds an explicitly approved review to existing two-builder results without resetting previous usage.

The complete local gate passed 446 Rust, 422 platform workerd, 16 app workerd, 207 frontend and 43 Node tests. R8 passed 88 Linux runtime tests. Independent review cleared the frozen changes. Hosted acceptance and deployment are recorded separately in [release evidence](release-evidence.md). The video predates the new automatic comparison reviewer.

## Modern model picker — earlier verified wave

The current source groups connected choices under short provider and model names. Optional **Reasoning** choices reflect the exact selected model's supported levels. **Auto** omits an explicit reasoning setting and uses only models with validated automatic-selection eligibility; newly catalogued models require an explicit choice until their compatibility is validated. There is no silent fallback to a more expensive model.

**Add model** explicitly reuses an existing Cloudflare-sealed provider key to create a new immutable model/connection binding. The key is not exposed to the browser, and existing bindings and run approvals remain unchanged. Samples use a separate dialog and prefill an editable run brief; choosing a sample or adding a model does not start inference.

The fresh complete local gate passed: 415 Rust, 399 platform workerd, 16 isolated-app workerd, 184 frontend and 36 Node tests, including the actual workers-rs Wasm build. R7 passed 84 Linux runtime tests. Independent review cleared the frozen changes after reproducing and fixing dropped Compare/manual-team effort and deleted-alias identity reuse. Deployment is recorded separately. No paid execution proof is claimed for newly added modern models. That wave predates the automatic comparison reviewer and correction of first-finisher working selection described above.

Implementation `380b742` is live through Worker `0ea82682-ad52-4400-af59-fb38d5ac6e91`. R7 completed rollout at application version 30 with six healthy instances, zero failed instances and zero health errors. Deployed Wasm matched the locally tested module byte for byte. The initial workspace instance answered an old-operation error; explicitly redeploying the same Worker version with immediate Durable Object code updates resolved it. Five modern-model aliases were then created in the ordinary reviewer account with existing bindings and workspace accounting unchanged, and zero inference requests. Live Chrome verified the concise model list, supported reasoning levels, model-change reset and three distinct editable sample briefs. The read-only CLI also opened the current Compare run without starting work; it does not select a winning alternative or resolve the branch-selection defect.

## Current package and verification

- **Platform:** [yonedarepo.com](https://yonedarepo.com/), with a separate isolated Apps Worker serving checked JS/TS UI/API applications backed by managed SQLite.
- **Source:** [MagnetonIO/yonedarepo](https://github.com/MagnetonIO/yonedarepo), Apache-2.0. Check [`PUBLIC_SOURCE.md`](https://github.com/MagnetonIO/yonedarepo/blob/main/PUBLIC_SOURCE.md) for the exported implementation revision and [GitHub Actions](https://github.com/MagnetonIO/yonedarepo/actions) for that export's result.
- **Earlier hosted code acceptance:** implementation `82d900f`, Worker `e0cc3b15-ef7c-43bb-af6e-dafd2da11d2d`, R4 container application version 28. The completed rollout had seven healthy instances, none on the old image, and zero startup failures/errors.
- **Latest source and deployment:** simplified-flow source passed 387 Rust, 387 platform workerd, 16 isolated-app workerd, 160 frontend and 27 Node runtime/reviewer tests. R5 passed 81 Linux runtime tests. The fresh-provider follow-up passed 161 frontend tests plus build/adapter checks. The current-policy read-only reviewer CLI passed 36 Node tests and selected the current checked revision live. Implementation `a598b5e` is live through Worker `2a54a312-ffc3-4024-a85b-d1a1f04cc0cc`; runtime application version 29 completed rollout with zero failed instances/errors. Earlier separate study tooling passed 29 Node tests; those results remain dated evidence.
- **Hosted app:** exact-revision HTTPS/UI/API/SQLite, capacity/cancellation, wrong-host/origin/unauthenticated isolation and normal browser render/reload checks passed. Browser form mutations and induced hosted DO eviction were not exercised.
- **Reviewer CLI:** read-only technical check succeeded on the current result without a trial or new inference. This is not an unfamiliar-human rehearsal.
- **Evidence:** [release verification](release-evidence.md), [machine-readable record](release-evidence.json), [architecture](current-state-architecture.md), [video production](demo-video.md).

**Video:** [Watch the October 13 walkthrough](https://github.com/MagnetonIO/yonedarepo/releases/download/reviewer-2026-10-13/yonedarepo-reviewer.mp4). This six-minute, 12-chapter, 48-caption edit uses actual R2 browser captures and predates the simplified Start a Run / Connect Agents interface. It does not demonstrate the new adaptive roster or shared allowance. Normal-speed native playback reached the end without seeking, all captions were visually inspected, and ffmpeg decode passed. It is an edited walkthrough, not a continuous recording of a live run. SHA-256: `494a0888600e3fbab362b76387e0842e99fec653936b19bbd01ecdb745402010`.

## What the evidence establishes

| Question | Measured result | Limit |
|---|---|---|
| Concurrent agent work | GLM and Codex specialist harness/transcript markers overlapped 67.477 seconds; both captured revisions contributed to the checked integration. | Marker interval includes completion/teardown/upload, not pure inference time. |
| Recovery and coordination | Eight coordinator MCP operations completed; one guarded repair produced plan revision 2, repair round 1, with both specialist captures retained. | This is one observed integration recovery, not general semantic-conflict quality. |
| Costs and authority | Original shared GLM and Codex groups each reached 48/48 requests. All 19 recovery reservations settled; the campaign retained $0.528906 of conservative charges. | Not provider invoices; no allowance or model roster was renewed. Opus was not used. |
| Features and bug fixes across runs | A separate six-chain maintenance study completed 18 stages: 16 passed, two failed. Plain notes and graph each passed both full chains; both source-only chains failed the final duplicate-registration case. | This is separate maintenance evidence, not a three-stage coordinated-team claim. |
| Context benefit | Delivery/opening/citation receipts are revision-bound and queryable. | Two repetitions of one seeded fixture, differing information availability and Worker-version variation do not establish a causal graph benefit. Graph had no observed pass advantage over plain notes. |
| Platform failure behavior | Real bounded capacity deferrals, injected publication-acknowledgement recovery and a disjoint two-parent refresh passed hosted checks without model calls. | Injected fault and small workload; broad scalability is not claimed. |

The current source includes Git-native transport, paginated history/archive reads, active-work limits instead of lifetime-run limits, bounded team repair, protected test bundles and file provenance. Managed apps currently use the supported JS/TS/SQLite profile; arbitrary external services are not enabled.

## Differentiation and remaining human steps

Agent sessions, searchable decisions and graphs already exist in [Entire](https://docs.entire.io/). Dependency-aware planning, isolated Git workspaces and tested integration appear in [CAID research](https://arxiv.org/abs/2603.21489v2). YonedaRepo's differentiation is the combination of coordination with separate agent assertions, trusted capture, independent checks, bounded approvals and human decisions. This is a product-design claim, not proof of a unique invention or an algorithmic advantage.

The unfamiliar reviewer rehearsal follows development and private key delivery. Canonical publication remains an owner decision. The owner must confirm eligibility/attendance and submit the competition application manually under the [official competition information](https://blog.cloudflare.com/next-git-platform-on-cloudflare/). No submission confirmation is recorded.

Earlier static-site runs and videos remain dated evidence in [release history](release-evidence.md).
