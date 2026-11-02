import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RepoFacts } from './RepoFacts';
import type { RepoStatus } from './repoStatus';

const facts = (status: Partial<RepoStatus>, canFork = false) =>
  renderToStaticMarkup(
    createElement(RepoFacts, {
      repo: 'r0',
      status: {
        name: 'app',
        version: 3,
        policy: { approvals: 1, required_checks: [] },
        ...status,
      } as RepoStatus,
      owner: false,
      readOnly: true,
      canFork,
      navigate: () => {},
    }),
  );

describe('RepoFacts', () => {
  it('says what a repository is in one row, and offers Fork only to who can fork', () => {
    expect(facts({})).toContain('main @ v3');
    expect(facts({})).not.toContain('Public');
    expect(facts({})).not.toContain('Fork');
    expect(facts({ visibility: 'public' })).toContain('Public');
    expect(facts({}, true)).toContain('Fork');
  });

  it('links a fork to its parent', () => {
    const fork = facts({ parent: { repo: 'r1', version: 2 } } as Partial<RepoStatus>);
    expect(fork).toContain('Forked from');
    expect(fork).toContain('>r1</a>');
    expect(fork).toContain('at v2');
  });
});
