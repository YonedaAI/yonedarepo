# YonedaRepo submission

Review a checked event-booking application built by an agent team. Start with the running app, its independent checks and the reasons behind the changes. Git-native specialist forks, protected verification, prior-run context, coordination and human publication decisions remain connected in the evidence trail.

## Reviewer: one key, one command

Use the privately supplied reviewer key at [yonedarepo.com](https://yonedarepo.com/) under **Have a reviewer access key?** No signup or provider key is needed. Alternatively, from the public source with Node 24:

```sh
node tools/reviewer.mjs --checked
```

The command prompts without echoing the key, opens the latest independently checked collaborative result and does not start or resume inference. A private access file is supported:

```sh
node tools/reviewer.mjs --checked --key-file /path/to/access.json
```

Use `--no-open` for command-line inspection. `--new` is an explicit optional funded trial, limited to $5 under the existing $50 campaign; it is not needed to review the recorded result. Keep the access file private. Reviewer access does not permit arbitrary model/provider changes or canonical publication.

## What to review

1. Open the **checked app** and inspect booking, capacity and cancellation behavior.
2. Read **checks and why**: the approved intent, exact captured revision, protected independent verification and why publication still awaits a human decision.
3. Inspect the two specialist captures and the recovery: the coordinator used platform tools, retained both captures and reassigned integration to an available originally approved model. No budget was raised.
4. Review changed files individually. Use the optional evidence graph and file provenance for deeper inspection.

The current checked run is `reviewer-booking-20261012-s1-r2`, revision `4c330e084f8d698a4c0ba08f82fd73d108c02f2d`. Its initial-build oracle passed four tests; three future-stage tests were skipped. The checked working branch is at version 1. The canonical repository remains at its original version 0: checked is not published.

## Current package and verification

- **Platform:** [yonedarepo.com](https://yonedarepo.com/), with a separate isolated Apps Worker serving checked JS/TS UI/API applications backed by managed SQLite.
- **Source:** [MagnetonIO/yonedarepo](https://github.com/MagnetonIO/yonedarepo), Apache-2.0. Check [`PUBLIC_SOURCE.md`](https://github.com/MagnetonIO/yonedarepo/blob/main/PUBLIC_SOURCE.md) for the exported implementation revision and [GitHub Actions](https://github.com/MagnetonIO/yonedarepo/actions) for that export's result.
- **Current code acceptance:** implementation `82d900f`, Worker `e0cc3b15-ef7c-43bb-af6e-dafd2da11d2d`, R4 container application version 28. The completed rollout had seven healthy instances, none on the old image, and zero startup failures/errors.
- **Local gate:** 359 Rust, 327 platform workerd, 16 isolated-app workerd, 113 frontend and 15 reviewer Node tests passed. Separate study tooling passed 29 Node tests; R4 passed 80 Linux runtime tests.
- **Hosted app:** exact-revision HTTPS/UI/API/SQLite, capacity/cancellation, wrong-host/origin/unauthenticated isolation and normal browser render/reload checks passed. Browser form mutations and induced hosted DO eviction were not exercised.
- **Reviewer CLI:** read-only technical check succeeded on the current result without a trial or new inference. This is not an unfamiliar-human rehearsal.
- **Evidence:** [release verification](release-evidence.md), [machine-readable record](release-evidence.json), [architecture](current-state-architecture.md), [video production](demo-video.md).

**Video:** [Watch the October 13 walkthrough](https://github.com/MagnetonIO/yonedarepo/releases/download/reviewer-2026-10-13/yonedarepo-reviewer.mp4). This six-minute, 12-chapter, 48-caption edit uses actual current browser captures. Normal-speed native playback reached the end without seeking, all captions were visually inspected, and ffmpeg decode passed. It is an edited walkthrough, not a continuous recording of a live run. SHA-256: `494a0888600e3fbab362b76387e0842e99fec653936b19bbd01ecdb745402010`.

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
