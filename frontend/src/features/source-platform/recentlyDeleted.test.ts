// The undo window as people read it: days left, a repository to restore, what a name that was
// taken asks for, and text that promises an undo only where there is one.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseSettingsPath } from '../account-settings/settingsRoute';
import { deleteNote } from './ConnectPanel';
import { DeleteOrganization } from './OrgDelete';
import { DeletedList, daysLeft, leftLabel } from './RecentlyDeleted';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const repo = (days: number) => ({
  id: 'r0123456789abcdef0123',
  name: 'app',
  owner: 'alice',
  visibility: 'private',
  created_at: NOW - 90 * DAY,
  deleted_at: NOW - DAY,
  purge_at: NOW + days * DAY,
});
const noop = () => {};
const list = (repos: ReturnType<typeof repo>[], window_days = 30) =>
  renderToStaticMarkup(
    createElement(DeletedList, { deleted: { window_days, repos }, now: NOW, onChanged: noop }),
  );

describe('what is left of the window', () => {
  it('rounds up, so the last day still reads as a day', () => {
    expect(daysLeft(NOW + 29.5 * DAY, NOW)).toBe(30);
    expect(daysLeft(NOW + 1, NOW)).toBe(1);
    expect(daysLeft(NOW - 1, NOW)).toBe(0);
  });
  it('says it in words', () => {
    expect(leftLabel(NOW + 2 * DAY, NOW)).toBe('2 days left');
    expect(leftLabel(NOW + DAY, NOW)).toBe('1 day left');
    expect(leftLabel(NOW, NOW)).toBe('Purge due now');
  });
});

describe('the list', () => {
  it('shows each repository with its days left and a named Restore', () => {
    const page = list([repo(12)]);
    expect(page).toContain('app');
    expect(page).toContain('12 days left');
    expect(page).toContain('aria-label="Restore app"');
  });
  it('says plainly when nothing is waiting, with the window in it', () => {
    const page = list([]);
    expect(page).toContain('Nothing here.');
    expect(page).toContain('30 days');
  });
  it('still lists what the window promised after it was switched off', () => {
    expect(list([repo(3)], 0)).toContain('3 days left');
    expect(list([], 0)).not.toContain('days');
  });
});

describe('text that promises an undo', () => {
  it('keeps the warning where there is no window', () => {
    expect(deleteNote(0)).toContain('It cannot be undone.');
  });
  it('says how long where there is', () => {
    expect(deleteNote(30)).not.toContain('cannot be undone');
    expect(deleteNote(30)).toContain('30 days');
    expect(deleteNote(1)).toContain('1 day,');
  });
  it('warns an org owner that deleting it ends every restore', () => {
    const page = (inWindow?: number) =>
      renderToStaticMarkup(
        createElement(DeleteOrganization, { org: 'acme', inWindow, onDeleted: noop }),
      );
    expect(page(2)).toContain('2 deleted repositories can still be restored');
    expect(page(1)).toContain('1 deleted repository can still be restored');
    expect(page(0)).not.toContain('can still be restored');
    expect(page()).not.toContain('can still be restored');
  });
});

describe('the page', () => {
  it('has its own address', () => {
    const none = new URLSearchParams();
    expect(parseSettingsPath(['recently-deleted'], none, '')).toEqual({
      view: 'settings',
      section: 'recently-deleted',
    });
  });
});
