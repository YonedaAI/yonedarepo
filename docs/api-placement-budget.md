# Data-local API placement validation

The frontend stays at the viewer's edge. API compute should avoid repeated distant
calls to account and repository authorities. On the unplaced dev path the owner's
connection reaches SJO; a warm named Overview accumulates six 80–120 ms authority,
head and latest-detail waits. The content cache hits and README edge bytes arrive
in 2–3 ms, so those waits remain after the content optimizations. The owner-only
location diagnostic confirmed API execution in SJO, repository/read head in IAD,
and account authority in EWR before placement changes.

Enable Smart Placement on the default fetch handlers of both platform Workers,
with the frontend unchanged. Service bindings must still target default fetch;
placement does not apply to named entrypoints or custom RPC methods. This is an
API-compute change, not a data migration. Keep class identities, EU jurisdiction,
D1/R2/queue bindings, authorization, global sign-in limits and existing data intact.

Before deployment, new-repository initialization must use the original trusted
visitor region rather than API execution location. Preserve current EU boundaries
and US/Europe behavior; test previously unhinted Asia/Oceania origins. Location
hints are best effort and affect only first creation; existing objects do not move.
Actual Asia human-client placement remains a separate validation.

Compare the same source tree before/after placement using at least three actual
Overview and Agents views, fixed request/payload budgets, server phase timings and
US/Europe regional clients. Record min/median/max and placement status. Smart
Placement may need 15 minutes and traffic from multiple locations to be analyzed;
INSUFFICIENT_INVOCATIONS is not proof of data-local execution or a speedup. Use the
owner-only dev location diagnostic to verify execution location where possible.
No models, production deployment, existing-repository recreation or deletion.

Retain the state-read optimizations regardless of placement: they reduce work and
payload. Hold the additional two-request Overview controller until this comparison
shows whether it is still useful. If Smart Placement cannot establish a better
placement, evaluate explicit US/Europe backend placement separately, with the same
creator-location guard and measurements. Never pin the frontend to fix API latency.

References: [Worker placement](https://developers.cloudflare.com/workers/configuration/placement/),
[Durable Object location](https://developers.cloudflare.com/durable-objects/reference/data-location/).

## Explicit data-local fallback

Smart Placement is not accepted merely because its API status is SUCCESS. The
first controlled dev samples executed the primary API in BOM while the retained
repository stayed in IAD, with Overview completion taking several seconds. Retain
that evidence rather than treating an enabled switch as a performance result.

The fallback places the primary API near US East and the Europe API near Frankfurt.
The frontend, creator-origin guard, authority identities and read-copy behavior
remain unchanged. This is compute placement, not a repository/account migration.
Require the same three-run page and regional-read comparison. Accept only if the
measured retained-repository path improves over the unplaced baseline without
breaking authorization, creation or Europe routing. Do not claim new Asian
repositories get a nearby API until regional API coverage is measured there.

Pinned regional client Workers preserve the original caller's geography. A
Frankfurt client Worker invoked from Costa Rica therefore cannot establish a
European creator-location result. Its physical execution location is useful for
network timing, not as a substitute for actual European requester geography.
