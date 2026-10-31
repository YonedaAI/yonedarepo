// The repository picker's model: Favorites, Recent, then the rest, each repository once; the
// filter over owner and name; this browser's recent list; the Cmd/Ctrl+K shortcut, which
// leaves typing alone; where the popup goes; and saving a favorite with rollback.
import { describe, expect, it, vi } from 'vitest';
import { SourceApiError } from '../source-platform/sourceApi';
import {
  fullName,
  optionLabel,
  pickerGroups,
  pickerShortcut,
  popupPlace,
  readRecents,
  saveRecent,
  withFavoriteRows,
} from './pickerModel';
import { matchRows, repoRows } from './repoRows';
import { saveFavorite } from './useFavorites';

const row = (repo: string, name = repo, owner?: string) => ({ repo, name, owner });
const rows = ['alpha', 'beta', 'gamma', 'delta', 'omega'].map((n) => row(n));
const names = (groups: ReturnType<typeof pickerGroups>) =>
  groups.map((g) => [g.label, ...g.rows.map((r) => r.name)]);

describe('picker groups', () => {
  it('orders Favorites, Recent, then the rest, with each repository once', () => {
    const groups = pickerGroups(rows, new Set(['omega', 'beta']), ['gamma', 'omega', 'alpha'], '');
    expect(names(groups)).toEqual([
      ['Favorites', 'beta', 'omega'],
      ['Recent', 'gamma', 'alpha'],
      ['Repositories', 'delta'],
    ]);
  });

  it('leaves out an empty group', () => {
    expect(names(pickerGroups(rows, new Set(), [], ''))).toEqual([
      ['Repositories', 'alpha', 'beta', 'gamma', 'delta', 'omega'],
    ]);
    expect(names(pickerGroups(rows, new Set(['alpha']), ['beta'], 'alp'))).toEqual([
      ['Favorites', 'alpha'],
    ]);
    expect(pickerGroups([], new Set(['gone']), ['gone'], '')).toEqual([]);
  });

  it('drops a recent repository this account no longer has', () => {
    expect(names(pickerGroups(rows.slice(0, 1), new Set(), ['deleted', 'alpha'], ''))).toEqual([
      ['Recent', 'alpha'],
    ]);
  });

  it("adds a favorite that is in no row (another account's public repository) once", () => {
    const extra = row('r9', 'compiler', 'ada');
    const all = withFavoriteRows(rows, [extra, row('alpha')]);
    expect(all.filter((r) => r.repo === 'alpha')).toHaveLength(1);
    expect(names(pickerGroups(all, new Set(['r9']), [], 'compiler'))).toEqual([
      ['Favorites', 'compiler'],
    ]);
  });

  it('filters by owner, name and both, any case', () => {
    const listed = repoRows(
      [
        { id: 'a', name: 'Parser', owner: 'ada', owner_handle: 'ada', role: 'write' },
        { id: 'b', name: 'lexer', owner: 'acme', owner_handle: 'acme', role: 'owner' },
        { id: 'c', name: 'docs', owner: 'me', owner_handle: 'me', role: 'owner' },
      ],
      ['me'],
    );
    expect(listed.map(fullName).sort()).toEqual(['acme/lexer', 'ada/Parser', 'docs']);
    expect(matchRows(listed, 'ACME').map((r) => r.name)).toEqual(['lexer']);
    expect(matchRows(listed, 'ada/par').map((r) => r.name)).toEqual(['Parser']);
    expect(matchRows(listed, 'doc').map((r) => r.name)).toEqual(['docs']);
    expect(matchRows(listed, 'me/do').map((r) => r.name)).toEqual(['docs']);
  });

  it('speaks a label only when there is one beyond the visible name', () => {
    expect(optionLabel(row('a', 'parser'), false)).toBeUndefined();
    expect(optionLabel({ ...row('a', 'parser', 'ada'), public: true }, true)).toBe(
      'ada/parser, public, favorite',
    );
  });
});

