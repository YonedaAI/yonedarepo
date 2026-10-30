// The change's diff as the agent reads it in its prompt: every changed file's patch, as the
// platform computed it, so a reviewer sees each changed line without depending on its own tool
// calls (a multi-file review that read only part of the change missed a file's problem). Capped;
// files past the cap, binary or too large are named so the agent reads them with git itself.

/** Characters of patch text the prompt carries (about 15,000 tokens). */
export const DIFF_PROMPT_MAX = 60_000;

interface DiffFile {
  path: string;
  op?: string;
  patch?: string;
  binary?: boolean;
  too_large?: boolean;
}

export function promptDiff(changes: DiffFile[], max = DIFF_PROMPT_MAX): string {
  const parts: string[] = [];
  const left: string[] = [];
  let size = 0;
  for (const file of changes) {
    const path = String(file.path);
    if (file.binary || file.too_large || typeof file.patch !== 'string' || !file.patch) {
      left.push(`${path} (${file.binary ? 'binary' : file.too_large ? 'too large' : 'no patch'})`);
      continue;
    }
    const block = `--- ${path} (${file.op ?? 'modify'})\n${file.patch.replace(/\n?$/, '\n')}`;
    if (size + block.length > max) {
      left.push(`${path} (past the prompt's diff limit)`);
      continue;
    }
    parts.push(block);
    size += block.length;
  }
  if (left.length)
    parts.push(
      `Not shown here; read with git diff <base>...HEAD -- <path>:\n- ${left.join('\n- ')}\n`,
    );
  return parts.join('\n');
}
