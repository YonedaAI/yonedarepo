# Direct import

Importing a public GitHub repository as a Git fetch the Worker runs itself, behind `DIRECT_IMPORT`. The owner's question: why not just run a `git clone`? To the platform an import is a big `git push` from GitHub.

## Budget

Written before the code, from the hosted numbers we hold (a Worker to Durable Object call 10-50 ms, an R2 write 200-1000 ms) and a first fetch from a Mac. **Not measured on dev.** The bar is the live 6 s to usable and 1 s for `git clone`.

| Measure | Budget |
|---|---|
| **Request to main usable, pack up to 12 MiB** | **under 3 s, whatever Artifacts does** |
| Asking GitHub for its head | 1 request, under 300 ms |
| The pack, stored as the first clone's pack | 1 request to GitHub, 1 R2 put or 1 multipart per 5 MiB, under 1.5 s |
| Reading the pack (every object hashed) | under 2 s of CPU at 12 MiB; never over the isolate's 128 MB |
| The head's files and trees | 1 R2 write per 4 MiB, at most 3 at once, 1 index call per 5,000 objects |
| Landing | 3 authority calls |
| History, pack read back | 1 R2 read, 1 authority call per 250 commits or 1 MiB of changes |
| History, rate | at least 500 commits/s (55 today, limited by tree reads from Artifacts) |
| `git clone` during history | served from the stored pack, as fast as a stored clone |
| Failure at any step | the Artifacts path, which runs beside it, finishes the import |

Bench: `tools/import-bench.mjs`, 3 runs of each repository, server-side timing, min, median and max.
