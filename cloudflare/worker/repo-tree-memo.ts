// Parsed trees kept in memory, bounded by their total entry count (least recently used
// leave first). Trees are content-addressed and immutable, so a remembered tree never goes
// stale; keys carry the repository, so a tree is served only through that repository's
// access, like the cache tiers (repo-objects.ts).
import type { TreeEntry } from './repo-stores';

export class TreeMemo {
  #trees = new Map<string, TreeEntry[]>();
  #entries = 0;

  constructor(private readonly limit: number) {}

  get(repo: string, id: string): TreeEntry[] | undefined {
    const key = `${repo}/${id}`;
    const entries = this.#trees.get(key);
    if (entries) {
      this.#trees.delete(key);
      this.#trees.set(key, entries);
    }
    return entries;
  }

  set(repo: string, id: string, entries: TreeEntry[]) {
    const key = `${repo}/${id}`;
    // A tree larger than a tenth of the bound would push out most of the others.
    if (this.#trees.has(key) || entries.length * 10 > this.limit) return;
    this.#trees.set(key, entries);
    this.#entries += entries.length;
    for (const [oldest, gone] of this.#trees) {
      if (this.#entries <= this.limit) break;
      this.#trees.delete(oldest);
      this.#entries -= gone.length;
    }
  }

  clear() {
    this.#trees.clear();
    this.#entries = 0;
  }
}

/** This isolate's trees: those it read, wrote through or built (~50k entries, a few MB). */
export const isolateTrees = new TreeMemo(50_000);
