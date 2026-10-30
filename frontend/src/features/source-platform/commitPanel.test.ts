import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CommitDetail, Gates } from './CommitGates';
import { GateSummary } from './CommitGates';
import { CommitLanding } from './CommitLanding';
import { classLabel, commitPanel, isAuthor, OWN_COMMIT, revertBranch } from './commitPanel';
import type { Viewer } from './RepoMembers';
import type { RepoStatus } from './repoStatus';

const gates = (over: Partial<Gates> = {}): Gates => ({
  ready: true,
  approvals: 0,
  approvals_required: 0,
  rejected: false,
  missing_checks: [],
  failing_checks: [],
  ...over,
});
const owner: Viewer = { owner: true, role: null };
const lander: Viewer = { owner: false, role: 'land' };
const writer: Viewer = { owner: false, role: 'write' };
const reader: Viewer = { owner: false, role: 'read' };
const noChecks: RepoStatus['policy'] = { required_checks: [], approvals: 0 };
const withChecks: RepoStatus['policy'] = { required_checks: ['test'], approvals: 0 };
const landed = [{ refname: 'refs/heads/main', version: 2, landed_at: 1_700_000_000_000 }];

const detail = (over: Partial<CommitDetail> = {}): CommitDetail => ({
  commit: 'a'.repeat(40),
  message: 'Docs',
  principal: 'kit',
  parents: [],
  read_set: [],
  checks: [],
  check_runs: [],
  reviews: [],
  landings: [],
  repairs: [],
  review_classes: { overall: 'unknown', files: [] },
  break_glass: [],
  gates: gates(),
  ...over,
});
const status = (viewer: Viewer, policy = noChecks): RepoStatus => ({
  name: 'demo',
  version: 2,
  owner: 'kit',
  owner_handle: 'kit',
  path: '/kit/demo',
  object_store: 'r2',
  policy,
  policy_digest: 'd'.repeat(64),
  viewer: { principal: 'user:kit', public: false, ...viewer },
  refs: [
    { name: 'refs/heads/main', commit_id: 'b'.repeat(40), version: 2 },
    { name: 'refs/heads/dev', commit_id: 'c'.repeat(40), version: 1 },
  ],
  projections: [],
  objects: {},
  bundled: false,
  automation: null,
  parent: null,
  forks: 0,
  grant: null,
  quarantined: [],
  quarantine_epoch: 0,
  visibility: 'private',
});
const page = (d: CommitDetail, s: RepoStatus) =>
  renderToStaticMarkup(
    createElement(CommitLanding, {
      repo: 'r0123456789abcdef0123',
      detail: d,
      status: s,
      onNavigate: () => {},
      onReload: () => {},
    }),
  );

describe('a landed commit', () => {
  it('reports where it landed and offers only Revert (and Run checks when configured)', () => {
    expect(commitPanel({ landings: landed, gates: gates() }, writer, noChecks)).toEqual({
      state: 'landed',
      landings: landed,
      revert: true,
      runChecks: false,
    });
    expect(commitPanel({ landings: landed, gates: gates() }, writer, withChecks)).toMatchObject({
      runChecks: true,
    });
    expect(commitPanel({ landings: landed, gates: gates() }, reader, withChecks)).toMatchObject({
      revert: false,
      runChecks: false,
    });
    expect(revertBranch(landed)).toBe('main');
  });

  it('shows one landed line and none of the landing controls', () => {
    const html = page(detail({ landings: landed }), status(owner));
    expect(html).toContain('Landed on main at v2 · ');
    expect(html).toContain('>Revert<');
    for (const gone of [
      'Ready to land',
      'Review class',
      'Approvals',
      'Approve',
      'Reject',
      'Land on',
      'Break glass',
      'More',
      'Run checks',
      '<select',
    ])
      expect(html).not.toContain(gone);
  });
});

