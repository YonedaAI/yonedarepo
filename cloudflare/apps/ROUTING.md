# App host routing review — 2026-10-12

The requested flat hosts are feasible on the current Cloudflare zone without moving the apex. The initial review was read-only. After explicit user authorization, the two bounded prerequisite changes below were applied; no apps deployment, apps wildcard route activation or certificate change was performed.

## Initial observed zone state

- DNS setup is Full; zone plan is Free. Authoritative nameservers are `coco.ns.cloudflare.com` and `elliott.ns.cloudflare.com`.
- Exactly two DNS records exist: proxied Worker records for `yonedarepo.com` and `www.yonedarepo.com`, both targeting `yonedarepo-dev`. The zone has no Worker Routes configured.
- `apps.yonedarepo.com`, a sample `preview-<24hex>.yonedarepo.com` and a sample `app-<repoID>.yonedarepo.com` do not currently resolve.
- Edge Certificates lists active managed Advanced and Universal certificates for `*.yonedarepo.com` plus the apex, expiring 2027-01-08, with a backup issued. Separate managed coverage exists for `www`.
- Certificate-verified TLS handshakes to an existing Cloudflare edge address, using each sample app hostname as SNI, succeeded with SANs `yonedarepo.com` and `*.yonedarepo.com`. These probes establish edge TLS coverage, not DNS or Worker serving.
- Current encryption mode is Full; Always Use HTTPS is off; minimum TLS is 1.0; TLS 1.3 is on. None of these settings were changed. The apps handler requires HTTPS and denies HTTP before authorization.
- Wrangler's existing authentication returned HTTP 403 for zone listing. The authenticated dashboard supplied the DNS/routes/TLS inventory; no credentials were output or copied.

## Authorized prerequisite changes and readback

- Added only `https://www.yonedarepo.com/*` targeting existing `yonedarepo-dev`. The route inventory was reread after both changes and contains exactly this one route; the apps wildcard remains absent.
- Added `A *.yonedarepo.com` with address `192.0.2.1`, Proxied, TTL Auto, after rechecking its absence. DNS inventory now shows three records. The original apex and `www` Worker records still target `yonedarepo-dev` and retain their proxy status.
- Authoritative A queries to `coco.ns.cloudflare.com` resolve the gateway, sample preview and sample published hosts to Cloudflare edge addresses, as do apex and `www`.
- A fresh browser visit to `https://www.yonedarepo.com/` loads the YonedaRepo workspace/sign-in UI. Unauthenticated command-line HEAD probes return HTTP 403 for both apex and `www`; those probes are not treated as UI acceptance.
- Screenshot evidence is saved locally at `.local/stream-c-routing/www-guard.jpg` and `.local/stream-c-routing/dns-readback.jpg`. The parent must persist the exact HTTPS `www` guard in the platform Wrangler configuration before its next deployment. No existing record was overridden.

## Prepared configuration

`cloudflare/wrangler.apps.jsonc` pins the existing account, `yonedarepo-apps-dev`, development R2 bucket and platform Service binding. Its active route declaration is only the exact `apps.yonedarepo.com` Custom Domain, matching `APP_ORIGIN`. Deployment would create that gateway DNS/certificate automatically. No named production environment is invented; the parent owns environment separation and deployment.

The app wildcard declaration remains commented for parent activation after apps deployment is ready. The `www` guard and proxied wildcard DNS prerequisites are now complete. Deploying the gateway alone does not make app hosts serve executable apps.

## Parent activation ordering

1. Protect `www` with a specific Worker Route to the existing platform Worker. Add this object alongside its existing apex/www Custom Domain declarations in the parent's configuration, then apply and verify it before the apps wildcard:

   ```json
   { "pattern": "https://www.yonedarepo.com/*", "zone_name": "yonedarepo.com" }
   ```

   This exact route targets `yonedarepo-dev` because it belongs to the platform configuration. A route without a script is an alternative zone-level exclusion, but its Custom Domain continuation must be verified before using it. Keep exact exclusions/routes for every future non-app subdomain: DNS precedence alone does not protect a hostname from a Worker Route.

2. Add a **proxied** wildcard DNS record `A`, name `*`, address `192.0.2.1`, TTL Auto. The documentation address is a deliberate non-origin fallback: the apps Worker handles requests and never fetches this address. Existing explicit apex/www records retain precedence. Do not point the wildcard at the platform apex or an actual backend origin.

3. Enable this commented route in the apps configuration after the `www` guard is present:

   ```json
   { "pattern": "https://*.yonedarepo.com/*", "zone_name": "yonedarepo.com" }
   ```

   The leading `*.` excludes the apex. The HTTPS scheme matches the specifically authorized `www` guard. Executable apps and capability links remain HTTPS-only; HTTP requests cannot reach an app through this route or the placeholder origin. The more specific `www` route wins, and `apps` continues to invoke the same apps Worker. Never use `*yonedarepo.com/*`, which also matches the apex. `preview-*.yonedarepo.com/*` and `app-*.yonedarepo.com/*` are invalid infix-wildcard Worker patterns. Wildcard Custom Domains are unsupported. If a future app wildcard omits the scheme, the parent must protect HTTP `www` explicitly too.

4. Parent platform configuration must bind `APPS` to `yonedarepo-apps-dev` and set `APP_ORIGIN=https://apps.yonedarepo.com`. Apps configuration binds `PLATFORM` to `yonedarepo-dev`. Continue using Service binding RPC, since same-zone `fetch()` cannot target a routed Worker.

5. After separately authorized activation, verify DNS/TLS and serving at a signed preview hostname and a published hostname; verify apex and `www` still serve the platform, gateway `/` serves no app code, arbitrary subdomains fail closed, exact-origin API writes work, wrong-host capabilities fail, and responses/forwarded requests contain no platform credentials. Keep all capability/cookie values out of logs and evidence.

The wildcard routes arbitrary first-level hosts to the apps host, but only the exact gateway, derived preview host and valid published host can authorize. Apps retain host-only preview cookies, host-only platform account/session cookies, cookie stripping, per-app origins and separate DO identities. No app code is served from the gateway or the apex. No paid certificate upgrade is needed for these first-level hosts.

## Official references

- [Worker Route matching, precedence and no-script exclusions](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Custom Domains, exact matching and certificate provisioning](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Proxied wildcard DNS and explicit-record precedence](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)
- [Universal SSL first-level coverage for Full DNS](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/enable-universal-ssl/)
