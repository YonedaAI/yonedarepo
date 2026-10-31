// Adding a GitHub repository: what the field accepts, the request it makes, and what the
// import's answers mean on the repository's page.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImportStatus } from './ImportStatus';
import {
  defaultRepoName,
  importBody,
  importFailure,
  importView,
  MAX_IMPORT_COMMITS,
  mayBeImport,
  parseGitHubRepo,
} from './importModel';
import type { ImportProgress } from './useImportProgress';

const remote = 'https://github.com/rust-lang/mdBook.git';

describe('parseGitHubRepo', () => {
  it.each([
    'https://github.com/rust-lang/mdBook',
    'https://github.com/rust-lang/mdBook.git',
    'https://github.com/rust-lang/mdBook/',
    'https://github.com/rust-lang/mdBook.git/',
    '  https://github.com/rust-lang/mdBook\n',
    'HTTPS://GitHub.com/rust-lang/mdBook',
    'https://www.github.com/rust-lang/mdBook',
    'https://github.com/rust-lang/mdBook#readme',
    'https://github.com/rust-lang/mdBook?tab=readme-ov-file',
    'github.com/rust-lang/mdBook',
    'rust-lang/mdBook',
    'rust-lang/mdBook.git',
    'rust-lang/mdBook/',
  ])('reads %s', (input) => {
    expect(parseGitHubRepo(input)).toEqual({ owner: 'rust-lang', repo: 'mdBook', url: remote });
  });

  it('keeps the dots, dashes and underscores of a real repository name', () => {
    expect(parseGitHubRepo('vercel/next.js')?.repo).toBe('next.js');
    expect(parseGitHubRepo('a/.github')?.url).toBe('https://github.com/a/.github.git');
    expect(parseGitHubRepo('a/b_c-d')?.repo).toBe('b_c-d');
  });

  it.each([
    ['nothing', ''],
    ['one word', 'mdBook'],
    ['an owner page', 'https://github.com/rust-lang'],
    ['the site', 'https://github.com/'],
    ['a page inside a repository', 'https://github.com/a/b/tree/main'],
    ['too many parts', 'a/b/c'],
    ['another host', 'https://gitlab.com/a/b'],
    ['a host that only starts like GitHub', 'https://github.com.evil.example/a/b'],
    ['a host that only ends like GitHub', 'https://notgithub.com/a/b'],
    ['GitHub as a user name', 'https://github.com@evil.example/a/b'],
    ['a bare other host', 'evil.example/a'],
    ['a pasted token', 'https://x:ghp_secret@github.com/a/b'],
    ['a port', 'https://github.com:8443/a/b'],
    ['plain http', 'http://github.com/a/b'],
    ['an SSH remote', 'git@github.com:a/b.git'],
    ['an ssh URL', 'ssh://git@github.com/a/b.git'],
    ['a file URL', 'file:///a/b'],
    ['a parent path', 'a/..'],
    ['a name that is only .git', 'a/.git'],
    ['an encoded slash', 'https://github.com/a/b%2Fc'],
    ['spaces', 'a b/c'],
    ['an owner that starts with a dash', '-a/b'],
    ['an owner over 39 characters', `${'a'.repeat(40)}/b`],
    ['a name over 100 characters', `a/${'b'.repeat(101)}`],
  ])('refuses %s', (_what, input) => {
    expect(parseGitHubRepo(input)).toBeNull();
  });
});

describe('defaultRepoName', () => {
  it('is the GitHub name', () => {
    expect(defaultRepoName('mdBook')).toBe('mdBook');
    expect(defaultRepoName('next.js')).toBe('next.js');
  });
  it('drops the leading dots a repository name here cannot start with', () => {
    expect(defaultRepoName('.github')).toBe('github');
  });
});

describe('importBody', () => {
  it('always asks for the newest 5,000 commits and states the visibility', () => {
    expect(MAX_IMPORT_COMMITS).toBe(5000);
    expect(importBody(remote, 'mdbook', '', 'private')).toEqual({
      url: remote,
      name: 'mdbook',
      visibility: 'private',
      max_commits: 5000,
    });
  });
  it('is private unless told otherwise', () => {
    expect(importBody(remote, 'mdbook', '').visibility).toBe('private');
  });
  it('names an organization owner and a branch only when there is one', () => {
    expect(importBody(remote, 'mdbook', 'acme', 'public', ' next ')).toEqual({
      url: remote,
      name: 'mdbook',
      owner: 'acme',
      visibility: 'public',
      branch: 'next',
      max_commits: 5000,
    });
    expect(importBody(remote, 'mdbook', '', 'public', '   ')).not.toHaveProperty('branch');
  });
});