describe('recent repositories', () => {
  const memory = () => {
    const held = new Map<string, string>();
    return {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
    } as unknown as Storage;
  };

  it('keeps the last 10 opened, newest first, each once', () => {
    const storage = memory();
    for (let n = 0; n < 12; n++) saveRecent(`r${n}`, storage);
    saveRecent('r5', storage);
    const recents = readRecents(storage);
    expect(recents).toHaveLength(10);
    expect(recents[0]).toBe('r5');
    expect(recents.filter((r) => r === 'r5')).toHaveLength(1);
    expect(recents[1]).toBe('r11');
  });

  it('survives storage that refuses or holds nonsense', () => {
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readRecents(refusing)).toEqual([]);
    expect(() => saveRecent('r1', refusing)).not.toThrow();
    const odd = memory();
    odd.setItem('yoneda.recent-repositories', '{"not":"a list"}');
    expect(readRecents(odd)).toEqual([]);
    odd.setItem('yoneda.recent-repositories', '["r1",2,null]');
    expect(readRecents(odd)).toEqual(['r1']);
    expect(readRecents(undefined)).toEqual([]);
  });
});

describe('the shortcut', () => {
  const key = (over: object = {}) =>
    ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over }) as Pick<
      KeyboardEvent,
      'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'target'
    >;
  const inside = (hit: boolean) => ({ closest: () => (hit ? {} : null) }) as unknown as EventTarget;

  it('is Cmd or Ctrl and K, any case, with nothing else held', () => {
    expect(pickerShortcut(key({ metaKey: true }))).toBe(true);
    expect(pickerShortcut(key({ ctrlKey: true, key: 'K' }))).toBe(true);
    expect(pickerShortcut(key())).toBe(false);
    expect(pickerShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(pickerShortcut(key({ metaKey: true, altKey: true }))).toBe(false);
    expect(pickerShortcut(key({ metaKey: true, key: 'j' }))).toBe(false);
  });

  it('leaves typing and open dialogs alone', () => {
    expect(pickerShortcut(key({ metaKey: true, target: inside(true) }))).toBe(false);
    expect(pickerShortcut(key({ metaKey: true, target: inside(false) }))).toBe(true);
  });
});

describe('the popup', () => {
  const box = { left: 80, bottom: 200 };

  it('opens under the row, inside the window', () => {
    expect(popupPlace(box, 1280, 800)).toEqual({ top: 204, left: 80, maxHeight: 580 });
    // A row near the bottom of a short window still leaves room to scroll a list.
    expect(popupPlace({ left: 80, bottom: 700 }, 1280, 760).top).toBeLessThanOrEqual(460);
  });

  it('keeps a 16px gutter on a phone', () => {
    expect(popupPlace({ left: 10, bottom: 300 }, 390, 844).left).toBe(16);
  });
});

describe('saving a favorite', () => {
  const run = () => {
    let ids: ReadonlySet<string> = new Set(['kept']);
    const seen: string[][] = [];
    const update = (change: (held: ReadonlySet<string>) => ReadonlySet<string>) => {
      ids = change(ids);
      seen.push([...ids]);
    };
    return { update, seen, ids: () => ids };
  };

  it('shows the change before the answer and keeps it', async () => {
    const state = run();
    const request = vi.fn().mockResolvedValue({});
    const fail = vi.fn();
    expect(await saveFavorite('new', true, state.update, fail, request)).toBe(true);
    expect(request).toHaveBeenCalledWith('/favorites/new', { method: 'PUT' });
    expect(state.seen).toEqual([['kept', 'new']]);
    expect(fail).not.toHaveBeenCalled();
    await saveFavorite('kept', false, state.update, fail, request);
    expect(request).toHaveBeenLastCalledWith('/favorites/kept', { method: 'DELETE' });
    expect([...state.ids()]).toEqual(['new']);
  });

  it('rolls back and says why when the server refuses', async () => {
    const state = run();
    const refused = new SourceApiError('FAVORITES_FULL', 'You can keep 50 favorites', 409);
    const fail = vi.fn();
    expect(
      await saveFavorite('new', true, state.update, fail, vi.fn().mockRejectedValue(refused)),
    ).toBe(false);
    expect(state.seen).toEqual([['kept', 'new'], ['kept']]);
    expect(fail).toHaveBeenCalledWith('You can keep 50 favorites');
  });
});
