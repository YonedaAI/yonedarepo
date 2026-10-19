// Turns a unified patch body (from the platform's Rust diff) into numbered display rows.
export type PatchRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'context' | 'add' | 'delete'; text: string; old?: number; new?: number }
  | { kind: 'note'; text: string };

export function patchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  const lines = patch.endsWith('\n') ? patch.slice(0, -1).split('\n') : patch.split('\n');
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('\\')) rows.push({ kind: 'note', text: line.slice(2) });
    else if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), new: newLine++ });
    else if (line.startsWith('-'))
      rows.push({ kind: 'delete', text: line.slice(1), old: oldLine++ });
    else rows.push({ kind: 'context', text: line.slice(1), old: oldLine++, new: newLine++ });
  }
  return rows;
}
