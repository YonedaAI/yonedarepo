// The handle prompt's rules: whom it asks, what it refuses before asking the server, and how
// it words the server's refusals.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HandleRow } from '../account-settings/HandleSettings';
import { HandlePicker } from './HandlePicker';
import { handleProblem, handleRefusal, needsHandle } from './handleModel';

describe('handle prompt', () => {
  it('asks only an email-named account the server says has no handle', () => {
    expect(needsHandle({ username: 'ada@example.com', handle: null })).toBe(true);
    expect(needsHandle({ username: 'ada@example.com', handle: 'ada' })).toBe(false);
    // A server without handles says nothing: never ask.
    expect(needsHandle({ username: 'ada@example.com' })).toBe(false);
    expect(needsHandle({ username: 'ada', handle: null })).toBe(false);
    expect(needsHandle(null)).toBe(false);
  });

  it('refuses a malformed handle before asking the server', () => {
    expect(handleProblem('')).toBe('');
    expect(handleProblem('ada_l')).toBe('');
    expect(handleProblem('Ada')).toBe('Use lowercase letters.');
    expect(handleProblem('ad')).toMatch(/3–32/);
    expect(handleProblem('1ada')).toMatch(/starting with a letter/);
    expect(handleProblem('ada-l')).toMatch(/underscores/);
  });

  it('words the server’s refusals', () => {
    expect(handleRefusal('HANDLE_TAKEN', 'ada', 'x')).toBe('ada is taken. Try another.');
    expect(handleRefusal('HANDLE_RESERVED', 'docs', 'x')).toMatch(/reserved/);
    expect(handleRefusal('OTHER', 'ada', 'Server said no')).toBe('Server said no');
  });

  it('opens prefilled with the suggestion and never shows the email', () => {
    const html = renderToStaticMarkup(
      createElement(HandlePicker, { suggestion: 'ada_l', onDone: () => {}, onLater: () => {} }),
    );
    expect(html).toContain('value="ada_l"');
    expect(html).toContain('/ada_l/my-repo');
    expect(html).toContain('Not now');
    expect(html).not.toContain('@');
  });
});

describe('handle in Settings', () => {
  const row = (identity: { username: string; handle?: string | null }) =>
    renderToStaticMarkup(createElement(HandleRow, { identity, onChange: () => {} }));

  it('shows a handle that is the account name read-only', () => {
    const html = row({ username: 'ada', handle: 'ada' });
    expect(html).toContain('href="/ada"');
    expect(html).toContain('/ada');
    expect(html).toContain('account name');
    expect(html).not.toContain('<button');
  });

  it('shows the address of an email-named account, with a way to change it', () => {
    const html = row({ username: 'ada@example.com', handle: 'ada_l' });
    expect(html).toContain('href="/ada_l"');
    expect(html).toContain('>Change</button>');
    expect(html).not.toContain('@');
  });

  it('offers a handle to an email-named account without one', () => {
    const html = row({ username: 'ada@example.com', handle: null });
    expect(html).toContain('>Choose</button>');
    expect(html).not.toContain('@');
  });

  it('says nothing on a server without handles', () => {
    expect(row({ username: 'ada@example.com' })).toBe('');
  });

  it('opens on the current handle and says what a change does', () => {
    const html = renderToStaticMarkup(
      createElement(HandlePicker, {
        current: 'ada_l',
        cancel: 'Cancel',
        onDone: () => {},
        onLater: () => {},
      }),
    );
    expect(html).toContain('Change your handle');
    expect(html).toContain('value="ada_l"');
    expect(html).toContain('<code>/ada_l</code> stops working');
    expect(html).toContain('This is your handle.');
    expect(html).toContain('Cancel');
    expect(html).not.toContain('Not now');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
});