describe('importFailure', () => {
  it('says a private or missing remote plainly, and keeps the reason', () => {
    expect(importFailure('REMOTE_AUTH_REQUIRED: authentication required')).toEqual({
      title:
        "This repository is private, or it doesn't exist. Only public GitHub repositories can be added for now.",
      reason: 'authentication required',
    });
    expect(importFailure('NOT_FOUND: no such remote')).toEqual({
      title: "This repository or branch wasn't found.",
      reason: 'no such remote',
    });
  });
  it('shows any other reason as it came', () => {
    expect(importFailure('MEMORY_LIMIT: too large')).toEqual({
      title: "Couldn't import this repository.",
      reason: 'too large',
    });
    expect(importFailure('Branch main has no commits')).toEqual({
      title: "Couldn't import this repository.",
      reason: 'Branch main has no commits',
    });
  });
  it('still answers with no reason at all', () => {
    expect(importFailure(undefined)).toEqual({
      title: "Couldn't import this repository.",
      reason: '',
    });
  });
});

describe('importView', () => {
  it.each(['queued', 'running', 'waiting', 'paused', 'waitingForPause', 'rollingBack', 'unknown'])(
    'waits while the import is %s',
    (status) => {
      expect(importView({ status }).phase).toBe('running');
    },
  );
  it('treats an answer it has never seen as still running', () => {
    expect(importView({ status: 'something-new' }).phase).toBe('running');
    expect(importView({}).phase).toBe('running');
  });
  it('finishes on complete', () => {
    expect(importView({ status: 'complete' }).phase).toBe('complete');
  });
  it('carries the reason of a failed import', () => {
    expect(
      importView({
        status: 'errored',
        error: { name: 'NonRetryableError', message: 'NOT_FOUND: gone' },
      }),
    ).toEqual({
      phase: 'failed',
      title: "This repository or branch wasn't found.",
      reason: 'gone',
    });
  });
  it('fails a stopped import too', () => {
    expect(importView({ status: 'terminated' })).toEqual({
      phase: 'failed',
      title: 'This import was stopped.',
      reason: '',
    });
  });
});

describe('mayBeImport', () => {
  it('only asks about a repository with no branches or tags yet', () => {
    expect(mayBeImport(undefined)).toBe(false);
    expect(mayBeImport([])).toBe(true);
    expect(mayBeImport([{ name: 'refs/heads/main' }])).toBe(false);
  });
});

describe('ImportStatus', () => {
  const repo = 'r00000000000000000001';
  const shown = (progress: Exclude<ImportProgress, { phase: 'none' }>, owner = true) =>
    renderToStaticMarkup(
      createElement(ImportStatus, { repo, progress, owner, navigate: () => {} }),
    );
  const failed = { phase: 'failed', title: 'No luck.', reason: 'no such remote' } as const;

  it('says the import is running, for screen readers too', () => {
    const html = shown({ phase: 'running', stalled: false });
    expect(html).toContain('role="status"');
    expect(html).toContain('Importing this repository');
    expect(html).toContain('keeps running if you leave this page');
  });
  it('says so when it has lost track, without calling the import failed', () => {
    const html = shown({ phase: 'running', stalled: true });
    expect(html).toContain('Couldn&#x27;t check on the import');
    expect(html).not.toContain('role="alert"');
  });
  it('states a failure and its reason, and shows the owner the way to try again', () => {
    const html = shown(failed);
    expect(html).toContain('role="alert"');
    expect(html).toContain('No luck.');
    expect(html).toContain('Reason: no such remote');
    expect(html).toContain(`href="/source/${repo}/settings/delete"`);
  });
  it('offers deleting only to someone who may', () => {
    expect(shown(failed, false)).not.toContain('delete this repository');
  });
  it('leaves out a reason there is not, and never shows a raw platform error', () => {
    expect(shown({ ...failed, reason: '' })).not.toContain('Reason:');
    const html = shown({ ...failed, reason: 'D1_ERROR: internal error' });
    expect(html).not.toContain('D1_ERROR');
  });
});
