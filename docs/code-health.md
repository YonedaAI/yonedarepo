# Code health

Enforce, then track (`docs/observability-plan.md`, Phase O5). Run `cargo xtask health` for the numbers and what moved since the last record. `cargo xtask health --doc` also rewrites the table below.

History stays on the Mac in `.local/health/`: one `<date>.json` a day, and `tests/` for test results. Worktrees share the main checkout's folder.

## Current values

<!-- values:start (cargo xtask health --doc) -->
Measured 2026-11-01.

| Value | Now |
|---|---|
| `deps_cargo_behind` | 49 |
| `deps_cargo_breaking` | 6 |
| `deps_npm_behind` | 7 |
| `deps_npm_breaking` | 0 |
| `evidence_entries` | 425 |
| `evidence_mb` | 418 |
| `evidence_trimmable_mb` | 308 |
| `lines_excess_over_300` | 2003 |
| `lines_files_over_300` | 28 |
| `lines_generated_files_over_300` | 3 |
| `lines_largest_file` | 545 |
| `lines_test_files_over_300` | 76 |
| `live_items_failed` | 0 |
| `live_items_flagged` | 1 |
| `live_items_passed` | 22 |
| `live_items_skipped` | 0 |
| `secrets_unpushed_findings` | 0 |
| `size_frontend_css_bytes` | 132067 |
| `size_frontend_js_bytes` | 998475 |
| `size_frontend_total_bytes` | 3397877 |
| `size_wasm_bytes` | 5824941 |
<!-- values:end -->

`evidence_mb` counts bytes in millions, so it reads higher than `du`'s 395 MiB. A value that couldn't be measured is left out and named under "Not measured", never shown as 0.

## Gates

Each one fails the command, and runs in `cargo xtask check` and in Check (`ci.yml`).

| Gate | Command | Fails on | To fix |
|---|---|---|---|
| 300-line rule | `health lines` | A new source file over 300, a listed file that grew, a listed file now under 300 | Split the file; after a split, `health lines --update` |
| Migration drift | `health migrations` | Applied migration text that differs from `xtask/migrations.lock`, a recorded one gone, a new one unrecorded | Add a new migration; for a new one, `health migrations --record` |
| Secret scan | `health secrets` | A finding in the commits being checked | Remove the value, and rotate it if it was real |
| Size budget | `health size` | Wasm, JavaScript, CSS or total over `xtask/size-budget.toml` | Shrink it, or raise the budget in a reviewed edit |

With `--base <commit>`, `lines` and `migrations` also refuse a list that grew or a ledger line that changed. So raising an entry to get past the rule fails in CI. CI passes the commit the change starts from.

**How the 300-line rule counts:** nonblank lines, leaving out inline `#[cfg(test)] mod name { .. }` blocks. Test files and generated contracts aren't gated; the report counts them. That's why the list holds 28 files, not the 53 first reported: the rest were tests or generated. Counting inline tests would also reward moving them to another file, which fixes nothing.

**A listed file that shrinks** still passes. `health lines --update` locks in the lower count, and only ever lowers counts or removes entries.

**Migrations past `APPLY_THROUGH`** aren't in the ledger, because their text may still change until wave 2 raises the line. Run `--record` in that wave.

**Sizes** are raw bytes, budgeted at the 2026-10-31 size plus 5%, rounded up to 10 KB. They were measured on the Mac. A Linux build embeds different paths, so its Wasm may differ slightly.

### Secret scan

`gitleaks` runs over a commit range, not the whole history. `.gitleaks.toml` silences only the catch-all `generic-api-key` rule, and only for known shapes, so a real token format still fails in a test file.

| Scan | Findings | What they are |
|---|---|---|
| Whole history, default rules | 65 | 64 catch-all hits, 1 `jwt` |
| Whole history, our rules | 1 | The `jwt`: a fixture in a deleted test (`tools/guided/product-gate.test.mjs`, one `digest` claim, 12-character signature) |
| `origin/main..HEAD`, default rules | 19 | All catch-all hits on made-up values in test paths |
| `origin/main..HEAD`, our rules | 0 | |

