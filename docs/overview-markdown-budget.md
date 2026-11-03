# Overview Markdown load budget

The first-text measurement is not the finished README. RichMarkdown currently
starts its full parser chunk only after repository data arrives, showing the small
reader in between. With HTML-heavy content, that fallback visibly shows escaped
markup until the sanitizer/parser loads; image requests start after it as well.

With OVERVIEW_MARKDOWN_PRELOAD on for the front build, request the existing parser
chunk on entering an Overview route, alongside the API work. Keep it lazy on site,
account and unrelated repository views. Reuse one module promise for prefetch and
React.lazy; a failed speculative load must be caught and may retry on actual use.
Do not change the parser, HTML sanitizer, image policy or layout.

Prove with a served production build and a held API response that the parser starts
before README bytes arrive, and that switch-off preserves the old lazy path. Record
first text, finished formatted README, content completion and visible image loading
separately. No fallback text or empty image list is proof of finished rendering.
Keep the same JS/CSS/dist budgets and test existing GFM safety behavior.

Local browser regression (all API replies are synthetic): build the frontend with
`VITE_OVERVIEW_MARKDOWN_PRELOAD=on` and serve its production output, then run
`PRELOAD_TEST_URL=http://127.0.0.1:5345 node tests/browser/overview-markdown.mjs`.
For the separately built switch-off case set `PRELOAD_EXPECT=off`. This test holds
the repository response for one second and checks parser-request ordering.
