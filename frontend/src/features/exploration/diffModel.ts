export type PatchLine = {
  text: string;
  kind: 'added' | 'removed' | 'context' | 'header' | 'metadata';
  old?: number;
  next?: number;
};
export type PatchFile = {
  path: string;
  previousPath?: string;
  status: 'Modified' | 'Added' | 'Deleted' | 'Renamed' | 'Binary';
  additions: number;
  deletions: number;
  lines: PatchLine[];
};

// Git quotes paths using C escapes, including octal UTF-8 bytes. Decode only for display.
export function displayGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };
  const body = value.slice(1, -1);
  for (let i = 0; i < body.length; ) {
    if (body[i] === '\\') {
      const octal = body.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal) {
        bytes.push(Number.parseInt(octal, 8));
        i += octal.length + 1;
      } else {
        bytes.push(...encoder.encode(escapes[body[i + 1]] ?? body[i + 1] ?? '\\'));
        i += 2;
      }
    } else {
      const point = body.codePointAt(i);
      if (point === undefined) break;
      const character = String.fromCodePoint(point);
      bytes.push(...encoder.encode(character));
      i += character.length;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
const stripPrefix = (path: string) => displayGitPath(path).replace(/^[ab]\//, '');

/** Parse captured unified patches without interpreting the code or applying a merge. */
export function patchFiles(diff: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | undefined;
  let old = 0;
  let next = 0;
  let inHunk = false;
  for (const text of diff.split(/\r?\n/)) {
    if (text.startsWith('diff --git ')) {
      const paths = text.match(/^diff --git ("(?:\\.|[^"])*"|a\/.*?) ("(?:\\.|[^"])*"|b\/.*)$/);
      const from = paths ? stripPrefix(paths[1]) : 'Captured patch';
      const to = paths ? stripPrefix(paths[2]) : from;
      file = {
        path: to,
        previousPath: from !== to ? from : undefined,
        status: 'Modified',
        additions: 0,
        deletions: 0,
        lines: [],
      };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk) {
      if (text.startsWith('+++ ') && text !== '+++ /dev/null')
        file.path = stripPrefix(text.slice(4));
      if (text.startsWith('rename from ')) {
        file.previousPath = displayGitPath(text.slice(12));
        file.status = 'Renamed';
      }
      if (text.startsWith('rename to ')) file.path = displayGitPath(text.slice(10));
      if (text.startsWith('new file mode ')) file.status = 'Added';
      if (text.startsWith('deleted file mode ')) file.status = 'Deleted';
      if (text.startsWith('Binary files ') || text === 'GIT binary patch') file.status = 'Binary';
    }
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ text, kind: 'header' });
    } else if (inHunk && text.startsWith('+')) {
      file.additions++;
      file.lines.push({ text: text.slice(1), kind: 'added', next: next++ });
    } else if (inHunk && text.startsWith('-')) {
      file.deletions++;
      file.lines.push({ text: text.slice(1), kind: 'removed', old: old++ });
    } else if (inHunk && text.startsWith(' ')) {
      file.lines.push({ text: text.slice(1), kind: 'context', old: old++, next: next++ });
    } else if (text) file.lines.push({ text, kind: 'metadata' });
  }
  return files;
}
