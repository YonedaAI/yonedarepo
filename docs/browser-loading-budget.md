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
