---
title: Proving that a batch of landings is serial, in Lean
date: 2026-10-20
author: Matthew Long
category: Research
order: 4
summary: A Lean 4 proof that landing an accepted batch at once gives the same state as landing its members one at a time, the exact condition merged members need, and why neither hypothesis can go.
image: /blog/machine-checked-batch-landing/cover.webp
imageAlt: Cover card of the paper Machine-Checked Batch Landing, Part IV of the series Source Code as a Transactional Abstraction, by Matthew Long.
caption: Part IV of Source Code as a Transactional Abstraction, by Matthew Long (YonedaAI).
paper: https://yonedarepo-research.vercel.app/papers/machine-checked-batch-landing/
---

When many agents push to one `main`, landing changes strictly one at a time costs one call to the branch's serialized authority per change. So YonedaRepo batches: a combiner lands many changes in one call.

The combiner checks each member against the committed log, but not against the other members of the batch. Part IV asks when landing a batch at once equals landing its members one after another, and answers with a proof Lean has checked.

## The failure batching can cause

The paper's smallest example is write skew. Start with `x = 0` and `y = 0`. Change `ca` reads `x` and sets `y := x + 1`. Change `cb` reads `y` and sets `x := y + 1`. Both are built on version 0, and an unrelated entry `c0` that writes only `z` has landed since.

Checked alone against the log, each change is a clean Rebase, and their write sets are disjoint. The batch installs `x = 1` and `y = 1`. Running them in the order `ca, cb` gives `y = 1, x = 2`; the order `cb, ca` gives `x = 1, y = 2`. **The batch matches neither serial order.** Landed one at a time, the second would have been refused as a Conflict.

Part I of the series showed this and proposed a pairwise rule, proved by hand for fast-forward and rebase members. Members validated as Merge, whose writes overlap something that landed meanwhile, were left out.

## The idea

![Diagram of a head state H with two paths to one result, the top path landing a batch through an octopus merge and the bottom path running the members one after another in ticket order, joined by an equals sign.](/blog/machine-checked-batch-landing/hero.svg "A diagram of the batch landing soundness theorem described in the paper, in which the octopus merge of an accepted batch equals serial execution of its members in ticket order.")

A change is a transaction with a declared read set `R`, a write set `W` and a function from states to states; locations are paths in a tree. Landing validates a change against everything written since its base: Conflict if something it read was written, FastForward if nothing landed, Merge if its writes overlap a later write, and Rebase otherwise.

A batch is accepted when every member validates as FastForward, Rebase, or a Merge with no conflict path, and the members satisfy **the pairwise rule**: no member reads or writes anything an earlier member, in ticket order, writes. In Lean:

```lean
def BatchRule (ci cj : Txn) : Prop := meetsSet (cj.R ++ cj.W) ci.W = false
```

Merged members need one more condition, **patch compatibility**. A merged change has two readings: run the change on the current head, or apply the diff it made against its own base to the head. Patch compatibility says the two agree on the change's write set.

## How YonedaRepo uses it

YonedaRepo's landing path has the model's shape. `yoneda reads add` records declared reads and `yoneda push` sends them; landing refuses a push whose reads changed on `main` meanwhile. Otherwise the platform merges on the server, batching landings on a busy branch into one merge commit. Part I describes the check that enforces the pairwise rule.

The series' synthesis treats batch size as a capacity parameter with no cost in isolation. The theorem below is what that rests on, now including patch-compatible merged members.

## What was proved

The headline theorem, as the paper prints it:

```lean
theorem batch_landing_sound (hlog : NoConflict log) (hacc : BatchAccepted init log ms)
    (hpatch : ∀ e ∈ ms, validateAt log log.length e.txn.R e.txn.W e.base = .merge →
      PatchCompatible (toMember init log e) (snap init log log.length)) :
    let H := snap init log log.length
    let batch := landBatch H (ms.map (toMember init log))
    batch = serialTxns H (ms.map (·.txn)) ∧
    snap init (log ++ ms) (log.length + ms.length) = batch ∧
    ∀ i, ¬ SReach (log ++ ms) i i
```

In words: given a log with no Conflict landing, an accepted batch at its head `H`, and every Merge member patch-compatible with `H`, the batch state equals serial execution in ticket order, the log with the members appended ends in that state, and the serialization graph over declared accesses has no cycle.

The proof chains three lemmas. The octopus merge equals landing members one at a time (`landBatch_eq_seqLand`), which equals a sequence of three-way merges (`seqLand_eq_serialMerge`), which equals serial execution (`serialMerge_eq_serialTxns`).

Neither extra hypothesis can be dropped, and both counterexamples are checked in Lean:

- **Without the pairwise rule**, the write-skew batch above is accepted, matches neither serial order, and leaves a cycle in the serialization graph (`batch_rule_needed`).
- **Without patch compatibility**, one blind write is enough. A changeset declares `W = {x, y}`, reads nothing, and carries `x = 0` and `y = 1`. Meanwhile `x` became 1. The merge keeps `x = 1` and sets `y = 1`; running the change on the head gives `x = 0` (`merge_not_serial`).

That member reads nothing and its merged path is outside its read set, the two conditions you would try first. Patch compatibility is exact for one member: a conflict-free merged landing equals running its transaction on the head **if and only if** it holds (`merge_serial_iff`). For a changeset it means the change never writes a stale base value back over a path the head moved.

The hypotheses are not vacuous. A witness batch merges edits to two lines of one file, `F/1 := 11` and `F/2 := 21`, with a member that increments `G`, and equals serial execution with `F/1 = 11`, `F/2 = 21` and `G = 1`. Lines are modelled as child locations with stable keys, so edits to different lines merge cleanly.

| What the paper reports | Value |
|---|---|
| Theorem declarations, helpers included | 180 |
| Lean | 4.35.0, core only, no Mathlib |
| `sorry`, `admit` or declared axioms | none |
| Main theorems in the axioms report | 72 (6 on `propext` alone, 66 on `propext` and `Quot.sound`) |
| Adversarial review rounds | 2 |
| Clean build | about 3 s wall-clock on the author's machine |

Formalizing also corrected Part I in four places. The most practical: Part I's merge rule makes two identical changes conflict, so **two agents applying the same fix to one file would be told they conflict.** The corrected rule adds the diff3 and Git clause that identical changes merge to that change.

## Limits the paper states

- **The theorems concern the model, not the implementation.** YonedaRepo is linked to the model only by reading code at named commits. The implementation is not verified.
- **Whether the implementation's merged landings are patch-compatible is unknown.** Checking the condition at landing, or restricting changesets to paths whose content they change, would close that gap for changesets.
- **The merge is idealized.** Lines have stable keys; positional diff3, where insertions shift later lines, is not modelled, and the corresponding laws fail for it.
- Validation works at one granularity and the log has one ref, so several mappings to Part I are adapted. Some of Part I's results, such as replay determinism and tamper evidence, are not formalized.
- Reads a writer does not declare are not protected. Under the write check no landed update is lost, but serializability can fail.

## Read the paper

Read [the paper](https://yonedarepo-research.vercel.app/papers/machine-checked-batch-landing/) or download the [PDF](https://yonedarepo-research.vercel.app/papers/machine-checked-batch-landing.pdf). The Lean sources are in the [`lean/` directory of the research repository](https://github.com/YonedaAI/yonedarepo-research/tree/main/lean).

The rest of the series: [Overview](/blog/source-code-as-a-transactional-abstraction), [Part I](/blog/a-transaction-log-for-source-control), [Part II](/blog/partitioned-derived-data) and [Part III](/blog/serverless-git-on-cloud-primitives).
