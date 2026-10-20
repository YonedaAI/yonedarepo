// N9 scripted agents (deterministic strategies, no model calls) over the public platform
// API. They exercise the platform's interfaces and measure what each interface exposes;
// the study itself (codebase, layouts, tasks, oracle, metrics) is shared with the
// model-driven eval Worker in cloudflare/eval/study.ts.
import { type Api, defined, type Faults, type Json, type Receipt, type SymbolSpec, type Task } from '../../cloudflare/eval/study';

export * from '../../cloudflare/eval/study';

export type Agent = (api: Api, task: Task, symbols: SymbolSpec[], receipt: Receipt, faults: Faults) => Promise<string | null>;

const author = { name: 'Scripted agent', email: 'agent@eval.invalid' };

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
