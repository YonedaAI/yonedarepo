// Contact-email confirmation in the browser: the confirmation page's route, the page itself
// (a button that POSTs; opening the link confirms nothing), and Settings' email section.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatSourceRoute, parseSourceRoute } from '../source-platform/sourceRoute';
import { EmailAddress, EmailDialog } from './EmailSettings';
import { VerifyEmailPage } from './VerifyEmailPage';

const token = 'ab'.repeat(32);
const render = (element: React.ReactElement) => renderToStaticMarkup(element);
const noop = () => {};

describe('confirmation page route', () => {
  it('reads the link from the fragment and never writes the token back', () => {
    const route = parseSourceRoute(
      '/verify-email',
      '',
      `#account=ada%40example.com&token=${token}`,
    );
    expect(route).toEqual({ view: 'verify-email', account: 'ada@example.com', token });
    expect(formatSourceRoute(route)).toBe('/verify-email');
  });

  it('still opens a link emailed with its token in the query, and drops it from the address', () => {
    const route = parseSourceRoute('/verify-email', `?account=ada%40example.com&token=${token}`);
    expect(route).toEqual({ view: 'verify-email', account: 'ada@example.com', token });
    expect(formatSourceRoute(route)).toBe('/verify-email');
  });

  it('prefers the fragment and reads an empty address as an incomplete link', () => {
    expect(
      parseSourceRoute(
        '/verify-email',
        `?account=old&token=${'cd'.repeat(32)}`,
        `#account=ada&token=${token}`,
      ),
    ).toEqual({ view: 'verify-email', account: 'ada', token });
    expect(parseSourceRoute('/verify-email', '')).toEqual({
      view: 'verify-email',
      account: '',
      token: '',
    });
  });
});

describe('confirmation page', () => {
  it('asks for a click before confirming', () => {
    const html = render(createElement(VerifyEmailPage, { account: 'ada', token }));
    expect(html).toContain('Confirm your email');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Confirm<\/button>/);
    expect(html).toContain('ada');
  });

  it('explains an incomplete link instead of offering the button', () => {
    const html = render(createElement(VerifyEmailPage, { account: 'ada', token: '' }));
    expect(html).not.toContain('<button');
    expect(html).toContain('Settings');
  });
});

describe('Settings email section', () => {
  const props = { busy: false, onResend: noop, onChange: async () => '' };
  it('shows an unconfirmed address with a resend button', () => {
    const html = render(
      createElement(EmailAddress, {
        ...props,
        status: { email: 'ada@example.com', verified: false },
      }),
    );
    expect(html).toContain('ada@example.com');
    expect(html).toContain('Not confirmed');
    expect(html).toContain('Send confirmation link');
    // An address taken from the account's name was never sent a link.
    expect(html).not.toMatch(/we sent/i);
    // The field waits behind Change.
    expect(html).toContain('>Change</button>');
    expect(html).not.toContain('<input');
  });

  it('shows a confirmed address without one', () => {
    const html = render(
      createElement(EmailAddress, {
        ...props,
        status: { email: 'ada@example.com', verified: true },
      }),
    );
    expect(html).toContain('Confirmed');
    expect(html).not.toContain('Not confirmed');
    expect(html).not.toContain('Send confirmation link');
  });

  it('offers to add one when the account has none', () => {
    const html = render(
      createElement(EmailAddress, { ...props, status: { email: null, verified: false } }),
    );
    expect(html).toContain('No email address');
    expect(html).toContain('>Add</button>');
    expect(html).not.toContain('Send confirmation link');
  });

  it('asks for the address in a dialog', () => {
    const html = render(
      createElement(EmailDialog, {
        current: 'ada@example.com',
        busy: false,
        onChange: async () => '',
        onClose: noop,
      }),
    );
    expect(html).toContain('Change email');
    expect(html).toMatch(/<input[^>]*type="email"/);
    expect(html).toMatch(/<button type="submit"[^>]*>Send confirmation link<\/button>/);
    expect(
      render(
        createElement(EmailDialog, {
          current: null,
          busy: false,
          onChange: async () => '',
          onClose: noop,
        }),
      ),
    ).toContain('Add email');
  });
});
