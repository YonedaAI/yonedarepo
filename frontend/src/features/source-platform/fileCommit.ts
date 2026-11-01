// The browser's commit: one file onto a working branch. `POST /commits` only records, so the
// branch then moves to the new commit (`POST /branches`), and that move is what opens a Landing
// and wakes the agents, exactly as a push does. `main` moves only by landing. A goal is filed
// first, as the branch's flight plan: Intent drift reads it when the move reaches it.
import { PROTECTED_BRANCH, refNameProblem } from '../repo-settings/refModel';
import { SourceApiError, sourceApi } from './sourceApi';

export type FileDraft = {
  path: string;
  content: string;
  message: string;
  branch: string;
  /** The flight plan's goal; empty files none. */
  goal: string;
};

/** Where the page stands: the branch on screen and the head it showed. */
export type CommitPlace = { from: string; head: string | null; account?: string };

export type Committed = { branch: string; commit: string; change: number | null };

/** The name on a commit made here. An email-named account's name would be published by Git. */
export function authorOf(account: string | undefined) {
  const named = account && !account.includes('@');
  return { name: named ? account : 'YonedaRepo user', email: 'commits@yonedarepo.invalid' };
}

function contentB64(text: string) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const badPath = (path: string) =>
  !path.trim() ||
  path.startsWith('/') ||
  path.endsWith('/') ||
  path.split('/').some((part) => !part || part === '.' || part === '..');

/** What stops this draft, in a sentence; empty when it can go. */
export function draftProblem(draft: FileDraft): string {
  if (badPath(draft.path)) return 'Name the file, like src/app.ts.';
  if (!draft.message.trim()) return 'Add a commit message.';
  if (draft.branch === PROTECTED_BRANCH) return 'Main moves only by landing. Name a new branch.';
  return refNameProblem(draft.branch);
}

export async function commitFile(
  repo: string,
  draft: FileDraft,
  place: CommitPlace,
): Promise<Committed> {
  const base = `/repos/${repo}`;
  const goal = draft.goal.trim();
  if (goal) await sourceApi(`${base}/flight-plans`, { body: { goal, branch: draft.branch } });
  const { commit } = await sourceApi<{ commit: string }>(`${base}/commits`, {
    body: {
      ref: place.from,
      message: draft.message.trim(),
      author: authorOf(place.account),
      changes: [{ path: draft.path, content_b64: contentB64(draft.content) }],
    },
  });
  const moved = await sourceApi<{ change: number | null }>(`${base}/branches`, {
    body: {
      ref: draft.branch,
      commit,
      expected: draft.branch === place.from ? place.head : null,
    },
  });
  return { branch: draft.branch, commit, change: moved.change ?? null };
}

/** What a refused commit says to people. */
export function commitFileFailure(e: unknown, place: CommitPlace, branch: string) {
  if (!(e instanceof SourceApiError && e.code === 'STALE_HEAD')) return (e as Error).message;
  return branch === place.from
    ? `${branch} moved since this page loaded. Reload to see it, then try again.`
    : `${branch} already exists. Open it first, or name a new branch.`;
}

/** A branch name for a commit made from `main`, from the file it writes. */
export function branchFor(path: string) {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `edit-${slug || 'file'}`;
}
