// Account pictures in the browser: whose picture a principal may show, the initials fallback,
// the account menu (its items, in order, and the signed-in person's picture), the person
// label in history, changes and comments, and the upload's checks before it is sent.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { pictureProblem } from '../account-settings/AvatarSettings';
import { Avatar, accountAvatar, avatarOf, initialOf } from '../shell/Avatar';
import { Person } from '../source-platform/Person';
import { ShowEmailsContext } from '../source-platform/people';
import { AccountMenu, MENU_LINKS } from './AccountMenu';

const render = (element: React.ReactElement) => renderToStaticMarkup(element);

describe('whose picture shows', () => {
  it('is a public account name, never an email-named account, a token or an agent', () => {
    expect(avatarOf('user:ada')).toBe('/api/v1/avatars/ada');
    expect(accountAvatar('ada')).toBe('/api/v1/avatars/ada');
    expect(accountAvatar('ada@example.com')).toBeNull();
    for (const nobody of [
      'ada',
      'user:ada@example.com',
      'ada@example.com',
      'token:ci',
      'platform:merge',
      'agent:review',
      'admin',
      '',
    ])
      expect(avatarOf(nobody), nobody).toBeNull();
  });

  it('falls back to the first letter of the name', () => {
    expect(initialOf('ada')).toBe('A');
    expect(initialOf('_bot')).toBe('B');
    expect(initialOf('')).toBe('?');
    const html = render(createElement(Avatar, { name: 'ada', src: '/api/v1/avatars/ada' }));
    expect(html).toMatch(/>A<img /);
    expect(html).toContain('src="/api/v1/avatars/ada"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('alt=""');
    expect(render(createElement(Avatar, { name: 'ada', src: null }))).not.toContain('<img');
    // Its size is a CSS variable, so a page's class (the profile's, smaller on a phone) wins.
    const sized = render(
      createElement(Avatar, { name: 'ada', src: null, size: 88, className: 'profile-avatar' }),
    );
    expect(sized).toContain('class="avatar profile-avatar"');
    expect(sized).toContain('style="--avatar-size:88px"');
  });
});

describe('the account menu', () => {
  const menu = (avatar_url: string | null) =>
    render(
      createElement(AccountMenu, {
        identity: { username: 'ada', avatar_url, avatar_source: avatar_url ? 'upload' : null },
        navigate: vi.fn(),
        onConnect: vi.fn(),
        onSignOut: async () => {},
        onError: () => {},
      }),
    );

  it('lists Account, Organizations, Billing, Connect agents, Appearance, Support, Documentation, About and Log out, in order', () => {
    const html = menu(null);
    const order = [
      'Account',
      'Organizations',
      'Billing',
      'Connect agents (CLI, MCP)',
      'Appearance',
      'Support',
      'Documentation',
      'About',
      'Log out',
    ];
    const at = order.map((label) => html.indexOf(`>${label}<`));
    expect(
      at.every((n) => n > 0),
      JSON.stringify(at),
    ).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // No product changelog page exists yet, so the menu does not link one.
    expect(html).not.toContain('Changelog');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('href="/settings/organizations"');
    expect(html).toContain('href="/settings/billing"');
    expect(html).toContain('aria-haspopup="true"');
    for (const { href } of MENU_LINKS.filter((l) => l.external))
      expect(html).toContain(`href="${href}" target="_blank" rel="noopener"`);
  });

  it("shows the person's picture in the button and the header, else their initial", () => {
    const html = menu('/api/v1/account/avatar?v=0123456789ab');
    expect(html.split('src="/api/v1/account/avatar?v=0123456789ab"')).toHaveLength(3);
    expect(menu(null)).not.toContain('<img');
    expect(menu(null)).toContain('>A</span>');
  });
});

describe('a person in history, changes and comments', () => {
  it("shows a user's picture and name, and no picture for an address it hides", () => {
    const user = render(createElement(Person, { principal: 'user:ada' }));
    expect(user).toContain('src="/api/v1/avatars/ada"');
    expect(user).toContain('ada');
    const hidden = render(createElement(Person, { principal: 'user:ada@example.com' }));
    expect(hidden).not.toContain('<img');
    expect(hidden).not.toContain('example.com');
    expect(hidden).toContain('member');
    // A member sees the address, still without a picture (the URL would carry it).
    const member = render(
      createElement(
        ShowEmailsContext.Provider,
        { value: true },
        createElement(Person, { principal: 'user:ada@example.com' }),
      ),
    );
    expect(member).toContain('ada@example.com');
    expect(member).not.toContain('<img');
    expect(render(createElement(Person, { principal: 'token:ci' }))).toContain('ci (token)');
  });
});

describe('an upload, before it is sent', () => {
  const file = (type: string, size: number) => ({ type, size }) as File;
  it('takes a PNG, JPEG or WebP of at most 1 MB', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp'])
      expect(pictureProblem(file(type, 1024 * 1024))).toBe('');
    expect(pictureProblem(file('image/gif', 10))).toMatch(/PNG, JPEG or WebP/);
    expect(pictureProblem(file('image/svg+xml', 10))).toMatch(/PNG, JPEG or WebP/);
    expect(pictureProblem(file('image/png', 1024 * 1024 + 1))).toMatch(/1 MB/);
    expect(pictureProblem(file('image/png', 0))).toMatch(/empty/);
  });
});
