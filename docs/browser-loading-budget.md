# Repository browser request budget

The owner observed a multi-second blank panel when switching repositories after API
unpinning. The frontend and API remain unpinned; this work removes unnecessary blocking
reads rather than changing repository placement or caching authorization decisions.

Before: resolve a readable name, then full `git_status` (one authority plus 64 shard-status
reads), then mount the view and read its tree/log/content. The initial real-history browser driver recorded
5.39, 4.12 and 4.12 seconds, including an unnecessary one-second image wait in the driver;
that driver is being corrected before comparing content visibility. The full status request alone was 1.38-1.46 seconds. These are three observations, not a percentile or a controlled pre-unpin
comparison.

Budget: browser status is one fresh repository-authority read, plus the existing readable-path
lookup/privacy checks; zero shard-status calls. Content requests must not wait for storage
statistics. Full storage/CLI status retains its existing semantics and is requested only
when needed. Authorization, deletion, quarantine and selected revision remain authoritative.

The opt-in switch is `GET /repos/:id?summary=true`. It omits `objects` entirely, so nobody
can mistake authority-local totals for complete shard totals. Old servers ignore the query
and return the fuller compatible response during rollout. Browser types omit those totals.
The ordinary endpoint and MCP `git_status` still return complete diagnostic totals.

Validate with faulted shard bindings, fresh authorization/private/public/deleted cases, the
actual served repository switch and at least three real-history browser runs with server
timing. Run the required 1,000-writer burst three times on dedicated retained dev fixtures;
never use or delete the owner's retained repositories as load-test scratch data. Record any
unmet load or latency target explicitly. Target useful repository content under one second
on warm navigation; a loading state must render immediately and must not blank the page.

Readable-name requests now reach the unpinned API without a frontend directory read.
The API still resolves ownership and access and forwards to the correct repository
authority. Known repository IDs continue routing directly.

Session bootstrap uses `GET /api/auth/session?summary=true`: one fresh session check,
without avatar or handle reads. Full profile details hydrate independently after admission.
Home feed reads run on Home and global search only. Overview activity sits above the
README and loads independently after metadata/tree reads, when near the viewport. These
optional reads must never gate the repository list, header, files or README text.

Repository navigation starts list and session requests in parallel. The API authenticates
each list request itself; the UI still waits for session admission before displaying the
private workspace. An optional profile response cannot authorize repository access.

A stalled platform authentication must not hold subsequent requests with the same cookie.
Authentication work is request-local. Organization access caches retain only completed JSON
for the existing one-second access bound; they never share pending I/O across requests.
Validate with an intentionally held first lookup and an independent second request, then
repeat normal browser navigation including reload/cancellation before marking dev verified.

## Follow-up: first paint and repeat visits

With `STATIC_ASSET_CACHE=on`, a successful fingerprinted JS/CSS/font/image asset is cached
in the browser for one year. An unchanged asset on repeat navigation must need no network
validation; HTML, API answers, errors and non-fingerprinted assets keep their current policy.
This caches public build output only, never session decisions or repository content.

With `FAST_APP_HEAD=on`, a request carrying an account session skips optional repository
SEO lookups before HTML delivery. It gets the generic noindex application head. Anonymous
public repository metadata retains its current behavior; private data is still authorized
by the API before rendering. Budget: zero metadata API calls before authenticated app HTML.

Compare at least three cold/warm browser requests and real-history navigation runs, recording
network bytes/cache headers, TTFB, and API server timing separately from automation overhead.
The three dedicated 1,000-writer runs are the existing write-path baseline; repeat if a change
affects that path. Client-side caching must not broaden repository or account access.

Native asset serving uses build-generated exact `_headers` entries for existing fingerprinted
files. The deployment passes `STATIC_ASSET_CACHE` into `VITE_STATIC_ASSET_CACHE` for the build.
There is no wildcard rule that could cache a missing chunk’s HTML fallback. Dev and prod
serve assets directly; Worker response headers remain a fallback for proxied asset reads.

### Admin Overview and Traffic

Behind `ADMIN_READ_CACHE`: authenticate every request, reuse completed JSON
snapshots for at most 15 seconds, scoped to environment, cell, operator, query
and relevant report flags. Keep at most 32 entries per isolate; no in-flight
I/O is shared between invocations. Cold isolates still perform the full read.
Successful operator mutations clear local snapshots; failures and partial
responses never warm them. HTTP responses remain `no-store`.

A cold Overview uses three D1 reads per cell instead of eight, with the
newsletter count parallel to cell totals. Traffic keeps its ten analytics SQL
queries but starts the Web Analytics witness as soon as its counting-start
query finishes. Warm snapshots make neither query set. `EARLY_READS` starts
the exact document's Admin read alongside session discovery and hands that
response to the existing authorized API parser once. No IndexedDB is needed.
