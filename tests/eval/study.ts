// N9 evaluation harness (paper Studies A/D, small scale) over the public platform API.
// Agents here are SCRIPTED (deterministic strategies, no model calls); they exercise the
// platform's interfaces and measure what each interface exposes. Model-driven arms plug
// into the same Agent interface and need a provider budget to run.

export type Json = Record<string, any>;
export type Api = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: any }>;

/** Deterministic generator (LCG), so every run is reproducible from its seed. */
export class Rng {
  constructor(private state: number) {}
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
    for (let i = 0; i < perModule; i++) symbols.push({ name: `f${m}_${i}`, module: `m${m}`, callees: [] });
  for (const [index, symbol] of symbols.entries()) {
    const earlier = symbols.slice(0, index);
    for (let k = 0; k < Math.min(2, earlier.length); k++) {
      const callee = earlier[rng.next(earlier.length)].name;
      if (!symbol.callees.includes(callee)) symbol.callees.push(callee);
    }
  }
  return symbols;
}

export function source(symbol: SymbolSpec, bump = 0) {
  const body = symbol.callees.length ? symbol.callees.map((c) => `${c}(x)`).join(' + ') : 'x';
  return `export function ${symbol.name}(x: number): number {\n  // ${symbol.name} combines its inputs.\n  return ${body}${bump ? ` + ${bump}` : ''};\n}\n`;
}

export type Layout = 'modules' | 'monolith' | 'symbol-files';
export const LAYOUTS: Layout[] = ['modules', 'monolith', 'symbol-files'];

export function pathOf(layout: Layout, symbol: SymbolSpec) {
  if (layout === 'monolith') return 'src/all.ts';
  if (layout === 'modules') return `src/${symbol.module}.ts`;
  return `src/${symbol.module}/${symbol.name}.ts`;
}

