# Regional routing: dev US and Europe

Validate dev first, then deploy the same topology in prod through the ship pipeline. No
production resources or switches are changed while this implementation is being reviewed.
Environment-specific names, credentials and resource identities remain separate.

The browser app runs at the Cloudflare edge with no placement setting. Its static assets use
Workers Assets. Account password sign-in and its rate limiter run on the existing placed
platform Workers. OAuth keeps its existing credentials/callbacks on the front, while its
AUTH_LIMITER calls the placed primary platform's default HTTP fetch handler, authenticated
with a purpose-separated HMAC using the already-shared OWNER_TOKEN. Placement excludes RPC
and named entrypoints, so neither is used for this counter. The raw operator credential is
never transmitted; unsigned/tampered/stale calls cannot spend an allowance. The US platform stays near us-east-1;
Europe stays near eu-central-1.
The existing region Worker and private European D1/R2/DO jurisdiction must be deployed before
`cells[].bound=true` adds service bindings. The deployment preflight checks this prerequisite.

## Request behavior

1. A known repository ID selects its existing authority, including every older US ID. URLs
   and IDs never move. Readable names use their existing owner lookup, then the same ID rule.
2. A new create or import selects the supported region of **this request's `request.cf`**
   before any account-home cookie or personal-token lookup hint. An unsupported or absent
   location retains the existing fallback. A forged HTTP region header is ignored.
3. Every internal HTTP rebuild preserves the incoming Cloudflare metadata through Request
   construction and service binding forwarding. Credentials are checked again at destination.
   An already selected creation destination is carried in the internal body to avoid loops.
4. Existing repository reads and writes continue at that repository's one ordered authority.
   Authorized small immutable file/tree reads may use the existing nearby read-copy path;
   its authority access checks, epochs, quarantine and durable purge fencing stay in force.
5. Password sign-in is forwarded to a placed backend. Provider callback accounts use the
   existing shared account namespace with an explicit initial location hint; they do not
   create a second identity namespace at each edge location.

Forks currently inherit objects from their parent's namespace/store and therefore remain in
that authority's region. Merely changing a fork ID or hint would silently break inherited
reads, parent access checks, quarantine and rollback. Cross-region fork creation needs an
explicit cross-region parent-object/authority transport and its own failure-boundary proof;
this dependency is recorded rather than represented as completed.

## Request budget

No performance claims are made by this change. Relative to the current path:

| Request | Routing reads and service hops |
|---|---|
| Frontend JS/CSS | Assets request, zero platform/account calls |
| Known repository ID | Zero routing reads, one edge-to-selected-platform binding hop |
| Create/import, supported actual location | Zero routing reads, one selected-platform hop; ordinary auth/create work follows |
| Password sign-in | Zero routing reads, one placed-platform hop |
| OAuth/front auth allowance | One authenticated default-HTTP primary-platform hop; no RPC or edge-local counter |
| Readable repository name | Existing owner/handle lookup on cold name, then one platform hop; 60s isolate cache |
| Account-wide aggregation | Existing per-known-region fanout; a failed region is reported partial |
| Nearby blob/tree hit | Existing source authorization plus registry permit and regional copy read; no ordinary bytes-tier walk |

There is no automatic failover of writes to another authority. An unavailable selected region
fails; it never creates another history. Source authorization remains authoritative even when
copy bytes are local. SSH client geography remains unsupported because the gateway's location
is not the original client location.

## Deployment and rollback

Keep SourceRepository identities and all applied Durable Object class migrations, including
v9 RepositoryReadCopy. No new data migration is required here. Deploy the class provider US
platform first, existing regional consumers next, then edge and frontend. Enable bindings and
CELLS after those bootstrap targets exist, first in dev and then in the equivalent prod
topology through the approved ship pipeline. Keep the API custom-domain cutover
separate until both direct platform and edge/public browser paths pass functional proof.

Rollback uses additive code/config: turn automatic copies off, retain bound regional service
routes and ID decoding for any EU repositories already created, and optionally pin the front
again. Do not revert to a pre-cell/pre-v9 binary or remove EU bindings after new EU IDs exist.
Turning copies off does not disable quarantine or registered-region purge fences.

### First production bootstrap

Production currently lacks EU resources. Adding `bound=true` or copying dev resource IDs
would make the ordinary deploy fail, so activation requires a staged provisioning path.
Use `cargo xtask infra prepare --env prod --dry-run` to inspect missing resources without
changing them. Its confirmed form prepares only declared missing resources and records real
provider-issued identities; review and commit those identities before deployment. The normal
guarded deployment then derives temporary unbound configurations from the same desired spec,
deploys the primary class provider before missing regional Workers, verifies them, and performs
the final bound rollout. It never requires hand-editing `bound`, `CELLS` or migration history.

Production release still requires its existing ship/HEAD/container guards, dev proof and the
owner's ship instruction. Resource preparation is separate from release approval. See
[the regional deploy procedure](regional-deploy.md) for the implemented commands, retry behavior,
captured-revision checks and deployment source fence.

## Acceptance evidence

Workerd tests must cover current-location creation despite old home cookies/tokens, internal
Request rebuilds and a real service-binding hop carrying `cf`, wrong first-hop correction,
US legacy IDs, auth failures and account-home listing. Narrow live dev proof retains pure
fixtures: OFF baseline existing private repository, current EU frontend JS/CSS bytes matching
the local deployed build, new no-hint EU creation and observed authority/shard/server colos,
existing-repository copy use, and source auth/revocation/quarantine boundaries.

A relay's execution colo is separate from its visitor's geography. Observed FRA execution
with inherited `loc=CR` does not prove the API saw a European person. Do not forge a user region
header or count a configured placement hint as physical proof. Use a genuinely European
request source (including the owner's VPN if necessary), and record this limitation until
that request selects Europe and the created authority's `/where` agrees.

Cloudflare references checked for this implementation:
[Request construction and cf](https://developers.cloudflare.com/workers/runtime-apis/request/),
[HTTP service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/),
[placed backend and edge frontend](https://developers.cloudflare.com/workers/configuration/placement/#multiple-workers).
