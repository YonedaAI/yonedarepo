// Contact support in the browser: the menu item is a button, the dialog's fixed text and
// disabled Send, the attachment's early checks, and what a failure says.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { AccountMenu, MENU_LINKS } from './AccountMenu';
import { SupportDialog } from './SupportDialog';
import { attachmentProblem, attachmentType, canSend, sendFailure } from './supportModel';

const render = (element: React.ReactElement) => renderToStaticMarkup(element);

describe('the account menu', () => {
  const html = render(
    createElement(AccountMenu, {
      identity: { username: 'ada', avatar_url: null, avatar_source: null },
      navigate: vi.fn(),
      onSignOut: async () => {},
      onError: () => {},
    }),
  );

  it('offers Support as a button that opens a dialog, not a mailto link', () => {
    expect(html).not.toContain('mailto:');
    expect(html).toMatch(
      /<button type="button" class="account-item" aria-haspopup="dialog">.*Support<\/button>/,
    );
    expect(MENU_LINKS.map((link) => link.label)).toEqual(['Documentation', 'About']);
  });
});

describe('the support dialog', () => {
  const form = render(createElement(SupportDialog, { onClose: () => {} }));

  it('shows its fields, with the privacy link and required consent', () => {
    expect(form).toContain('Contact support</h2>');
    expect(form).toContain(
      'Tell us what&#x27;s going on. We&#x27;ll reply to the email on your account.',
    );
    expect(form).toContain('placeholder="What&#x27;s going on?"');
    expect(form).toContain('maxLength="5000"');
    expect(form).toContain('Attach file');
    expect(form).toContain('I agree to be contacted about this request.');
    expect(form).toMatch(/<input type="checkbox" required=""/);
    expect(form).toContain('href="/privacy"');
    expect(form).toContain('>Cancel</button>');
  });

  it('starts with Send disabled, and needs both text and the checkbox', () => {
    expect(form).toMatch(/<button type="submit" disabled="">Send<\/button>/);
    expect(canSend('', false)).toBe(false);
    expect(canSend('help', false)).toBe(false);
    expect(canSend('', true)).toBe(false);
    expect(canSend('  \n ', true)).toBe(false);
    expect(canSend('help', true)).toBe(true);
  });
});

describe('an attachment', () => {
  const MB = 1024 * 1024;

  it('may be an image, a PDF or a text file up to 5 MB', () => {
    expect(attachmentProblem({ name: 'a.png', type: 'image/png', size: 5 * MB })).toBe('');
    expect(attachmentProblem({ name: 'a.pdf', type: 'application/pdf', size: 1 })).toBe('');
    expect(attachmentProblem({ name: 'a.log', type: '', size: 1 })).toBe('');
    expect(attachmentProblem({ name: 'a.md', type: 'text/markdown', size: 1 })).toBe('');
  });

  it('is refused early over the size or of another type', () => {
    expect(attachmentProblem({ name: 'a.png', type: 'image/png', size: 5 * MB + 1 })).toMatch(
      /5 MB/,
    );
    expect(attachmentProblem({ name: 'a.png', type: 'image/png', size: 0 })).toMatch(/empty/);
    expect(attachmentProblem({ name: 'a.svg', type: 'image/svg+xml', size: 1 })).toMatch(/PNG/);
    expect(attachmentProblem({ name: 'a.zip', type: 'application/zip', size: 1 })).toMatch(/PNG/);
    expect(attachmentProblem({ name: 'run', type: '', size: 1 })).toMatch(/PNG/);
  });

  it('says nothing about a text file, whose type browsers disagree on', () => {
    expect(attachmentProblem({ name: 'a.csv', type: 'application/vnd.ms-excel', size: 1 })).toBe(
      '',
    );
    expect(attachmentType({ name: 'a.csv', type: 'application/vnd.ms-excel' })).toBe('');
    expect(attachmentType({ name: 'a.png', type: 'image/png' })).toBe('image/png');
  });
});

describe('a failure', () => {
  it("shows the server's words, and a plain line for anything else", () => {
    expect(sendFailure(new ApiError('RATE_LIMITED', 'Try again tomorrow.'))).toBe(
      'Try again tomorrow.',
    );
    expect(sendFailure(new ApiError('REQUEST_TIMEOUT', 'Refresh'))).toMatch(
      /took too long.*try again/i,
    );
    expect(sendFailure(new SyntaxError('Unexpected token <'))).toMatch(/not sent.*try again/i);
  });
});
