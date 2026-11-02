// The undo window as people read it: days left, a repository to restore, what a name that was
// taken asks for, and text that promises an undo only where there is one.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseSettingsPath } from '../account-settings/settingsRoute';
import { deleteNote } from './ConnectPanel';
import { DeleteOrganization } from './OrgDelete';
import { DeletedList, daysLeft, leftLabel } from './RecentlyDeleted';
import { PurgeDialog, purgeEach } from './RecentlyDeletedPurge';
import { SourceApiError } from './sourceApi';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const repo = (days: number, name = 'app') => ({
  id: `r0123456789abcdef${name.padEnd(4, '0')}`,
  name,
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
    expect(page).toContain('Nothing deleted in the last 30 days.');
  });
  it('still lists what the window promised after it was switched off', () => {
    expect(list([repo(3)], 0)).toContain('3 days left');
    expect(list([], 0)).not.toContain('days');
  });
});

describe('deleting for good', () => {
  const held = new SourceApiError('LEGAL_HOLD', 'This repository is under a legal hold', 423);
  const gone = new SourceApiError('GONE', 'Repository was deleted', 404);
  const dialog = (repos: ReturnType<typeof repo>[]) =>
    renderToStaticMarkup(
      createElement(PurgeDialog, { repos, purge: async () => {}, onPurged: noop, onClose: noop }),
    );

  it('offers a named Delete on every row', () => {
    expect(list([repo(12)])).toContain('aria-label="Delete app permanently"');
  });
  it('offers Delete all only when more than one is listed', () => {
    expect(list([repo(12)])).not.toContain('Delete all');
    expect(list([repo(12), repo(3, 'web')])).toContain('Delete all');
  });
  it('names the one repository and says it cannot be undone', () => {
    const page = dialog([repo(12)]);
    expect(page).toContain('Delete app permanently?');
    expect(page).toContain('This can&#x27;t be undone.');
    expect(page).toContain('>Delete permanently<');
  });
  it('says how many Delete all takes, and that it cannot be undone', () => {
    const page = dialog([repo(12), repo(3, 'web'), repo(1, 'docs')]);
    expect(page).toContain('Delete all 3 repositories permanently?');
    expect(page).toContain('This can&#x27;t be undone.');
    expect(page).toContain('>Delete all 3<');
  });
  it('goes through every repository in turn, counting each', async () => {
    const seen: number[] = [];
    const asked: string[] = [];
    const failed = await purgeEach(
      [repo(1, 'a'), repo(2, 'b'), repo(3, 'c')],
      async ({ name }) => void asked.push(name),
      (n) => seen.push(n),
    );
    expect(asked).toEqual(['a', 'b', 'c']);
    expect(seen).toEqual([1, 2, 3]);
    expect(failed).toEqual([]);
  });
  it('reports what it could not delete, and carries on', async () => {
    const failed = await purgeEach(
      [repo(1, 'a'), repo(2, 'b'), repo(3, 'c')],
      async ({ name }) => {
        if (name === 'b') throw held;
      },
      noop,
    );
    expect(failed.map((f) => [f.repo.name, f.reason])).toEqual([
      ['b', 'This repository is under a legal hold'],
    ]);
  });
  it('counts one already gone as done', async () => {
    const failed = await purgeEach(
      [repo(1, 'a')],
      async () => {
        throw gone;
      },
      noop,
    );
    expect(failed).toEqual([]);
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
