// Change requests as the server would render them: the list and its filter, the change page
// in each status, line threads on the diff, the sessions behind its commits, and the pure
// rules for anchors and threads.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loaded } from './useSource';

const state: { value: Loaded<any>; paths: (string | null)[] } = {
  value: { loading: true, reload: () => {} },
  paths: [],
};
vi.mock('./useSource', () => ({
  useSource: (path: string | null) => {
    state.paths.push(path);
    return state.value;
  },
}));

const { ChangeTable, StatusFilter } = await import('./RepoChanges');
const { ChangeView } = await import('./ChangeView');
const { ChangeSessions } = await import('./ChangeSessions');
const { OpenChangeButton, baseChoices, proposable } = await import('./OpenChange');
const { DiffFiles } = await import('./DiffFiles');
const { anchorKey, conversation, diffAnchors, groupComments, rowAnchor } = await import(
  './changeModel'
);

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const loaded = (value: Partial<Loaded<any>>): Loaded<any> => ({
  loading: false,
  reload: () => {},
  ...value,
});
const repo = 'r0123456789abcdef0123';
const head = 'a'.repeat(40);
const older = 'b'.repeat(40);
const patch = '@@ -1,2 +1,2 @@\n keep\n-old line\n+new line\n';
const change = {
  number: 7,
  title: 'Retry flaky fetch',
  body: 'Adds a retry.',
  branch: 'fix-retry',
  base: 'main',
  author: 'user:ada',
  status: 'open',
  head,
  created_at: 1,
  updated_at: 2,
  landed_version: null,
  landed_commit: null,
  comment_count: 0,
};
const gates = (ready: boolean) => ({
  ready,
  approvals: ready ? 1 : 0,
  approvals_required: 1,
  rejected: false,
  missing_checks: ready ? [] : ['test'],
  failing_checks: [],
});
const comment = (over: object) => ({
  id: 1,
  commit: head,
  path: null,
  line: null,
  side: null,
  body: 'Looks good',
  principal: 'user:bob',
  at: 5,
  resolved_at: null,
  ...over,
});
const detail = (over: object = {}, ready = false) => ({
  ...change,
  head_commit: {
    commit: head,
    reviews: [],
    review_classes: null,
    gates: gates(ready),
  },
  comments: [],
  timeline: [{ version: 3, action: 'moved', before: older, after: head, actor: 'user:ada', at: 4 }],
  diff: {
    base: { commit: older, tree: 't' },
    head: { commit: head, tree: 't' },
    changes: [{ path: 'src/a.ts', op: 'modify', patch }],
  },
  ...over,
});
const view = () => html(ChangeView, { repo, number: 7 });

beforeEach(() => {
  state.value = { loading: true, reload: () => {} };
  state.paths = [];
});

describe('change rules', () => {
  it('anchors deleted lines on the base file and the rest on the head file', () => {
    expect(rowAnchor({ kind: 'delete', text: 'x', old: 4 })).toEqual({ line: 4, side: 'old' });
    expect(rowAnchor({ kind: 'add', text: 'x', new: 9 })).toEqual({ line: 9, side: 'new' });
    expect(rowAnchor({ kind: 'context', text: 'x', old: 3, new: 5 })).toEqual({
      line: 5,
      side: 'new',
    });
    expect([...diffAnchors([{ path: 'a', op: 'modify', patch }])]).toEqual([
      'new:1:a',
      'old:2:a',
      'new:2:a',
    ]);
  });

  it('splits general comments, current line threads and outdated threads', () => {
    const shown = new Set([anchorKey({ path: 'a', line: 2, side: 'new' })]);
    const { general, inline, outdated } = groupComments(
      [
        comment({ id: 1 }),
        comment({ id: 2, path: 'a', line: 2, side: 'new', resolved_at: 9 }),
        comment({ id: 3, path: 'a', line: 2, side: 'new' }),
        comment({ id: 4, path: 'a', line: 2, side: 'new', commit: older }),
        comment({ id: 5, path: 'a', line: 40, side: 'new' }),
      ] as any,
      head,
      shown,
    );
    expect(general.map((c) => c.id)).toEqual([1]);
    const thread = inline.get('new:2:a');
    expect(thread?.comments.map((c) => c.id)).toEqual([2, 3]);
    expect(thread?.resolved).toBe(false);
    expect(outdated.map((t) => t.comments[0].id)).toEqual([4, 5]);
  });

  it('orders the conversation oldest first across comments and pushes', () => {
    const items = conversation([comment({ at: 5 })] as any, [
      { version: 4, action: 'moved', before: null, after: head, actor: 'a', at: 8 },
      { version: 2, action: 'created', before: null, after: older, actor: 'a', at: 1 },
    ]);
    expect(items.map((i) => i.at)).toEqual([1, 5, 8]);
  });

  it('only proposes ordinary branches', () => {
    expect(proposable('refs/heads/fix-retry')).toBe('fix-retry');
    expect(proposable('main')).toBeNull();
    expect(proposable('refs/heads/release/1')).toBeNull();
    expect(proposable(head)).toBeNull();
    expect(html(OpenChangeButton, { repo, branch: 'main', onOpened: () => {} })).toBe('');
    expect(html(OpenChangeButton, { repo, branch: 'fix', onOpened: () => {} })).toContain(
      'Open change',
    );
  });

  it('offers every other branch as the base, main first', () => {
    const refs = {
      'refs/heads/main': head,
      'refs/heads/fix': head,
      'refs/heads/b': head,
      'refs/tags/v1': head,
    };
    expect(baseChoices(refs, 'fix')).toEqual(['main', 'b']);
    expect(baseChoices(undefined, 'fix')).toEqual(['main']);
  });
});

