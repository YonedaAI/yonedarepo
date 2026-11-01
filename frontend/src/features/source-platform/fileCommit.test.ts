// The browser's commit, as requests: a file recorded from the page's branch, then the branch
// moved to it, which is what opens a Landing and wakes the agents; a goal is filed before either.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorOf, branchFor, commitFile, commitFileFailure, draftProblem } from './fileCommit';
import { SourceApiError } from './sourceApi';

const REPO = 'r0123456789abcdef0123';
const HEAD = 'a'.repeat(40);
const MADE = 'b'.repeat(40);
const draft = {
  path: 'src/café.ts',
  content: 'export const ü = "✓";\n',
  message: 'Add the café',
  branch: 'edit-cafe',
  goal: '',
};
const place = { from: 'main', head: HEAD, account: 'ada' };

type Call = { path: string; method: string; body: any };

function serve(answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = String(url).replace(/^.*\/repos\/r[0-9a-f]+/, '');
      calls.push({ path, method: String(init.method), body: JSON.parse(String(init.body)) });
      const answer =
        answers[path] ??
        (path === '/commits'
          ? { commit: MADE }
          : path === '/branches'
            ? { ref: 'refs/heads/edit-cafe', commit: MADE, version: 7, change: 12 }
            : { plan: { id: 1 } });
      return Response.json(answer);
    }),
  );
  return calls;
}

const decoded = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

afterEach(() => vi.unstubAllGlobals());

describe('commitFile', () => {
  it('records the file from the page branch, then moves a new branch to it', async () => {
    const calls = serve();
    const done = await commitFile(REPO, draft, place);
    expect(calls.map((c) => c.path)).toEqual(['/commits', '/branches']);
    const [commit, branch] = calls;
    expect(commit.body.ref).toBe('main');
    expect(commit.body.message).toBe('Add the café');
    expect(commit.body.author).toEqual({ name: 'ada', email: 'commits@yonedarepo.invalid' });
    expect(commit.body.changes).toHaveLength(1);
    expect(commit.body.changes[0].path).toBe('src/café.ts');
    expect(decoded(commit.body.changes[0].content_b64)).toBe(draft.content);
    expect(branch.body).toEqual({ ref: 'edit-cafe', commit: MADE, expected: null });
    expect(done).toEqual({ branch: 'edit-cafe', commit: MADE, change: 12 });
  });

  it('moves the branch on the page from the head the page showed', async () => {
    const calls = serve();
    await commitFile(REPO, { ...draft, branch: 'work' }, { ...place, from: 'work' });
    expect(calls[0].body.ref).toBe('work');
    expect(calls[1].body).toEqual({ ref: 'work', commit: MADE, expected: HEAD });
  });

  it('files the goal for the branch before the commit, so the push finds it', async () => {
    const calls = serve();
    await commitFile(REPO, { ...draft, goal: '  Serve coffee  ' }, place);
    expect(calls.map((c) => c.path)).toEqual(['/flight-plans', '/commits', '/branches']);
    expect(calls[0].body).toEqual({ goal: 'Serve coffee', branch: 'edit-cafe' });
  });

  it('answers no Landing when the push opened none', async () => {
    serve({ '/branches': { ref: 'refs/heads/edit-cafe', commit: MADE, version: 7, change: null } });
    expect((await commitFile(REPO, draft, place)).change).toBeNull();
  });
});

describe('draftProblem', () => {
  it('passes a whole draft', () => {
    expect(draftProblem(draft)).toBe('');
  });
  it('asks for a path, a message and a branch that can move', () => {
    expect(draftProblem({ ...draft, path: ' ' })).toMatch(/file/i);
    expect(draftProblem({ ...draft, path: '/etc/passwd' })).toMatch(/file/i);
    expect(draftProblem({ ...draft, path: 'a/../b' })).toMatch(/file/i);
    expect(draftProblem({ ...draft, message: '\n' })).toMatch(/message/i);
    expect(draftProblem({ ...draft, branch: 'main' })).toMatch(/main/i);
    expect(draftProblem({ ...draft, branch: 'a b' })).not.toBe('');
  });
});

describe('commitFileFailure', () => {
  const stale = new SourceApiError('STALE_HEAD', 'refs/heads/x is at 1, not 2', 409);
  it('says what happened to the branch in plain words', () => {
    expect(commitFileFailure(stale, { ...place, from: 'edit-cafe' }, 'edit-cafe')).toMatch(
      /moved/i,
    );
    expect(commitFileFailure(stale, place, 'edit-cafe')).toMatch(/already exists/i);
  });
  it('keeps any other failure as the server worded it', () => {
    expect(commitFileFailure(new Error('Nope'), place, 'x')).toBe('Nope');
  });
});

describe('authorOf', () => {
  it('never puts an email-named account in a commit', () => {
    expect(authorOf('ada').name).toBe('ada');
    expect(authorOf('ada@example.com').name).not.toContain('@');
    expect(authorOf(undefined).name).toBeTruthy();
  });
});

describe('branchFor', () => {
  it('names a branch after the file', () => {
    expect(branchFor('src/Net/retry.ts')).toBe('edit-src-net-retry-ts');
    expect(branchFor('')).toBe('edit-file');
  });
});
