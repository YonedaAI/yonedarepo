import { describe, expect, it } from 'vitest';
import { commitDays, filesLabel, type LogCommit } from './commitLog';

const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();
const commit = (authored_at?: number) =>
  ({ commit: 'c', message: 'm', principal: 'user:a', authored_at }) as LogCommit;

describe('commitDays', () => {
  it('bands the list by day and counts each band', () => {
    const days = commitDays([commit(at(30, 15)), commit(at(30, 9)), commit(at(29))], 100);
    expect(days.map((d) => [d.commits.length, d.count])).toEqual([
      [2, '2 commits'],
      [1, '1 commit'],
    ]);
  });

  it('says the last day may hold more when the list was cut there', () => {
    const days = commitDays([commit(at(30)), commit(at(29)), commit(at(29))], 3);
    expect(days.map((d) => d.count)).toEqual(['1 commit', '2+ commits']);
  });

  it('keeps a commit with no date', () => {
    expect(commitDays([commit()], 100)[0].day).toBe('Unknown date');
  });
});

describe('filesLabel', () => {
  it('says how many files, and stops where the log stops counting', () => {
    expect(filesLabel(1)).toBe('1 file');
    expect(filesLabel(3)).toBe('3 files');
    expect(filesLabel(1_000)).toBe('1,000 files');
    expect(filesLabel(1_001)).toBe('1,000+ files');
  });

  it('says nothing for no files, or a server that does not say', () => {
    expect(filesLabel(0)).toBeUndefined();
    expect(filesLabel(undefined)).toBeUndefined();
  });
});
