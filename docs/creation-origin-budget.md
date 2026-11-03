# New-object origin guard before API placement tests

The frontend stays global. API execution placement must not choose where a new
repository's state starts. Existing repositories and namespace/ID/jurisdiction
selection remain unchanged; location hints cannot relocate existing objects.

With existing `AUTOMATIC_LOCALITY=on`, preserve current US/EU routing and the
explicit development-only `region_hint` experiment. Add a fallback only for the
currently unhinted trusted original Request.cf origins: AS→apac and OC→oc. A chosen
EU cell/jurisdiction keeps its own hint; it never adopts an out-of-EU origin.
Missing/unknown runtime geography and forged headers/body values add no hint.
The guard uses original request scope, including forwarded trusted cf metadata,
not the API Worker's execution location or an account's saved region.

Budget: no new foreground directory/account/resource lookup. Capture the hinted
namespace for creation and its existing startup work. Start the source authority,
shards and combiners with that hint on first get. For the new fallback, use the
existing request waitUntil for shard/combiners warmup, without waiting for all64
migrations or trace responses. Every first get is initiated before answering;
without waitUntil, keep the established awaited fallback. Explicit experiment and
current US/EU startup behavior remain unchanged.

No new read-copy region, D1/R2 resource, account migration or object identity.
Runtime tests prove first-get options and ownership/lifetime only. Local workerd
explicitly does not implement namespace.jurisdiction(): adapter tests preserve
its already-selected namespace and IDs, but cannot prove physical enforcement. Root owns live
new fixtures and Smart Placement A/B; physical Asia-Pacific placement from a real
Asian client remains unverified until that explicit test occurs.

Cloudflare documents first-get-only, best-effort hints and jurisdiction boundaries:
https://developers.cloudflare.com/durable-objects/reference/data-location/
