# Smart Placement experiment: what is established

This describes the 2026-11-03 dev experiment. It is not a general benchmark of
Cloudflare Smart Placement and does not establish its eventual steady state.
Filtered provider receipts are private under
`.local/implementation-20261103/smart-diagnosis/`.

The trial deployed revision `d9d3f693` for about 3 minutes 46 seconds. Historical
deployment/configuration records show Smart Placement enabled, no Mumbai region
or host hint, an unplaced frontend and the intended dev default-fetch binding.
The application runtime source was unchanged from the preceding comparison.

Cloudflare Analytics independently identifies BOM as script execution location:
143 of 152 primary-version invocations and 12 Europe-version invocations ran
there. This corroborates the location diagnostic and placement headers; it was
not simply a header echoed from the caller. The tested repository/head remained
in IAD, and account authority in EWR. Repeated calls took roughly 200–768 ms,
while an edge-content hit took about 2 ms. That remote I/O explains the measured
request slowdown. Repeat Overview completion had a 3,672 ms median in this trial.

The provider reported a successful analysis shortly after deployment. That
status is not evidence that our application became faster. The trial was shorter
than the documented analysis allowance of up to 15 minutes, and cannot establish
what a longer run would have chosen.

The final 1000-writer wave occurred after the initial selection, so it cannot
explain that selection. Earlier mixed load/probe traffic might influence a
per-Worker learned profile; this is an inference, not a demonstrated cause.
The available APIs expose neither candidate scores nor the training window or
selection rationale. Why BOM won remains unproven; those details would require
a provider investigation using the saved private version/time receipts.

Our separate design error is established from source: most requests selected
between US/Europe authority cells, while caller-geography handling covered only
part of creation/copy behavior. Smart Placement does not implement the owner's
explicit original-user-location routing contract. The replacement design is
[explicit regional API execution](explicit-regional-api.md); existing performance
results remain documented rather than silently replaced.

Reference: [Cloudflare Worker placement](https://developers.cloudflare.com/workers/configuration/placement/).
