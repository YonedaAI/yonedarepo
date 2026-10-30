// The profile page's pure parts: its name and initial, and the overview's cards.
import { describe, expect, it } from 'vitest';
import {
  type Profile,
  type ProfileRepo,
  profileInitial,
  profileName,
  topRepos,
} from './profileModel';

const repo = (name: string, extra: Partial<ProfileRepo> = {}): ProfileRepo => ({
  id: `r${name.padEnd(20, '0').slice(0, 20)}`,
  name,
  ...extra,
});

describe('profile', () => {
  it('goes by its display name, else its handle', () => {
    const ada: Profile = { handle: 'ada', kind: 'user', repositories: [] };
    expect(profileName(ada)).toBe('ada');
    expect(profileName({ ...ada, display_name: '  Ada Lovelace ' })).toBe('Ada Lovelace');
    expect(profileInitial({ ...ada, display_name: 'Ada Lovelace' })).toBe('A');
    expect(profileInitial({ ...ada, handle: 'acme', kind: 'org', display_name: '' })).toBe('A');
  });

  it('shows the pinned repositories, else the most recently active', () => {
    const repos = [
      repo('alpha', { last_landed_at: 10 }),
      repo('beta', { last_landed_at: 30 }),
      repo('gamma'),
      repo('delta', { created_at: 20 }),
    ];
    expect(topRepos(repos).map((r) => r.name)).toEqual(['beta', 'delta', 'alpha', 'gamma']);
    expect(topRepos(repos, 2).map((r) => r.name)).toEqual(['beta', 'delta']);
    const pinned = [...repos, repo('pinned', { pinned: true })];
    expect(topRepos(pinned).map((r) => r.name)).toEqual(['pinned']);
  });
});
