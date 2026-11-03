import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { Notifications } from './Notifications';
import { useNotifications } from './useNotifications';

vi.mock('./useNotifications', () => ({ useNotifications: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const state = (unread = 0) => ({
  inbox: { items: [], unread },
  loading: false,
  error: '',
  load: vi.fn(),
  markRead: vi.fn(),
  remove: vi.fn(),
  clearAll: vi.fn(),
});
it('shows only a quiet bell until the recipient opens their inbox', () => {
  vi.mocked(useNotifications).mockReturnValue(state());
  const html = renderToStaticMarkup(
    createElement(Notifications, { enabled: true, navigate: vi.fn() }),
  );
  expect(html).toContain('aria-label="Notifications"');
  expect(html).not.toContain('dialog');
  expect(html).not.toContain('No notifications');
});
it('gives the signed-in recipient an accessible unread count without exposing addresses', () => {
  vi.mocked(useNotifications).mockReturnValue(state(2));
  const html = renderToStaticMarkup(
    createElement(Notifications, { enabled: true, navigate: vi.fn() }),
  );
  expect(html).toContain('Notifications, 2 unread');
  expect(html).not.toContain('@');
});
it('disables admission-pending controls and does not open a second sign-in flow', () => {
  vi.mocked(useNotifications).mockReturnValue(state());
  const html = renderToStaticMarkup(
    createElement(Notifications, { enabled: false, navigate: vi.fn() }),
  );
  expect(html).toContain('disabled');
  expect(html).not.toContain('Sign in');
});
