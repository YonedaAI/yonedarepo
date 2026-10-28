// Settings → Visibility: the request, the confirm step for each direction, who may change it,
// and how a refusal reads.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VisibilitySettings } from './VisibilitySettings';
import {
  otherVisibility,
  PUBLIC_WARNING,
  visibilityConfirm,
  visibilityError,
  visibilityRequest,
} from './visibilityModel';

const repo = `r${'a'.repeat(20)}`;

describe('visibility change', () => {
  it('PUTs the other visibility', () => {
    expect(otherVisibility('private')).toBe('public');
    expect(otherVisibility('public')).toBe('private');
    expect(visibilityRequest(repo, 'public')).toEqual({
      path: `/repos/${repo}/visibility`,
      method: 'PUT',
      body: { visibility: 'public' },
    });
  });

  it('warns what going public exposes, and that nobody gains write access', () => {
    const going = visibilityConfirm('public', 'demo');
    expect(going).toMatchObject({ title: 'Make demo public?', action: 'Make public' });
    expect(going.body).toBe(PUBLIC_WARNING);
    for (const part of ['without an account', 'code', 'history', 'releases', 'LFS files'])
      expect(PUBLIC_WARNING).toContain(part);
    expect(PUBLIC_WARNING).toContain('Nobody gains write access');
    expect(visibilityConfirm('private', 'demo')).toMatchObject({
      title: 'Make demo private?',
      action: 'Make private',
    });
  });

  it('tells an admin who can change it, and passes other errors through', () => {
    expect(visibilityError({ status: 403, message: 'Forbidden' })).toMatch(
      /Only the repository owner/,
    );
    expect(visibilityError({ status: 500, message: 'Request failed (500)' })).toBe(
      'Request failed (500)',
    );
  });
});

describe('visibility settings', () => {
  const render = (canChange: boolean, visibility: 'private' | 'public') =>
    renderToStaticMarkup(
      createElement(VisibilitySettings, {
        repo,
        name: 'demo',
        visibility,
        canChange,
        onChanged: () => {},
      }),
    );

  it('offers the owner the change and shows an admin the current state only', () => {
    expect(render(true, 'private')).toContain('Make public…');
    expect(render(true, 'public')).toContain('Make private…');
    const admin = render(false, 'public');
    expect(admin).toContain('<strong>Public</strong>');
    expect(admin).not.toContain('<button');
    expect(admin).toContain('Only the repository owner can change its visibility.');
  });
});
