# Explicit global API routing

Status: implemented with bounded dev routing, retained-state, shared-counter and
three-burst validation at `c8d6d9ae`. Page-speed acceptance remains open. Not a
production result. See [the dated report](global-routing-validation-20261103.md).

The owner requires routing from the original human or agent's location. A global
frontend alone does not provide this: the preceding request router largely chose
between US/Europe authority cells, and Smart Placement is a per-Worker optimizer,
not our deterministic regional router. The Smart experiment's Mumbai execution
is corroborated by provider analytics; its precise optimizer reason is unproven.

## Routing contract

- Keep frontend and the public API entry unplaced. Select an explicitly configured
  API execution Worker from the original trusted `Request.cf` continent.
- Configure North America, Europe, Asia-Pacific, Oceania, South America and Africa.
  Each regional API has its own `API_REGION`, with provider placement specified
  in the environment spec. No caller header, cookie or JSON field chooses it.
- Keep execution region separate from authority/storage cell. Stable repository
  IDs, Durable Object namespaces, EU jurisdiction, account home, credentials and
  the shared sign-in counter remain authoritative. Cross-authority forwarding
  remains possible and must be visible in diagnostic results.
- Fresh repository initialization follows trusted creator geography. Existing
  authority state is not moved or duplicated by API routing. Immutable read
  copies may be used after fresh admission and quarantine checks.
- EU-persisted copies stay within the supported EU copy region. Provider location
  hints remain best effort; some regions have no local Durable Object hosting.
  API coverage does not establish universal data residency or physical placement.

## Request and rollout budgets

`REGIONAL_API=on` enables the path; off keeps the existing route. Region selection
does zero SQL, network discovery or Cloudflare management calls. An entry does
at most one regional dispatch and never loops; configured regional handlers skip
entry dispatch. Known regions with missing bindings fail clearly, rather than
silently routing to the US. Unknown geography has a documented default.

Forward the original request and its runtime metadata. Preserve streaming Git
uploads, responses, cancellation, authentication and request-owned background
work. Diagnostic region labels must distinguish the selected entry destination
from a later authority-serving destination; labels contain no account or repo ID.
Keep added header bytes below 512 and routing state request-local.

Regional API workers reference existing Durable Objects, workflows, buckets,
queues and databases; they must not own duplicate state, cron jobs or consumers.
The initial rollout stages providers with dispatch off, then aliases, then bound
entries. Both dev/prod configs derive from the same spec contract. No production
promotion is part of implementation validation.

## Acceptance

Reproduce the old two-region behavior with failing routing tests first. Prove all
six continent choices, spoofed-header rejection, original metadata preservation,
missing-binding refusal, unknown geography, off compatibility, streaming and
one-hop dispatch. Run targeted authority/authentication/runtime boundary tests.
Verify EU authority handling and global sign-in limits are not split by routing.

Live dev evidence must record source revision, original requester geography,
selected API identity, actual execution location, authority location and timings
as separate facts. A pinned Frankfurt client invoked from Costa Rica preserves
the original caller geography and cannot prove a European creator. Synthetic
runtime geography tests and real external-client tests must be labelled.

Measure at least three retained-history page loads and regional read samples,
server timings and min/median/max. Run three 1000-writer bursts on dedicated dev
fixtures after the integrated code is stable; retain fixtures and revoke tokens.
Publish dated, reproducible figures under `docs/performance` after validation.
