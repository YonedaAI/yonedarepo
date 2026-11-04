# Frontend startup request budget

Normal-cache Chrome observations on dev show the first named Overview request
starts 650–774 ms into startup, while usable content renders 2–78 ms after its
response. Three fresh-context Overview samples were 1,210 / 1,579 / 3,119 ms
(min / median / max); reload 577 / 836 / 867; repeat document navigation
540 / 575 / 910. Agents cards were 1,178 / 1,486 / 1,539 fresh, 633 / 654 / 667
reload and 636 / 669 / 674 repeat. These are browser observations on dev,
not a global or production result. Fresh browser contexts may use warm backend caches.

With the frontend EARLY_READS switch on, a small inline script starts the existing
session-summary GET while the browser downloads/evaluates the application. On an
initial supported named Overview URL it starts the exact existing resolver GET too.
No identity, repository content or secrets enter static HTML. Both requests still
use same-origin cookies and normal server admission. The normal clients consume
the response once, retaining their JSON/error/retry handling and cancellation.

Budget: under 4 KiB additional uncompressed HTML, zero extra JS asset requests,
one session-summary GET and at most one Overview GET. Successful adoption adds
zero backend requests or response bytes. No prefetch for other repository tabs,
explicit revisions, unknown query parameters, or public marketing routes. No
new persistent cache, no shared cross-request I/O, and no layout/copy changes.
Keep the exact request URL, including its existing ref and version-floor contract.

The handoff belongs only to this document URL and expires after 30 seconds.
Navigation, pagehide, explicit session refresh and mutations invalidate it and abort
unconsumed work. A consumer cancellation aborts its adopted transport; an error
is an attempted request, not permission for an uncounted duplicate. Existing viewer
generation/principal checks continue to decide what can render. StrictMode remount
and superseded initial requests must not replay responses for a new viewer.

The versioned handoff explicitly transfers a response and a release function. Its
cancellation bridge remains installed until the consumer finishes reading the
body or its deadline/cancellation settles, rather than ending when headers arrive.
Consumers release the bridge in finally; an aborted JSON body cannot become a
successful empty source response. Document-navigation cancellation still owns
only unconsumed handoffs, not an independently adopted session request.

Validate with targeted contract and API integration tests, including failure,
abort, refresh, changed URL/viewer, switch off, reserved roots and exact resolver
paths. Check served production-build HTML with a held main bundle to prove early
network start, then three normal-cache runs per condition with real content and
server timing. Inspect wide/375px and light/dark, keyboard and loading/error/full
states. The owner excludes writer/load tests for this slice. Root owns deployment
and live no-interception comparison after integration.

## Local implementation evidence

The standalone production-build head script is 3,326 bytes and starts requests before React loads.
A controlled 800 ms hold on the main bundle moved first-request start from
840 to 5 ms for Overview and 839 to 6 ms for Agents. Those single controlled
samples prove overlap, not typical deployment latency. Three normal-cache local
production-build runs per condition also retain exactly one summary and one
named resolver, zero page errors and the original server timing phases. Local
proxy measurements do not reproduce deployed asset latency or isolate backend
warmth, so the actual dev A/B remains required after deployment.

The served app was inspected at wide and 375 px, light and dark, including actual
Overview content and agent cards, simulated held/error resolver responses and
successful retry, and keyboard-opened search with no matching cards. No page-level
horizontal overflow or page errors were observed. The local proof proxy sends
real dev GETs with the authorized test session; automatic sync and other writes
are intercepted. It proves neither sync completion nor provider/model behavior.