describe('changes list', () => {
  const props = { filter: 'open', hrefOf: (n: number) => `/c/${n}`, onOpen: () => {} };
  it('shows loading, failure, empty and populated states', () => {
    expect(html(ChangeTable, { ...props, changes: loaded({ loading: true }) })).toContain(
      'Loading changes',
    );
    expect(html(ChangeTable, { ...props, changes: loaded({ error: 'boom' }) })).toContain('Retry');
    const empty = loaded({ data: { changes: [] } });
    expect(html(ChangeTable, { ...props, changes: empty })).toContain('No open changes');
    expect(html(ChangeTable, { ...props, filter: 'closed', changes: empty })).toContain(
      'No closed changes',
    );
    const landed = { ...change, number: 6, status: 'landed', landed_version: 41, comment_count: 2 };
    const list = html(ChangeTable, {
      ...props,
      filter: 'all',
      changes: loaded({ data: { changes: [change, landed] } }),
    });
    expect(list).toContain('href="/c/7"');
    expect(list).toContain('Retry flaky fetch');
    expect(list).toContain('source-change-landed');
    expect(list).toContain('landed v41');
    expect(list).toContain('2 comments');
    expect(list).toContain('ada');
    expect(list).not.toContain('user:ada');
  });

  it('marks the selected status filter as pressed', () => {
    const filter = html(StatusFilter, { value: 'landed', onChange: () => {} });
    expect(filter).toContain('<legend class="sr-only">Status</legend>');
    expect(filter).toContain('aria-pressed="true">Landed');
    expect(filter.match(/aria-pressed="false"/g)).toHaveLength(3);
  });
});

describe('change page', () => {
  it('shows loading and failure', () => {
    expect(view()).toContain('Loading change #7');
    state.value = loaded({ error: 'Change 7 not found' });
    expect(view()).toContain('Change 7 not found');
  });

  it('offers review and land on an open change, land only once the gates pass', () => {
    state.value = loaded({ data: detail() });
    const blocked = view();
    expect(blocked).toContain('Not ready to land');
    expect(blocked).toContain('Waiting for checks: test');
    expect(blocked).toContain('>Approve<');
    expect(blocked).toMatch(/<button type="button" disabled="">Land on main/);
    expect(blocked).toContain('Close change');
    expect(blocked).toContain('ada pushed');
    expect(blocked).toContain('Files changed (1)');
    expect(blocked).toContain('aria-label="Comment on src/a.ts line 2 (base)"');
    state.value = loaded({ data: detail({}, true) });
    expect(view()).toMatch(/<button type="button">Land on main/);
  });

  it('lands on its own base, ungated when the base is not protected', () => {
    state.value = loaded({ data: detail({ base: 'stage', base_protected: false }) });
    const page = view();
    expect(page).toContain('landing <code>fix-retry</code> on <code>stage</code>');
    expect(page).toMatch(/<button type="button">Land on stage/);
    state.value = loaded({ data: detail({ base: 'release/1', base_protected: true }) });
    expect(view()).toMatch(/<button type="button" disabled="">Land on release\/1/);
  });

  it('puts line threads under their line and lists outdated ones apart', () => {
    const comments = [
      comment({ id: 1 }),
      comment({ id: 2, path: 'src/a.ts', line: 2, side: 'new', body: 'Name this' }),
      comment({ id: 3, path: 'src/a.ts', line: 2, side: 'new', commit: older, body: 'Stale' }),
    ];
    state.value = loaded({ data: detail({ comments }) });
    const page = view();
    expect(page).toContain('source-thread-row');
    expect(page).toContain('aria-label="Thread on src/a.ts:2 (head)"');
    expect(page.indexOf('Name this')).toBeGreaterThan(page.indexOf('new line'));
    expect(page).toContain('Outdated line threads');
    expect(page).toContain('(outdated)');
    expect(page).toContain('2 line threads, 1 outdated');
    expect(page).toContain('>Resolve<');
  });

  it('shows a landed change without review, land or line comment controls', () => {
    const landed = { status: 'landed', landed_version: 41, landed_commit: head };
    state.value = loaded({ data: detail(landed, true) });
    const page = view();
    expect(page).toContain('Landed on main');
    expect(page).toContain('at v41');
    expect(page).not.toContain('>Approve<');
    expect(page).not.toContain('Land on main<');
    expect(page).not.toContain('source-line-comment');
    expect(page).toContain('Comment on this change');
  });

  it('offers delete on a closed change only: an open one is closed first, a landed one stays', () => {
    for (const [status, offered] of [
      ['closed', true],
      ['open', false],
      ['landed', false],
    ] as const) {
      state.value = loaded({ data: detail({ status }) });
      expect(view().includes('Delete change'), status).toBe(offered);
    }
  });

  it('offers reopen on a closed change and explains a deleted branch', () => {
    state.value = loaded({ data: detail({ status: 'closed' }) });
    expect(view()).toContain('Reopen change');
    state.value = loaded({
      data: detail({ status: 'closed', head: null, head_commit: null, diff: null }),
    });
    const gone = view();
    expect(gone).toContain('no longer exists');
    expect(gone).toContain('No diff: the change has no head commit');
  });
});