/** Files for a layout, deterministic order. */
export function render(layout: Layout, symbols: SymbolSpec[]) {
  const files = new Map<string, string>();
  for (const symbol of symbols) files.set(pathOf(layout, symbol), (files.get(pathOf(layout, symbol)) ?? '') + source(symbol));
  return [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Task: make `target` add one; its information closure is itself plus its callees. */
export type Task = { target: string; closure: string[] };
export function tasks(symbols: SymbolSpec[], count: number, seed: number): Task[] {
  const rng = new Rng(seed);
  const withCallees = symbols.filter((s) => s.callees.length > 0);
  const picked = new Set<string>();
  while (picked.size < Math.min(count, withCallees.length)) picked.add(withCallees[rng.next(withCallees.length)].name);
  return [...picked].map((target) => ({ target, closure: [target, ...symbols.find((s) => s.name === target)!.callees] }));
}

/** What an agent read and wrote, measured at the API boundary. */
export type Receipt = { bytesRead: number; bytesWritten: number; symbolsSeen: Set<string>; faults: number };
export type Agent = (api: Api, task: Task, symbols: SymbolSpec[], receipt: Receipt, faults: Faults) => Promise<string | null>;
export type Faults = { dropSearchHit: (rng: Rng) => boolean; rng: Rng };

const author = { name: 'Scripted agent', email: 'agent@eval.invalid' };

/** Symbols defined in a text (used to credit closure coverage for whole-file reads). */
const defined = (text: string) => [...text.matchAll(/function (f\d+_\d+)\(/g)].map((m) => m[1]);

async function grep(api: Api, query: string, receipt: Receipt, faults: Faults) {
  const found = await api(`/search?query=${encodeURIComponent(`function ${query}(`)}`);
  receipt.bytesRead += JSON.stringify(found.body).length;
  return (found.body.results as Json[]).filter(() => {
    if (faults.dropSearchHit(faults.rng)) {
      receipt.faults++;
      return false;
    }
    return true;
  });
}

/** File interface: find files by search, read them whole, rewrite the file. */
export const fileAgent: Agent = async (api, task, _symbols, receipt, faults) => {
  const contents = new Map<string, string>();
  for (const name of task.closure) {
    for (const hit of await grep(api, name, receipt, faults)) {
      if (contents.has(hit.path)) continue;
      const file = await api(`/blob?path=${encodeURIComponent(hit.path)}`);
      receipt.bytesRead += file.body.content.length;
      contents.set(hit.path, file.body.content);
      for (const symbol of defined(file.body.content)) receipt.symbolsSeen.add(symbol);
    }
  }
  const home = [...contents.entries()].find(([, text]) => defined(text).includes(task.target));
  if (!home) return null; // could not locate the edit core
  const [path, text] = home;
  const edited = text.replace(new RegExp(`(function ${task.target}\\(x: number\\): number \\{\\n[^\\n]*\\n  return [^;]*)`), '$1 + 1');
  receipt.bytesWritten += edited.length;
  const made = await api('/commits', { body: { ref: 'main', changes: [{ path, content_b64: btoa(edited) }], message: `Bump ${task.target}`, author } });
  return made.status === 200 ? made.body.commit : null;
};

/** Symbol interface: find the symbol, read only it and its callees, edit it by handle. */
export const symbolAgent: Agent = async (api, task, _symbols, receipt, faults) => {
  let handle: Json | null = null;
  let targetSource = '';
  for (const name of task.closure) {
    const [hit] = await grep(api, name, receipt, faults);
    if (!hit) continue;
    const symbol = await api(`/symbol?path=${encodeURIComponent(hit.path)}&symbol=${name}`);
    if (symbol.status !== 200) continue;
    receipt.bytesRead += symbol.body.source.length;
    receipt.symbolsSeen.add(name);
    if (name === task.target) {
      handle = symbol.body.handle;
      targetSource = symbol.body.source;
    }
  }
  if (!handle) return null;
  const replacement = targetSource.replace(/(return [^;]*);/, '$1 + 1;');
  receipt.bytesWritten += replacement.length;
  const made = await api('/symbol-edits', { body: { handle, replacement, author } });
  return made.status === 200 ? made.body.commit : null;
};

export const AGENTS: Record<string, Agent> = { file: fileAgent, symbol: symbolAgent };

export type ArmResult = {
  layout: Layout;
  interface: string;
  tasks: number;
  accepted: number;
  closure_recall: number;
  exposure_precision: number;
  bytes_read: number;
  cost_units: number;
  cost_per_accepted: number | 'not finitely estimated';
  search_faults: number;
};

/** Paper metrics for one arm. Exposure precision is closure bytes over bytes read. */
export function score(layout: Layout, iface: string, runs: { task: Task; receipt: Receipt; accepted: boolean }[], symbols: SymbolSpec[]): ArmResult {
  const sizeOf = (name: string) => source(symbols.find((s) => s.name === name)!).length;
  let needed = 0;
  let covered = 0;
  let closureBytes = 0;
  let read = 0;
  let written = 0;
  let faults = 0;
  for (const { task, receipt } of runs) {
    needed += task.closure.length;
    covered += task.closure.filter((name) => receipt.symbolsSeen.has(name)).length;
    closureBytes += task.closure.filter((name) => receipt.symbolsSeen.has(name)).reduce((sum, n) => sum + sizeOf(n), 0);
    read += receipt.bytesRead;
    written += receipt.bytesWritten;
    faults += receipt.faults;
  }
  const accepted = runs.filter((r) => r.accepted).length;
  // Cost units: (bytes read + bytes written) / 4, a token-equivalent proxy (simulated).
  const cost = Math.round((read + written) / 4);
  return {
    layout,
    interface: iface,
    tasks: runs.length,
    accepted,
    closure_recall: needed ? covered / needed : 0,
    exposure_precision: read ? closureBytes / read : 0,
    bytes_read: read,
    cost_units: cost,
    cost_per_accepted: accepted ? Math.round(cost / accepted) : 'not finitely estimated',
    search_faults: faults,
  };
}