describe('a commit not yet landed', () => {
  it('lets a lander land a ready commit on a picked branch, without review or break glass', () => {
    const panel = commitPanel({ landings: [], gates: gates() }, lander, noChecks);
    expect(panel).toMatchObject({
      state: 'pending',
      ready: true,
      needs: [],
      review: false,
      land: true,
      breakGlass: false,
    });
    const html = page(detail(), status(lander));
    expect(html).toContain('Ready to land');
    expect(html).toContain('Land on main');
    expect(html).toMatch(/<select[^>]*><option[^>]*>main<\/option><option[^>]*>dev<\/option>/);
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('Approvals');
    expect(html).not.toContain('More');
  });

  it('says what a blocked commit needs and gives an owner review and break glass under More', () => {
    const blocked = gates({ ready: false, approvals_required: 1, missing_checks: ['test'] });
    const panel = commitPanel({ landings: [], gates: blocked }, owner, withChecks);
    expect(panel).toMatchObject({
      ready: false,
      needs: ['1 more approval (0 of 1).', 'Waiting for checks: test.'],
      review: true,
      land: false,
      runChecks: true,
      breakGlass: true,
    });
    const html = page(detail({ gates: blocked }), status(owner, withChecks));
    expect(html).toContain('Not ready to land');
    expect(html).toContain('1 more approval (0 of 1).');
    expect(html).toContain('Approve');
    expect(html).toContain('<summary>More</summary>');
    expect(html).toContain('Break glass');
    expect(html).not.toContain('Land on');
    expect(html).not.toContain('<select');
  });

  it('offers a writer nothing but the plain needs (and Run checks when configured)', () => {
    const blocked = gates({ ready: false, approvals_required: 2, approvals: 1 });
    expect(commitPanel({ landings: [], gates: blocked }, writer, noChecks)).toMatchObject({
      needs: ['1 more approval (1 of 2).'],
      review: false,
      land: false,
      runChecks: false,
      breakGlass: false,
    });
    const html = page(detail({ gates: blocked }), status(writer));
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('source-actions');
  });

  it('skips review when the policy auto-approved the commit', () => {
    const auto = gates({ approvals_required: 1, auto_approved: true });
    expect(commitPanel({ landings: [], gates: auto }, owner, noChecks)).toMatchObject({
      needs: [],
      review: false,
      land: true,
    });
  });
});

describe("the viewer's own commit", () => {
  const blocked = gates({ ready: false, approvals_required: 1 });
  it("is never offered for its author's approval, and says why", () => {
    expect(isAuthor('user:kit', 'kit')).toBe(true);
    expect(isAuthor('user:kit', 'other')).toBe(false);
    expect(isAuthor('user:kit', undefined)).toBe(false);
    expect(isAuthor('token:kit', 'kit')).toBe(false);
    const own = commitPanel(
      { landings: [], gates: blocked, principal: 'user:kit' },
      owner,
      noChecks,
      'kit',
    );
    expect(own).toMatchObject({
      review: false,
      notes: [OWN_COMMIT],
      needs: ['1 more approval (0 of 1).', OWN_COMMIT],
    });
    const html = renderToStaticMarkup(
      createElement(CommitLanding, {
        repo: 'r0123456789abcdef0123',
        detail: detail({ gates: blocked, principal: 'user:kit' }),
        status: status(owner),
        username: 'kit',
        onNavigate: () => {},
        onReload: () => {},
      }),
    );
    expect(html).toContain('<li>You can&#x27;t approve your own commit.</li>');
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('Reject');
  });
  it('is offered to another reviewer, with no note', () => {
    const theirs = commitPanel(
      { landings: [], gates: blocked, principal: 'user:kit' },
      lander,
      noChecks,
      'ada',
    );
    expect(theirs).toMatchObject({ review: true, notes: [] });
  });
  it('needs no note when nothing asks for approval or the viewer cannot review', () => {
    const none = commitPanel(
      { landings: [], gates: gates(), principal: 'user:kit' },
      owner,
      noChecks,
      'kit',
    );
    expect(none).toMatchObject({ review: false, notes: [] });
    const writes = commitPanel(
      { landings: [], gates: blocked, principal: 'user:kit' },
      writer,
      noChecks,
      'kit',
    );
    expect(writes).toMatchObject({ review: false, notes: [] });
  });
});

describe('the gate summary', () => {
  it('names a known review class plainly and hides an unknown one', () => {
    expect(classLabel({ overall: 'docs', files: [] })).toBe('Docs-only change');
    expect(classLabel({ overall: 'unknown', files: [] })).toBeNull();
    expect(classLabel(null)).toBeNull();
    const docs = renderToStaticMarkup(
      createElement(GateSummary, { gates: gates(), classes: { overall: 'docs', files: [] } }),
    );
    expect(docs).toContain('Docs-only change');
    const unknown = renderToStaticMarkup(
      createElement(GateSummary, { gates: gates(), classes: { overall: 'unknown', files: [] } }),
    );
    expect(unknown).toBe('<h3>Ready to land</h3>');
  });

  it('shows approvals only when the policy requires them', () => {
    const met = renderToStaticMarkup(
      createElement(GateSummary, {
        gates: gates({ approvals: 1, approvals_required: 1 }),
        classes: null,
      }),
    );
    expect(met).toContain('Approved (1 of 1)');
    const rejected = renderToStaticMarkup(
      createElement(GateSummary, { gates: gates({ ready: false, rejected: true }), classes: null }),
    );
    expect(rejected).toContain('A reviewer rejected it');
  });
});
