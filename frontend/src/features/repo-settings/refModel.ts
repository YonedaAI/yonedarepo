// Branches and tags as the refs answer lists them, and the requests that create a branch
// (`POST /branches`, compare-and-swap on "no branch yet"), delete one (`POST /refs/batch`
// with a null commit, on its current value) and create a tag (`POST /tags`). `main` moves
// only by landing and is never deleted; tags are immutable. The server decides each one.
// A refs read may lag a change by up to READ_LAG_MS (the platform's cached snapshot), so the
// view shows the change's own answer until a read at least as new as it arrives.

export type RefRow = { name: string; commit: string };

const HEADS = 'refs/heads/';
const TAGS = 'refs/tags/';
export const PROTECTED_BRANCH = 'main';
/** How long a refs read may trail a change (the platform's `REFS_MS`/`ACCESS_MS`). */
export const READ_LAG_MS = 1000;

/** The refs answer: every ref's commit, as of `version`. */
export type RefsAnswer = { refs: Record<string, string>; version?: number };
/** A ref this viewer changed: its commit afterwards (null: deleted), as of `version`. */
export type RefEdit = { ref: string; commit: string | null; version: number };

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

/** The edit a create answered (`{ref, commit, version}`), or null for a no-op (`already`). */
export function createdEdit(answer: Record<string, unknown>) {
  const { ref, commit, version } = answer;
  return typeof ref === 'string' && typeof commit === 'string' && typeof version === 'number'
    ? { ref, commit, version }
    : null;
}

/** The edit a branch delete answered (`{version}`). */
export function deletedEdit(row: RefRow, answer: Record<string, unknown>): RefEdit | null {
  return typeof answer.version === 'number'
    ? { ref: `${HEADS}${row.name}`, commit: null, version: answer.version }
    : null;
}

/** The edits `loaded` predates: a read older than an edit has not seen it yet. */
export const pendingEdits = (loaded: RefsAnswer | undefined, edits: RefEdit[]) =>
  edits.filter((e) => (loaded?.version ?? -1) < e.version);

/** The refs to show: `loaded` with the viewer's own edits it has not seen yet, in order. */
export function withEdits(loaded: RefsAnswer | undefined, edits: RefEdit[]) {
  if (!loaded) return undefined;
  const refs = { ...loaded.refs };
  for (const e of pendingEdits(loaded, edits).sort((a, b) => a.version - b.version)) {
    if (e.commit === null) delete refs[e.ref];
    else refs[e.ref] = e.commit;
  }
  return { ...loaded, refs };
}
