# Local landing budget

Status: budget written 2026-11-06 before the change; results below as measured.

Landings on a clone's local `main` (`yoneda local serve`) are serial: each holds the branch's landing lock from its first attempt to its last, so throughput is one over the time a landing spends inside that lock. Correctness stays as it is: the authority verifies every landing; this budget only removes cost.

## Baseline (2026-11-06, Mac, debug build, `write_speed`, 3 runs)

About 10 landings a second at 4 and 16 writers; a lone push takes 62–74 ms at the service. A profile of 8 simultaneous disjoint pushes (every Git process and authority call timed):

| Cost | Count | Each |
|---|---:|---:|
| `git index-pack --stdin --strict` (the push's objects, outside the lock) | 8 | 82 ms |
| `git receive-pack` (the platform's merge commit, inside the lock) | 7 | 41 ms |
| `git cat-file --batch` (tree, file and read-back reads, mostly inside the lock) | 23 | 16 ms |
| `git update-ref` (ref projection) | 8 | 16 ms |
| `git for-each-ref` (ref projection) | 9 | 12 ms |
| An authority call (`repo_land`, `repo_merge_plan`, …) | 15–40 | 0.2–1.4 ms |

**The time is Git process starts, not the engine.** `/usr/bin/git` on macOS is a shim that finds the developer tools on every run: 9.8 ms median for `git --version` against 3.1 ms for the binary it runs (30 runs each).

## Budget

| Path | Budget |
|---|---|
| Git binary | Found once at start (`xcrun --find git` on macOS, else `git` on `PATH`) and run by its path |
| Object reads | One long-lived `git cat-file --batch` per service, shared under a lock; no process per read |
| Inside the landing lock, per merge landing | No Git process: the merge commit is staged in the authority (`repo_prepare_commit` with `stage`) and at most 8 authority calls |
| Inside the landing lock, per fast-forward | No Git process |
| Ref projection | At most 2 Git processes per push |
| Throughput, 16 disjoint writers, debug build | At least 25 landings a second |
| A lone push at the service | At most 40 ms median |
| Everything else | Unchanged: the same tests (`cargo test -p yoneda-local`) pass, including the 8-writer races |

Switches, for comparison and as a way back: `YONEDA_LOCAL_READER=spawn` brings back one `cat-file` process per read; `YONEDA_LOCAL_STAGE=off` writes each merge commit with `receive-pack` inside the lock. Unset, the long-lived reader and staging are used.

## Results (2026-11-06, same machine and bench, 3 runs each)

Two steps, each measured on its own:

1. **Git by its real path** and **one long-lived reader**: a lone push 62–74 → 37–39 ms at the service; 16 writers 10.7–11.2 → 16.1–16.3 landings a second. The profile then showed a landing holding the lock 36 ms, 35 of them in the merge commit's `receive-pack` (isolated, on the same store settings: `index-pack` 17 ms, `unpack-objects` 27 ms, one `hash-object -w` 8.8 ms; every durable Git write is a full flush on macOS). `core.fsyncMethod=batch` and `receive.fsckObjects=false` changed nothing (36 and 35 ms).
2. **Staged merge commits** (`src/outbox.rs`): the merge commit's objects stay in the authority's SQLite (durable) until one drain writes every pending commit to the store in one pack, after the lock and before refs move. Refs move only to commits the store holds; reads fall back to the staged copies; `serve` drains on start, so a crash between landing and drain heals (`restart_drains_a_staged_merge_the_crash_left_behind`; removing the start-up drain fails it).

| Writers | Service ms, min/median/max | Landing ms (incl. waiting) | Landings/s | Before |
|---:|---:|---:|---:|---:|
| 1 | 37–40 | 0 | 9.9–10.8 | 62–74 ms, 8.0–9.2/s |
| 4 | 64–79 / 108–129 / 112–133 | 1–2 / 7–13 / 22–26 | 19.4–22.2 | 9.8–10.5/s |
| 16 | 189–208 / 353–379 / 378–400 | 2–4 / 57–60 / 99–113 | 28.5–30.4 | 10.7–11.2/s |

Budget: met (16 writers at least 25 a second; a lone push at most 40 ms median). The lock is no longer what limits: at 16 writers a landing waits 57–60 ms median, and the rest of a push is its own pack (`index-pack`, run in parallel) and the shared drain and ref projection. `cargo test -p yoneda-local`: 31 passed, 8 ignored (dev and Docker), also with both switches off; the race, check and local tests together, 20 runs: 0 failures. Not measured: a release build.