The command prints a rule, a file, a line and a short commit. It never prints the value, author or email, because CI logs are public. For the same reason, no workflow calls `gitleaks` directly: its verbose output includes author and email.

An unresolvable range is an error. `gitleaks` alone reports one as clean.

## Reports

These don't fail anything.

| Report | Source | Flags |
|---|---|---|
| Test timing and flakes | Vitest suites run by `cargo xtask check`; add another run's JSON with `health tests <file>` | A test that failed then passed (`flaky` on one tree, `fixed or flaky` across trees); a test at 2× its median and 500 ms over it |
| Live results | Newest `.local/staging/realworld-*.json` against the last run of each item, same origin | Newly failing; 1.5× slower and 2 s over |
| Dependencies | `cargo update --dry-run`, `pnpm outdated` | Updates with a new first nonzero version number |
| Evidence | Sizes in `.local/staging` | Nothing; see below |

**Not covered:** `node --test` and `cargo test` results, which have no timing JSON worth keeping yet. Test timing fills up as `cargo xtask check` runs on the Mac.

On the 115 kit runs so far, the live thresholds leave 83 of the 114 comparisons with no flag and average 0.6 slower items a run.

## Deep differential

The scheduled Nightly workflow is removed. Run the deep 100×200 differential manually:

```sh
YONEDA_DIFF_SEED_START="$(date +%s)00" cargo test -p yoneda-platform --lib differential -- --ignored
```

Choose a fresh seed range; replay a failure with `YONEDA_DIFF_SEED=<seed>`.

## Coverage

Measured once on 2026-10-31 at `789fd86c`, not gated.

| Scope | Line coverage | Lines | Tests |
|---|---|---|---|
| **Rust, total** | **77.0%** | 41,231 of 53,578 | 1,223 unit tests |
| `yoneda-refmodel` | 96.7% | 1,261 of 1,304 | |
| `yoneda-core` | 94.6% | 4,773 of 5,043 | |
| `yoneda-store` | 93.7% | 209 of 223 | |
| `yoneda-platform` | 88.8% | 23,155 of 26,068 | |
| `yoneda-cli` | 58.5% | 7,877 of 13,469 | |
| `xtask` | 53.0% | 3,956 of 7,471 | |
| **Frontend and `shared/`** | **60.5%** | 3,667 of 6,066 | 887 tests |
| Worker TypeScript | Not measured | | |

These are floors for what they cover:

- **Rust** counts unit tests only, as Check runs them. `yoneda-cli` integration tests and the workerd suites are left out. Inline test modules are included in the lines.
- **Frontend** counts the 887 `test:frontend` tests, including 30 files they never load. V8 counts executable lines, so the total is lower than the file length.
- **Worker TypeScript** needs the whole workerd suite under Istanbul, which is a separate job. `tools/*.mjs` wasn't measured either.

Rust, with `cargo-llvm-cov` and `llvm-tools`:

```sh
cargo llvm-cov -p yoneda-core -p yoneda-store -p yoneda-platform -p yoneda-cli -p yoneda-refmodel -p xtask --lib --bins --ignore-filename-regex '(/tests/|/tests\.rs$|_tests\.rs$)' --summary-only
```

Frontend, in a copy of the tree with `@vitest/coverage-v8` added:

```sh
pnpm exec vitest run --config tests/frontend/vitest.config.ts --coverage.enabled --coverage.provider=v8 --coverage.include='frontend/src/**/*.{ts,tsx}' --coverage.include='shared/**/*.ts' --coverage.exclude='**/*.test.*'
```

## Evidence: proposed trim

Nothing has been deleted. **Browser captures are 390 of the 407 MB.**

| Kind | Entries | MB |
|---|---|---|
| `browser` | 107 | 390.5 |
| `agents` | 6 | 8.5 |
| `realuser` | 23 | 4.1 |
| `memory-test` | 6 | 3.1 |
| `realworld` | 115 | 0.7 |
| Everything else | 164 | 0.4 |

**Proposal:** delete the browser captures that none of the newest 20 kit runs name, and keep everything else. `evidence_trimmable_mb` above is what that frees. All kit JSON stays, because each file is small, this comparison reads it, and `deploy_evidence.rs` reads the newest one.