describe('diff files', () => {
  it('renders plain line numbers without hooks', () => {
    const plain = html(DiffFiles, { changes: [{ path: 'a', op: 'modify', patch }] });
    expect(plain).not.toContain('source-line-comment');
    expect(plain).toContain('new line');
    expect(html(DiffFiles, { changes: [] })).toContain('No file changes');
  });
});

describe('a change from a fork', () => {
  it('names the fork branch it follows and why the latest pushes are missing', () => {
    const fork = 'r00000000000000000f01';
    state.value = loaded({
      data: detail({
        branch: `forks/${fork}/feature`,
        source_repo: fork,
        source_branch: 'feature',
        source_error: 'TOO_LARGE: too many commits',
      }),
    });
    const page = view();
    expect(page).toContain(`href="/source/${fork}/history?ref=feature"`);
    expect(page).toContain(`${fork}:feature`);
    expect(page).toContain('TOO_LARGE: too many commits');
    state.value = loaded({ data: detail() });
    expect(view()).not.toContain('from fork');
  });
});

describe('sessions behind a change', () => {
  const session = (id: number, commit: string, subject: string) => ({
    id,
    commit,
    cli: 'claude-code',
    model: 'claude-sonnet-5-5',
    summary: `summary ${id}`,
    prompt_digest: null,
    transcript_ref: null,
    read_set_digest: null,
    session_id: null,
    recorded_by: 'token:agent',
    at: id,
    subject,
    reads: 0,
  });
  const list = (sessions: object[], over: object = {}) => ({
    sessions,
    next: null,
    clis: [],
    models: [],
    ref: null,
    branch_scan_truncated: false,
    ...over,
  });
  const sessions = (props: object = {}) =>
    html(ChangeSessions, { repo, head, base: older, navigate: () => {}, ...props });

  it('reads what the head adds over the merge base and groups it by commit', () => {
    state.value = loaded({
      data: list([session(3, head, 'second'), session(2, older, 'first'), session(1, head, 'x')]),
    });
    const page = sessions();
    expect(state.paths).toContain(`/repos/${repo}/sessions?head=${head}&limit=200&base=${older}`);
    expect(page.indexOf('second')).toBeLessThan(page.indexOf('first'));
    expect(page.match(/<h4>/g)).toHaveLength(2);
    expect(page).toContain('summary 1');
    expect(page).toContain(`/source/${repo}/agents/sessions/3`);
    expect(page).not.toContain('newest sessions only');
  });

  it('shows loading, failure, empty and cut-off states', () => {
    expect(sessions()).toContain('Loading sessions');
    state.value = loaded({ error: 'boom' });
    expect(sessions()).toContain('Sessions unavailable: boom');
    state.value = loaded({ data: list([]) });
    expect(sessions()).toContain('No session recorded for this change');
    state.value = loaded({ data: list([session(1, head, 'x')], { next: 1 }) });
    expect(sessions()).toContain('newest sessions only');
    state.value = loaded({ data: list([]) });
    sessions({ base: null });
    expect(state.paths.at(-1)).toBe(`/repos/${repo}/sessions?head=${head}&limit=200`);
  });

  it('is on the change page for every commit, not just the head', () => {
    state.value = loaded({ data: detail() });
    const page = html(ChangeView, { repo, number: 7, navigate: () => {} });
    expect(page).toContain('Sessions behind this change');
    expect(state.paths).toContain(`/repos/${repo}/sessions?head=${head}&limit=200&base=${older}`);
  });
});
