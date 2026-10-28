// Branches and tags as the refs answer lists them, and the requests that create a branch
// (`POST /branches`, compare-and-swap on "no branch yet"), delete one (`POST /refs/batch`
// with a null commit, on its current value) and create a tag (`POST /tags`). `main` moves
// only by landing and is never deleted; tags are immutable. The server decides each one.

export type RefRow = { name: string; commit: string };

const HEADS = 'refs/heads/';
const TAGS = 'refs/tags/';
export const PROTECTED_BRANCH = 'main';

function under(refs: Record<string, string> | undefined, prefix: string): RefRow[] {
  return Object.entries(refs ?? {})
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, commit]) => ({ name: name.slice(prefix.length), commit }));
}

/** Branches, `main` first, then by name. */
export const branchRows = (refs: Record<string, string> | undefined) =>
  under(refs, HEADS).sort((a, b) =>
    a.name === PROTECTED_BRANCH
      ? -1
      : b.name === PROTECTED_BRANCH
        ? 1
        : a.name.localeCompare(b.name),
  );

/** Tags by name. */
export const tagRows = (refs: Record<string, string> | undefined) =>
  under(refs, TAGS).sort((a, b) => a.name.localeCompare(b.name));

/** Why `name` is not a ref name the server accepts, or '' when it is (git's rules). */
export function refNameProblem(name: string): string {
  const bad =
    !name ||
    name.length > 200 ||
    name.split('/').some((p) => !p || p.startsWith('.') || p.endsWith('.lock')) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: git refuses control characters.
    /[\u0000-\u001f\u007f ~^:?*[\\]/.test(name) ||
    name.includes('..') ||
    name.includes('@{') ||
    name.startsWith('refs/');
  return bad ? 'No spaces, ~ ^ : ? * [ \\, "..", "@{", or empty or dot-led parts' : '';
}

export const createBranchBody = (name: string, commit: string) => ({
  ref: name,
  commit,
  expected: null,
});

export const deleteBranchBody = (row: RefRow) => ({
  updates: [{ ref: `${HEADS}${row.name}`, commit: null, expected: row.commit }],
});

export const createTagBody = (name: string, commit: string, message: string) => ({
  name,
  commit,
  ...(message.trim() ? { message: message.trim() } : {}),
});
