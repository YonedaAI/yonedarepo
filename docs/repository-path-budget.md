# Repository path metadata request budget

A repository-picker navigation already uses the repository id: it makes one
`GET /repos/:id?summary=true`, with no readable-name resolution. The latest three
observations showed header visibility at 1,022 / 494 / 467 ms and README visibility
at 2,075 / 928 / 898 ms. The cold summary spent 167 ms in authentication and 649 ms
in one repository-status authority call; the remaining 198 ms includes transport
and path decoration. The two warm summaries spent 162 ms in authentication,
105 / 102 ms in status, and another 218 / 196 ms outside those spans. These are
observations, not an attribution of every residual millisecond to SQL.

Path decoration currently looks up the repository's owner in D1, then looks up an
email-named owner's handle. With `JOINED_REPO_PATH=on`, one LEFT JOIN returns both.
Budget: one local D1 query for ordinary status path decoration, plus the existing
home-cell fallback only when an email-named owner has no local handle projection.
The freshly authorized status still supplies the repository's current name. No
new authorization cache, repository status cache, or selected-revision change.

Server-Timing `path.metadata` isolates the decoration lookup from authorization.
The switch is off by default. A missing projection, an owner without a handle,
username/org ownership and the legacy cross-cell handle fallback retain existing
results. Public principal redaction retains its separate handle reads when needed.
The full diagnostic status endpoint remains explicit and unchanged apart from
this opt-in path decoration; no content read begins before its authorization.

Validate the query count and exact old/new results for email, username and org
owners, absent/stale rows, renamed repositories, home-cell aliases, public/private
access and directory grants in workerd. After a coordinated dev deploy, compare
three real-history picker navigations with server timing. The existing burst
bench need not repeat for a decoration-only SQL change: no write or file-read
path changes. Record useful content latency honestly, including any remaining
cold authority or sequential tree-to-README delay.

Direct named URLs separately resolve and then fetch summary. Their observed
resolve durations were 1,069 / 450 / 364 ms, followed by 385 / 482 / 371 ms for
summary. A combined resolver/metadata handoff is deferred; it cannot improve the
measured picker navigation and requires separate freshness/lifetime validation.
