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
  it('parses the emailed link and formats it back', () => {
    const route = parseSourceRoute('/verify-email', `?account=ada%40example.com&token=${token}`);
    expect(route).toEqual({ view: 'verify-email', account: 'ada@example.com', token });
    expect(formatSourceRoute(route)).toBe(`/verify-email?account=ada%40example.com&token=${token}`);
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
    expect(html).toContain('Resend confirmation');
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
    expect(html).not.toContain('Resend confirmation');
  });

  it('offers to add one when the account has none', () => {
    const html = render(
      createElement(EmailAddress, { ...props, status: { email: null, verified: false } }),
    );
    expect(html).toContain('No email address');
    expect(html).toContain('>Add</button>');
    expect(html).not.toContain('Resend confirmation');
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
