# Overview SPA navigation budget

Actual Chrome SPA clicks on frontend `38e6f069` / backend `5bb293ee`, with normal
cache and no interception or throttling, measured three rounds each:

| Transition | Usable content min / median / max | Visible images |
| --- | --- | --- |
| Overview → Files | 180 / 216 / 246 ms (file table) | Below viewport |
| Files → Overview | 532 / 546 / 682 ms (all core sections) | 829 / 1,065 / 1,348 ms |
| Overview → Agents | 316 / 316 / 632 ms (cards and credit) | Not applicable |
| Agents → Overview via repository picker | 800 / 816 / 949 ms | 1,016 / 1,281 / 1,281 ms |

All navigation stayed in one document. No HTTP failures or page errors occurred;
aborted duplicate reads are recorded separately. The three normal inventory sync
POSTs each connected zero repositories. The selected repository/head stayed the
same. These are observed timings, not targets or a production claim.

## Owning path

A named Overview starts with a bundled response. Changing to Files replaces that
response with a plain summary; returning to Overview can start a legacy tree read
before the new bundle, followed by commit/README/history reads that the bundle
then cancels. Returning through the picker has no initial bundle, so it permanently
uses summary → tree → commit/README/history. Repeated image downloads are a
separate follow-up; this slice does not cache private content or change image code.

Every Overview ID navigation should opt into the existing
`summary=true&overview=true&ref=…` response. The existing server switch decides
whether it supplies the bundle. Do not use a retained response from an older
request to select the current read path, even during the first render before an
effect starts. Only a settled current response without a bundle can select the
legacy/OFF fallback. A fresh failure or denial cannot trigger that fallback.

## Budget and boundaries

With the existing bundle switch on: one current core request; no speculative
legacy tree, commit, README or 200-commit history request. The root's separate
activity-deferral slice may add one exact-snapshot activity request after core.
Keep an already admitted repository header usable while core is pending; do not
paint prior-ref content. With the switch off/older server: settle its current
summary once, then use the existing fallback with its errors/retry. Query/ref,
reload and acknowledged minimum-version changes must each have current response
provenance. No authorization, TTL, selected revision or shared cache changes.

Tests must hold a request across a path switch, reload and cancellation; current
response/error identity must never be confused with retained data. Prove seeded
and unseeded Overview, Files/Overview round trips, branch changes, OFF responses,
errors/refusals and recovery without extra speculative requests or endless waits.
Root owns integration, deployment and three fresh actual SPA rounds afterwards.
