// N9 evaluation study (paper Studies A/D, small scale): the synthetic codebase, its
// layouts, the tasks, the acceptance oracle and the paper metrics, used by the scripted
// workerd harness (tests/eval, tests/workers/eval-study.test.ts) and tools/platform-eval.mjs.
// The model-driven eval Worker that also used it was retired on 2026-10-27. Pure code, no
// imports: Node can also load it directly.

export type Json = Record<string, any>;
export type Api = (
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<{ status: number; body: any }>;

/** Deterministic generator (LCG), so every run is reproducible from its seed. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed;
  }
  next(n: number) {
    this.state = (this.state * 1103515245 + 12345) % 2147483648;
    return this.state % n;
  }
}

export type SymbolSpec = { name: string; module: string; callees: string[] };

/** A synthetic TypeScript codebase: modules of small functions with a call graph. */
export function codebase(seed: number, modules = 6, perModule = 5): SymbolSpec[] {
  const rng = new Rng(seed);
  const symbols: SymbolSpec[] = [];
  for (let m = 0; m < modules; m++)
    for (let i = 0; i < perModule; i++)
      symbols.push({ name: `f${m}_${i}`, module: `m${m}`, callees: [] });
  for (const [index, symbol] of symbols.entries()) {
    const earlier = symbols.slice(0, index);
    for (let k = 0; k < Math.min(2, earlier.length); k++) {
      const callee = earlier[rng.next(earlier.length)].name;
      if (!symbol.callees.includes(callee)) symbol.callees.push(callee);
    }
  }
  return symbols;
}

const returned = (symbol: SymbolSpec) =>
  symbol.callees.length ? symbol.callees.map((c) => `${c}(x)`).join(' + ') : 'x';

export function source(symbol: SymbolSpec, bump = 0) {
  return `export function ${symbol.name}(x: number): number {\n  // ${symbol.name} combines its inputs.\n  return ${returned(symbol)}${bump ? ` + ${bump}` : ''};\n}\n`;
}

export type Layout = 'modules' | 'monolith' | 'symbol-files';
export const LAYOUTS: Layout[] = ['modules', 'monolith', 'symbol-files'];
export const INTERFACES = ['file', 'symbol'] as const;
export type Interface = (typeof INTERFACES)[number];

export function pathOf(layout: Layout, symbol: SymbolSpec) {
  if (layout === 'monolith') return 'src/all.ts';
  if (layout === 'modules') return `src/${symbol.module}.ts`;
  return `src/${symbol.module}/${symbol.name}.ts`;
}

/** Files for a layout, deterministic order. */
export function render(layout: Layout, symbols: SymbolSpec[]) {
  const files = new Map<string, string>();
  for (const symbol of symbols)
    files.set(pathOf(layout, symbol), (files.get(pathOf(layout, symbol)) ?? '') + source(symbol));
  return [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Task: make `target` add one; its information closure is itself plus its callees. */
export type Task = { target: string; closure: string[] };
export function tasks(symbols: SymbolSpec[], count: number, seed: number): Task[] {
  const rng = new Rng(seed);
  const withCallees = symbols.filter((s) => s.callees.length > 0);
  const picked = new Set<string>();
  while (picked.size < Math.min(count, withCallees.length))
    picked.add(withCallees[rng.next(withCallees.length)].name);
  return [...picked].map((target) => ({
    target,
    closure: [target, ...(symbols.find((s) => s.name === target)?.callees ?? [])],
  }));
}

/** What an agent read and wrote, measured at the API boundary. */
export type Receipt = {
  bytesRead: number;
  bytesWritten: number;
  symbolsSeen: Set<string>;
  faults: number;
};
export const newReceipt = (): Receipt => ({
  bytesRead: 0,
  bytesWritten: 0,
  symbolsSeen: new Set(),
  faults: 0,
});
export type Faults = { dropSearchHit: (rng: Rng) => boolean; rng: Rng };
export function searchFaults(seed: number, dropRate: number): Faults {
  return {
    rng: new Rng(seed + 1),
    dropSearchHit: (rng) => dropRate > 0 && rng.next(100) < dropRate * 100,
  };
}

/** Symbols defined in a text (credits closure coverage for whole-file reads). */
export const defined = (text: string) =>
  [...text.matchAll(/function (f\d+_\d+)\(/g)].map((m) => m[1]);

/**
 * Independent acceptance oracle over the platform's diff of the landed commit: exactly one
 * line replaced, and the new line is the target's return plus one. Agents' claims count
 * for nothing; edit expansion is the changed-line count over the one-line minimum.
 */
export function judge(diff: Json, task: Task, symbols: SymbolSpec[]) {
  const lines = (diff.changes ?? []).flatMap((c: Json) => String(c.patch ?? '').split('\n'));
  const added = lines.filter((l: string) => l.startsWith('+'));
  const removed = lines.filter((l: string) => l.startsWith('-'));
  const target = symbols.find((s) => s.name === task.target);
  const expected = target ? `+  return ${returned(target)} + 1;` : null;
  const accepted = added.length === 1 && removed.length === 1 && added[0] === expected;
  return { accepted, editLines: Math.max(added.length, removed.length) };
}

export type Run = { task: Task; receipt: Receipt; accepted: boolean; editLines?: number };
export type ArmResult = {
  layout: Layout;
  interface: string;
  tasks: number;
  accepted: number;
  closure_recall: number;
  exposure_precision: number;
  edit_expansion: number | null;
  bytes_read: number;
  cost_units: number;
  cost_per_accepted: number | 'not finitely estimated';
  search_faults: number;
};

/** Paper metrics for one arm. Exposure precision is closure bytes over bytes read. */
export function score(
  layout: Layout,
  iface: string,
  runs: Run[],
  symbols: SymbolSpec[],
): ArmResult {
  const sizeOf = (name: string) => {
    const symbol = symbols.find((s) => s.name === name);
    return symbol ? source(symbol).length : 0;
  };
  let needed = 0;
  let covered = 0;
  let closureBytes = 0;
  let read = 0;
  let written = 0;
  let faults = 0;
  for (const { task, receipt } of runs) {
    const seen = task.closure.filter((name) => receipt.symbolsSeen.has(name));
    needed += task.closure.length;
    covered += seen.length;
    closureBytes += seen.reduce((sum, n) => sum + sizeOf(n), 0);
    read += receipt.bytesRead;
    written += receipt.bytesWritten;
    faults += receipt.faults;
  }
  const accepted = runs.filter((r) => r.accepted).length;
  const edits = runs.filter((r) => r.editLines);
  // Cost units: (bytes read + bytes written) / 4, a token-equivalent proxy.
  const cost = Math.round((read + written) / 4);
  return {
    layout,
    interface: iface,
    tasks: runs.length,
    accepted,
    closure_recall: needed ? covered / needed : 0,
    exposure_precision: read ? closureBytes / read : 0,
    edit_expansion: edits.length
      ? edits.reduce((sum, r) => sum + (r.editLines ?? 0), 0) / edits.length
      : null,
    bytes_read: read,
    cost_units: cost,
    cost_per_accepted: accepted ? Math.round(cost / accepted) : 'not finitely estimated',
    search_faults: faults,
  };
}
