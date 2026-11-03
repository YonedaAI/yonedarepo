# Flight Path: agentic coding evidence

Checked on dev, 2026-11-03. Commander now has accepted code whose behavior was
verified independently of the coding agent and managed reviewers. Click still
has six coding heads and final functional acceptance remaining.

## Useful code, exercised through a CLI

The baseline choice-error code listed allowed values. The accepted change adds
a nearby-value suggestion, and the final snapshot was exercised through actual
command-line programs. The baseline comparison is from source inspection; the
runtime observations below come from the accepted snapshot.

| Input or condition | Observed behavior |
|---|---|
| Valid option and positional value `small` | Succeeds and returns the selected value |
| Invalid nearby value `smal` | Fails and suggests `small` alongside the allowed choices |
| Unrelated invalid value | Fails without inventing a nearby match |
| Documented switch unset or empty | Suggestions remain enabled |
| `CMDR_NO_SUGGESTIONS` set to a nonempty value | Suggestions stop, including values `0` and `false` |
| Extra argument `deply` with a configured `deploy` command | Real excess-argument error suggests `deploy` |
| Valid `deploy` command | Still succeeds |
| Exported matching and hint-table helpers | Return meaningful configured names and reject invalid inputs |

Independent native acceptance passed **8 of 8 groups**, with **21 CLI input/output
observations** and **39 of 39 relevant authored Node tests**, with no skipped
tests. This was targeted feature acceptance, not the upstream project's entire
test suite.

## What Flight Path enforced

| Step | Evidence |
|---|---|
| Drift | A filed documentation-only goal produced invocation-logging code. Intent review rated the captured head high; the landing went around and main stayed unchanged. |
| Quality hold | A deliberately rough hint-table implementation received medium findings. With the temporary medium threshold, that captured head stayed open and main stayed unchanged. |
| Repair | The coding agent read the recorded findings and repaired the same branch. Both reviews rated the new captured head low, and that head landed. |
| Approval hold | A later documentation head passed both reviews but remained unready with zero of one required approvals. |
| Independent approval | A second account approved the actual captured commit. That same commit landed; approval was not transferred to a different head. |

The repair and approval reviews were explicitly requested for captured heads
after coding exited. They prove exact-head review selection, not automatic
trigger delivery. Historical rough-code phases that landed under a more lenient
threshold are not relabeled as rejected phases.

This demonstrates a useful boundary: an agent can produce a working feature,
while drift, required checks and an independent approval can hold publication.
It does not measure an improvement over an ordinary pull-request workflow.

## Independent snapshot and execution

The final native checks used the approved landed snapshot. API commit/tree
metadata, Git commit/tree readback and the source archive's reconstructed tree
agreed. Its archive hash stayed unchanged during testing. Exact identities,
hashes and command receipts remain private.

The stock coding agent ran only in the Docker sandbox. Functional checks ran
separately in the recorded native image, with networking disabled, read-only
inputs, a throwaway home and bounded resources. Project code was not executed
on the host. Host checkouts and all remote refs passed the before/after guards.
Temporary policies and reviewer settings were restored; temporary credentials
were revoked and owned containers stopped. Revoked-token audit rows remain.

The retained receipts also preserve the initial private capture and fixture
failures and their corrections. One functional fixture originally asked for a
subcommand's alias from the root command; it was corrected to the documented
own-command contract. The matching, shape and invalid-input assertions remained.

The final harness revision differed from the deployed runtime only in engineering
documentation; application and harness code paths were checked equal. Existing
release tags represent earlier milestones, not the final accepted feature
archive.

## Context use and remaining work

Context receipts show delivery at session start and inclusion in the transcript.
The resulting code followed the supplied naming convention, which an independent
oracle checked. This supports context delivery and observed compliance, not a
causal claim that context improved quality, speed or cost. There was no A/B test.

Click's remaining heads are nearby-choice suggestions, the suggestion toggle,
intentional drift, a strict quality rejection, repair, and independent approval.
Each still needs its real outcome. After the final approval, capture that exact
snapshot and check configuration-file errors/loaders, precedence, isolation,
choice behavior and schema helpers in the native sandbox. Preserve the existing
managed-review cap and reserve the maintained review maxima before each head.

See the [current handoff](handoff.md#current-work) for release gates. Neither this
feature proof nor historical passing checks accept a new CLI release or production
promotion.
