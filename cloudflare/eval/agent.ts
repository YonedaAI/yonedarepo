// A model-driven agent for one Study A task. The model sees only the platform's public
// API, shaped as tools for its interface arm (file: search/read_file/write_file; symbol:
// search/read_symbol/edit_symbol), the same calls the scripted agents make. Receipts are
// measured from what the tools return, exactly like the scripted harness; whatever the
// model says about its work is ignored (the arm lands and judges the commit itself).
import { author, base64, FINISH, type LoopOutcome, SEARCH, string, tool, toolLoop } from './loop';
import type { ModelClient } from './model';
import {
  type Api,
  defined,
  type Faults,
  type Interface,
  type Json,
  type Receipt,
  type Task,
} from './study';

export const TOOLS: Record<Interface, Json[]> = {
  file: [
    tool('read_file', 'Read a whole file at the current main branch.', { path: string('Path') }),
    tool('write_file', 'Replace a whole file and record a commit on main.', {
      path: string('Path'),
      content: string('The complete new file content'),
    }),
    SEARCH,
    FINISH,
  ],
  symbol: [
    tool('read_symbol', 'Read one function (its exact source) from a file.', {
      path: string('Path of the file that defines it'),
      symbol: string('Function name'),
    }),
    tool('edit_symbol', 'Replace one function you read with read_symbol; records a commit.', {
      path: string('Path'),
      symbol: string('Function name'),
      replacement: string('The complete new source of the function'),
    }),
    SEARCH,
    FINISH,
  ],
};

export const prompt = (task: Task) =>
  `Task: function ${task.target} must return one more than it does today. Append " + 1" to the end of ` +
  `its return expression (before the semicolon). Before you edit, read the definition of every function ` +
  `${task.target} calls, so you know the change is safe. Change nothing else.`;

export type TaskOutcome = LoopOutcome & { commit: string | null };

/** Runs the tool loop for one task; returns the last commit the model's edits produced. */
export async function runTask(
  model: ModelClient,
  api: Api,
  iface: Interface,
  task: Task,
  receipt: Receipt,
  faults: Faults,
  maxTurns: number,
): Promise<TaskOutcome> {
  const handles = new Map<string, Json>();
  let commit: string | null = null;
  const execute = async (name: string, input: Json): Promise<string> => {
    const path = String(input.path ?? '');
    if (name === 'search') {
      const found = await api(`/search?query=${encodeURIComponent(String(input.query ?? ''))}`);
      receipt.bytesRead += JSON.stringify(found.body).length;
      if (found.status !== 200) return JSON.stringify(found.body);
      const results = (found.body.results as Json[]).filter(() => {
        if (!faults.dropSearchHit(faults.rng)) return true;
        receipt.faults++;
        return false;
      });
      return JSON.stringify({ results: results.map((r) => ({ path: r.path, lines: r.lines })) });
    }
    if (name === 'read_file') {
      const file = await api(`/blob?path=${encodeURIComponent(path)}`);
      if (file.status !== 200) return JSON.stringify(file.body);
      receipt.bytesRead += file.body.content.length;
      for (const symbol of defined(file.body.content)) receipt.symbolsSeen.add(symbol);
      return file.body.content;
    }
    if (name === 'read_symbol') {
      const symbol = String(input.symbol ?? '');
      const found = await api(
        `/symbol?path=${encodeURIComponent(path)}&symbol=${encodeURIComponent(symbol)}`,
      );
      if (found.status !== 200) return JSON.stringify(found.body);
      receipt.bytesRead += found.body.source.length;
      receipt.symbolsSeen.add(symbol);
      handles.set(`${path}#${symbol}`, found.body.handle);
      return found.body.source;
    }
    if (name === 'write_file' || name === 'edit_symbol') {
      const text = String(input.content ?? input.replacement ?? '');
      receipt.bytesWritten += text.length;
      let made: { status: number; body: any };
      if (name === 'write_file') {
        const changes = [{ path, content_b64: base64(text) }];
        made = await api('/commits', {
          body: { ref: 'main', changes, message: `Edit ${path}`, author },
        });
      } else {
        const handle = handles.get(`${path}#${String(input.symbol ?? '')}`);
        if (!handle) return 'Error: read this symbol with read_symbol first.';
        made = await api('/symbol-edits', { body: { handle, replacement: text, author } });
      }
      if (made.status !== 200) return JSON.stringify(made.body);
      commit = made.body.commit;
      return `Committed ${commit}.`;
    }
    return `Error: unknown tool ${name}.`;
  };

  const outcome = await toolLoop(model, prompt(task), TOOLS[iface], execute, maxTurns);
  return { ...outcome, commit };
}
