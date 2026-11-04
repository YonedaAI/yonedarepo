# Public-site entry split budget

The first-load f87 trace downloaded 336,264 wire bytes of app JavaScript before
rendering a repository. Its entry statically includes SiteRoot and every public
page; useAppShell also imports signedInHint from SiteRoot. SiteRoot's SEO import
pulls 31 eager docs and 15 blog posts into that same entry despite lazy SiteDocs.
The source content is 249,349 bytes; that is attribution, not a wire saving.

The current fb4 build entry is 1,083,759 bytes, gzip 334,789, Brotli 272,899 and
local zstd 335,464 bytes. Record exact after-build entry/public chunks using the
same compressors; local compression does not promise Cloudflare's wire result.

Repository and Agents entry must not fetch public-site chunks. Extract only the
browser's sign-in hint into a small module, and load SiteRoot on public routes.
No API request, private data cache or session reuse is added. Keep the static
public prerender and SEO generation direct. On an initial public document, keep
its prerendered HTML until its client component is ready; SPA public navigation
uses the existing loading/error pattern. The initial root route's signed-in hint
continues to choose the workspace until fresh session discovery answers.

Validate Overview, Agents, public home/docs/deep links/sign-in, navigation back,
chunk failure and wide/375px/light/dark/keyboard behavior in the served app.
The f87 cold core was 1,587 ms while resolve took 1,180 ms (838 ms server): a
smaller bundle alone does not remove that backend wait. Claim bytes and requests
from the build/served proof, not a latency improvement before live measurement.

## Same-base build result

Both builds include dev `2ce41ce7` (notification and Overview spacing fixes).
All compressed columns use the same local gzip settings, not mixed wire codecs.

| JavaScript | Before | After | Change |
|---|---:|---:|---:|
| Initial static dependency closure, raw | 1,085,764 B | 752,225 B | −333,539 B |
| Initial static dependency closure, gzip | 335,613 B | 226,070 B | −109,543 B (32.6%) |
| Entry file alone, gzip | 335,184 B | 206,431 B | −128,753 B |
| Public initial dependency closure, gzip | 335,613 B | 339,387 B | +3,774 B |

The public chunk is 336,961 B raw / 113,317 B gzip. Docs UI remains another
15,682 B raw (about 6 KB gzip) when opened. The shared chunk costs are included
in the closure above. The app entry contains no eager docs/blog content paths.

Public HTML preloads its immutable client chunk and its 303 B stylesheet. The
blank app HTML adds only an exact `/signin` or `/signup` head guard (optional
trailing slash) to preload those same assets; repository/Agents paths do not
request them. Initial public HTML stays visible until the loaded component can
mount. Later client navigation uses the shared loading state and existing error
boundary/reload path. Static public prerender and SEO generation remain direct.

A later quiet dev baseline measured cold core around 1,008 ms median, with the
rich parser adding about 300 ms in two fresh samples. That is separate from this
payload reduction; its head preload is deferred to a focused follow-up. No live
latency gain is claimed by the local served route tests.

## Plain named Overview renderer preload

The newer f87 trace showed plain README text at 681/692 ms in two fresh loads,
but the rich renderer at 974/1,008 ms. Its 109.8 KB wire chunk started only after
the app bundle (627/642 ms), ending at 936/969 ms. This is a measured serial code
request, separate from the authority's selected repository data.

Under the existing `VITE_OVERVIEW_MARKDOWN_PRELOAD` switch only, add a build-known
immutable renderer modulepreload in the document head. Use the exact initial
named Overview guard shared with early admission: valid nonreserved owner/name,
no subroute, query or fragment. Off and other routes issue no head renderer
request; their existing on-demand Markdown behavior is unchanged. No API read,
authorization, data cache, selected revision or retry contract changes. The
initial JavaScript dependency closure does not grow by the renderer; its already
needed request moves earlier. Validate controlled main-bundle delay, normal
cache reuse, correct README and failed renderer retry in the actual served app.

Local verification reproduced the missing head request before the change. The
production build with the switch on then started renderer code before a held
main response in wide/375px light/dark contexts; the exact rich README rendered
and a normal reload made no additional renderer HTTP request. Seven unsupported
routes had no head renderer request. A separate switch-off build preserved the
normal lazy render with no head request. With early API reads off and renderer
preload on, renderer code still started early while zero API calls started before
the app. A missing renderer chunk reached the existing Reload action and rendered
the correct README after retry. Public-site preload/navigation tests also passed.
These controlled local checks establish ordering and correctness, not a live
performance result.

## Start renderer preload before blocking styles

The deployed f7 trace still started the renderer at 468/441 ms, immediately after
CSS ended at 468/439 ms, while the app bundle ended at 555/542 ms. The classic
head script was placed after that stylesheet and therefore waited for it. Core
was 797/809 ms in those samples; the earlier preload did not eliminate the full
renderer delay. The separate fresh median improved from 1,008 to 809 ms, while
reload was mixed (538 to 576 ms); these are observations, not this fix's result.

Place only the existing renderer preload script immediately after the opening
head tag, before stylesheets. Preserve its existing switch and URL guard. A
production-served regression holds both CSS and the app bundle: the eligible
renderer request must start before CSS is released. Off and unsupported routes
still make no head renderer request, and ordinary lazy rendering remains intact.
No new API read, cache policy, routing or authorization behavior is introduced.
Live timing remains to be measured after the frontend deployment.
