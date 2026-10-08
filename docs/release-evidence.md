# Product MVP release evidence — October 8, 2026

The product runs on [Cloudflare](https://yonedarepo-dev.mlong-f01.workers.dev/), with a real [agent-built Garden website](https://yonedarepo-sites-dev.mlong-f01.workers.dev/p/yoneda-garden-live/). [Machine-readable evidence](release-evidence.json) records identities, revisions, epoch timestamps, independent checks, the decision, canonical readback and served asset hashes. These are development verification results, not a production readiness claim.

## Concurrent hosted agents

Run `garden-3e5f9022-9704-4207-a36d-e8af7cea6122` started Luna `gpt-5.6-luna` and Claude `claude-sonnet-4-6` from the same Artifacts commit `91470de625798365cfc6d8d2d2b2596642b4cd84`, approved brief, check policy and prior browser finding. Both completed at attempt epoch 1. The intersection from recorded `harness_running` to trusted transcript registration is **87.117 seconds**. This measures actual harness overlap rather than queued jobs or overlapping cold starts.

| Approach | Fresh captured commit | Independent checks | Result |
|---|---|---|---|
| Luna editorial | `0c44ca70e73bf41fbcf50182f975acd52e262777` | HTML, anchors, bounded static assets | Eligible; retained alternative |
| Sonnet noticeboard | `3e845f1aa36a6c1ed7b15ef620874c12b3d7a915` | HTML, anchors, bounded static assets | Eligible; owner selected |

Both agents authored a typed requirement and alternative referencing the supplied browser finding. The finding came from an earlier eligible candidate whose event filter changed its selected state without hiding cards. Its automated HTML/anchor checks had passed. That failure remains recorded; the next run received it as frozen context and both new previews visibly hid nonmatching cards and restored all cards. This is a concrete context reuse example, not evidence that all assertions are true.

The owner chose **Sonnet** in the implementation conversation. The implementer entered that explicit choice through the real website's selection form. Decision `decision:def1fec6-d4e5-4c5e-9dbe-e387f35ff3cc` records that provenance, the upcoming October/November dates, and Luna's past May dates. This proves the product selection/publication path; it does not claim the owner personally performed the browser clicks.

Canonical Artifacts `main`, repository published HEAD, and the site manifest all independently read back as `3e845f1aa36a6c1ed7b15ef620874c12b3d7a915`, with no pending publication. Downloaded R2 manifest hash `1057b799a5f10cb6e999df7c5969e8046b04823d1bb6175213afdadad1928fe8` matches the recorded deployment. The published HTML, CSS and JavaScript bytes match that manifest. Actual responses have sandbox CSP, `connect-src 'none'`, and no session cookie.

Browser checks covered both desktop filters and local RSVP confirmations, plus mobile layouts. Sonnet's observed content width equalled its 354px effective viewport; Luna's equalled 390px under tab-scoped emulation. RSVP changes memory-only confirmation text: it does not register an attendee or persist across reloads. Garden content and contact details are fictional fixtures.

## External agent continuation

A new personal username/password account created a starter-backed repository and a one-day contribute key through the real HTTPS API. An isolated local Codex CLI session used remote Streamable HTTP MCP and scoped Git, with no platform provider key copied to it. It published requirement, assumption and alternative records, pushed an isolated fork, and submitted source. The platform independently captured `8c328b2ede2a337a19bebded3b00f296108b5ffd` and passed the starter HTML/static asset checks.

That first local contribution was selected as **development_verification**, explicitly not human approval. It was published to canonical Git and the isolated Field Notes site. A second fresh Codex process then read `repo_context`, `context_search`, `context_get`, `why`, `decision` and `artifact_get`. It identified the original static-only scope, automated selection provenance and missing membership backend. It pushed a follow-up making the placeholder honest, recorded a finding superseding the old assumption, and linked its alternative to the previous proposal.

The follow-up's fresh capture is `0e9551767036469317baaab2338bb15324a0eeae`, eligible against published base `8c328b2ede2a337a19bebded3b00f296108b5ffd`. It remains unpublished for owner review. The original site keeps serving its prior revision. An agent's submitted fork commit and the platform's capture commit intentionally differ: capture constructs new trusted Git objects from validated files.

## Source and local verification

`cargo xtask check` passed 71 native macOS Rust tests, 35 actual workerd tests, one Node profile test, rustfmt, Clippy with warnings denied, the workers-rs Wasm build, TypeScript, Biome and the browser production build. The Linux execution image passed 16 runtime tests. A separate ordinary-UID Linux run also passed 16 runtime tests after reproducing and fixing an `EPERM` child-spawn failure. The production supervisor still refuses startup without owning the reserved agent UID.

One fresh whole-branch reviewer found four Critical/Important issues. All four were observed RED and fixed GREEN: old-DO rollout scope enforcement, current-policy verification after capture, payload disclosure to existing Live sockets after recovery, and `__proto__` source path loss. No minor findings were deferred in this product review. The older foundation's deferred graph projection issue was repaired in product Task 1.

Live testing also exposed Claude's CLI requesting a larger output than the proxy allowed, and failed transcripts not being attached to their execution. Both received failing regressions and fixes. Claude now uses the same 4096-token ceiling as the provider proxy and failed attempts retain scoped evidence.

## Cost and practical limits

- Shared durable Claude allowance: **$8.141532 reserved or charged of $20** at the final observed run. This is conservative safety accounting, not a provider invoice. The cap was not raised.
- MiMo returned HTTP 402 insufficient balance. ZAI was cancelled without a timely completed result. Their adapters have local coverage; no successful live result is claimed for them.
- Hosted inference used the operator's Cloudflare Secrets Store bindings. Personal account onboarding, vault isolation and scoped egress were tested, but hosted inference with a personal BYOK key was not exercised live.
- Static hosting requires relative asset paths. Arbitrary outbound APIs, service workers, server-side hosting, enterprise teams, semantic merging and generic task DAGs remain outside this MVP.
- Typed agent questions are queryable records. Interactive clarification that pauses and resumes a run is not implemented. The owner shipping decision happens in the website.
- Recovery uses a one-time code; email recovery and password reset delivery are not provided.

## Decisions carried into the release

1. Support MiMo/ZAI alongside Claude/Codex, with explicit model choice and no fallback. Cost if wrong: additional provider adapters need maintenance; insufficient balance remains visible.
2. Reserve Claude cost durably under the initial $20 shared cap. Unknown usage keeps its reservation. Cost if wrong: conservative holds can stop tests before the provider's actual bill reaches $20.
3. Use versioned Argon2id and sealed AES-GCM workspace keys; fork a real Artifacts starter; no personal global-key fallback. Cost if wrong: vault/key recovery and starter provisioning require operator maintenance.
4. Restrict v1 to relative static output on an isolated opaque origin with one-hour preview capabilities. Cost if wrong: complex websites need a later deployment profile; sharing a preview grants temporary asset access.
5. Defer deployed acceptance from the UI implementation task to the release task. Cost if wrong: platform rollout issues surface late; the live release gate caught and fixed them here.
6. Publish a fresh Apache-2.0 source snapshot without raw private drafting conversations/history. Cost if wrong: public users lack drafting history; implementation, tests, public architecture and local private history remain available.

The review's declined-to-judge static routing/network/full-stack behavior is covered by decision 4. The narrated video is an edited walkthrough of actual runs and browser captures, with synthetic narration; it is not a continuous recording or a claim of independent user acceptance.
