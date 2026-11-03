# Dev performance figures

The newer [global routing snapshot](2026-11-03-global/global-routing-validation.png)
and [validation report](../global-routing-validation-20261103.md) record dev
`c8d6d9ae` separately. Six API execution destinations and three 1,000-writer
correctness runs passed. Page speed remains open; this snapshot does not claim
a controlled improvement over the earlier connection. Its full ranges and
scope are in [the dated JSON](2026-11-03-global/api-routing-data.json).

```sh
node tools/render-global-validation.mjs --data docs/performance/2026-11-03-global/api-routing-data.json
node tools/render-global-validation.mjs --data docs/performance/2026-11-03-global/api-routing-data.json --check
```

The dated renderer verifies exact metric text, text bounds and 1600×1250 PNG
dimensions. The earlier figures below remain unchanged.

These figures summarize the validated 2026-11-03 dev runs. The atomic-landings
image supplies only the dark/emerald visual style; its claims are not test data.

- [Loading and placement](dev-loading-placement.png), [editable SVG](dev-loading-placement.svg).
- [Concurrent writer validation](dev-concurrency-validation.png), [editable SVG](dev-concurrency-validation.svg).
- [Sanitized source data](dev-performance-data.json), including browser minimum,
  median and maximum values, sample sizes, revisions and per-run read timings.

Loading bars and the table show medians from three browser runs per condition.
Cold Overview means a fresh browser context; backend/CDN caches may already
be warm. The driver does not establish a full cold-storage startup.
Selected dev `b38706d6` improved repeat Overview from 551 to 424 ms and cold
Overview from 891 to 692 ms. Reloads and visible images were slower; Agents
has no clear improvement. Smart Placement `d9d3f693` was rejected after its
API ran in BOM against IAD data. This comparison concerns one retained
large-history repository and establishes no worldwide or production result.

The concurrency figure covers three independent 1,000-writer token bursts.
All 3,000 commits, landings and readbacks succeeded across those runs. Each
run's client read p95 has 1,000 samples. The 1,732 / 2,644 / 2,796 ms summary
is the minimum / median / maximum of the three run p95 values, not a pooled
p95. The tests establish neither 3,000 simultaneous writers nor subsecond
latency under load, real-agent, native-Git or production acceptance.

From the repository root, with its pinned dependencies and system Chrome:

```sh
node tools/render-performance-infographics.mjs
node tools/render-performance-infographics.mjs --check
node tools/render-performance-infographics.mjs --preview-dir .local/performance-previews
```

The renderer generates standalone 1600×1200 SVGs and PNGs from the JSON.
It checks source invariants, exact metric text, proportional bar widths,
text bounds and PNG dimensions. `--check` verifies the committed SVGs without
rewriting artifacts. SVG generation is deterministic; PNG pixels may vary
with Chrome or installed system fonts. The 800px previews support visual
inspection. Full and downscaled figures were inspected before handoff.

After future validated performance runs, publish a new dated snapshot with
its source measurements, sample sizes and deployed revision. Retain previous
JSON/SVG/PNG snapshots and their limitations; do not silently overwrite old
results. Reuse the renderer with the new snapshot's data and output paths.
For example, after saving that validated JSON beside its dated outputs:

```sh
node tools/render-performance-infographics.mjs --data docs/performance/YYYY-MM-DD/dev-performance-data.json --out-dir docs/performance/YYYY-MM-DD
```

The renderer expects this three-condition, three-burst comparison format.
Review narrative observations and scope against each new run before publishing.

Account names, emails, repository identifiers, tokens and private logs are
excluded. No application source, deployment or additional live test is part
of this graphics change.
