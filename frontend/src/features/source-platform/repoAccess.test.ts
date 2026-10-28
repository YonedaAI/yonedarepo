// Who gets which controls on a repository page: members by role, and a public reader (signed
// out, or signed in without membership) only the read views.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Composer } from './ChangeThread';
import { RepoNotFound } from './RepoNotFound';
import { isPublic, ReadOnlyContext, repoAccess } from './repoAccess';
import { canMoveBranches } from './repoStatus';

const owner = { owner: true, role: null, principal: 'user:ada' };
const admin = { owner: true, role: 'admin' as const, principal: 'user:bob' };
const writer = { owner: false, role: 'write' as const, principal: 'user:cy' };
const anonymous = { owner: false, role: null, principal: 'anonymous', public: true };
const outsider = { owner: false, role: null, principal: 'user:dee', public: true };

describe('repository access', () => {
  it('gives the owner everything, and visibility only to the owner itself', () => {
    expect(repoAccess(owner, true)).toEqual({
      readOnly: false,
      settings: true,
      visibility: true,
      fork: true,
    });
    expect(repoAccess(admin, true)).toMatchObject({ settings: true, visibility: false });
    expect(repoAccess(writer, true)).toMatchObject({ readOnly: false, settings: false });
  });

  it('keeps a signed-out reader to the read views, without fork', () => {
    expect(repoAccess(anonymous, false)).toEqual({
      readOnly: true,
      settings: false,
      visibility: false,
      fork: false,
    });
  });

  it('lets a signed-in non-member of a public repository read and fork, nothing else', () => {
    expect(repoAccess(outsider, true)).toEqual({
      readOnly: true,
      settings: false,
      visibility: false,
      fork: true,
    });
    // Even a status that claims ownership changes nothing once it says the read is public.
    expect(repoAccess({ ...owner, public: true }, true)).toMatchObject({
      readOnly: true,
      settings: false,
      visibility: false,
    });
  });

  it('offers nothing beyond reading until the status says who is asking', () => {
    expect(repoAccess(undefined, true)).toEqual({
      readOnly: true,
      settings: false,
      visibility: false,
      fork: false,
    });
    // A signed-out session never manages, whatever a stale status said.
    expect(repoAccess(owner, false)).toMatchObject({ readOnly: true, settings: false });
  });

  it('never lets a public reader move branches', () => {
    expect(canMoveBranches(writer)).toBe(true);
    expect(canMoveBranches({ ...writer, public: true })).toBe(false);
    expect(canMoveBranches(outsider)).toBe(false);
  });

  it('treats a status without visibility as private', () => {
    expect(isPublic('public')).toBe(true);
    expect(isPublic('private')).toBe(false);
    expect(isPublic(undefined)).toBe(false);
  });
});

describe('read-only views', () => {
  const composer = (readOnly: boolean) =>
    renderToStaticMarkup(
      createElement(
        ReadOnlyContext.Provider,
        { value: readOnly },
        createElement(Composer, {
          label: 'Comment on this change',
          submit: async () => {},
          onDone: () => {},
        }),
      ),
    );

  it('drops the comment composer for a public reader', () => {
    expect(composer(false)).toContain('Comment on this change');
    expect(composer(true)).toBe('');
  });

  it('says a missing repository may be private, and offers sign-in only when signed out', () => {
    const page = (authenticated: boolean) =>
      renderToStaticMarkup(
        createElement(RepoNotFound, { authenticated, onSignIn: () => {}, navigate: () => {} }),
      );
    expect(page(false)).toContain('Repository not found (or it is private)');
    expect(page(false)).toContain('Sign in');
    expect(page(false)).toContain('href="/source/explore"');
    expect(page(true)).not.toContain('Sign in');
  });
});
