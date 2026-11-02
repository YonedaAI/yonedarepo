// A change's Slop, Intent drift and Risk cards, behind `LANDING_INSTRUMENTS`: the authority's facts about its
// last heads (repo_store/change_instruments.rs), each head's diff measured here, and the answer
// from Rust (platform_instruments.rs). The read shares one budget across heads, newest first,
// and a file seen on an earlier head costs nothing, so its reads stay what one diff costs. An
// older head it can't finish has no score: a partial one would not compare with the others.
import { compute } from './repo-compute';
import { PATCH_BYTES, PATCH_FILES, patchOf } from './repo-diff';
import type { RepoObjects } from './repo-objects';
import { type Json, type RepoContext, withTrees } from './repo-ops';
import type { Env } from './types';

export const instrumentsOn = (env: Env) => env.LANDING_INSTRUMENTS === 'on';

type Lines = { additions?: number; deletions?: number };
type Budget = { bytes: number; files: number };

/** One file's line counts, none when it can't be measured; `null` once the budget is spent. */
async function measure(
  objects: RepoObjects,
  change: Json,
  seen: Map<string, Lines>,
  budget: Budget,
): Promise<Lines | null> {
  const key = `${change.old?.id}:${change.new?.id}`;
  const known = seen.get(key);
  if (known) return known;
  if (budget.files <= 0 || budget.bytes < 0) return null;
  budget.files -= 1;
  const patch = await patchOf(objects, change, budget);
  if (patch.patch_omitted === 'budget') return null;
  const lines = { additions: patch.additions, deletions: patch.deletions };
  seen.set(key, lines);
  return lines;
}

/** `GET /changes/:n/instruments`. The authority refuses a path-restricted caller, as it does
 * the change itself, so nothing here filters by grant. */
export async function changeInstruments(ctx: RepoContext, number: number) {
  const facts = await ctx.call({ op: 'repo_change_instruments', number });
  const objects = await ctx.objects();
  const seen = new Map<string, Lines>();
  const budget = { bytes: PATCH_BYTES, files: PATCH_FILES };
  const files: (Json[] | null)[] = [];
  for (const [n, head] of (facts.heads as Json[]).entries()) {
    if (!head.compared) {
      files.push(null);
      continue;
    }
    const { changes } = await withTrees(objects, {
      op: 'tree_diff',
      old: head.compared.base_tree,
      new: head.tree,
    });
    const measured: Json[] = [];
    let spent = false;
    for (const change of changes as Json[]) {
      const lines: Lines | null = spent ? null : await measure(objects, change, seen, budget);
      spent = lines === null;
      measured.push({ path: change.path, old_path: change.old_path, ...lines });
    }
    // The newest head always scores, with what it couldn't measure counted against it.
    files.push(spent && n > 0 ? null : measured);
  }
  return compute({ op: 'change_instruments', facts, files });
}
