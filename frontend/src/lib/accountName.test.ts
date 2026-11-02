import { describe, expect, it } from 'vitest';
import { accountName, firstName } from './accountName';

describe('accountName', () => {
  it('prefers the name, then the handle, then a plain username', () => {
    const identity = { username: 'ada', handle: 'ada_l', display_name: 'Ada Lovelace' };
    expect(accountName(identity)).toBe('Ada Lovelace');
    expect(accountName({ ...identity, display_name: null })).toBe('ada_l');
    expect(accountName({ username: 'ada' })).toBe('ada');
  });

  it('never gives an email address', () => {
    expect(accountName({ username: 'ada@example.com', handle: null })).toBeUndefined();
    expect(accountName({ username: 'ada@example.com', handle: 'ada_l' })).toBe('ada_l');
    expect(accountName(undefined)).toBeUndefined();
    expect(accountName(null)).toBeUndefined();
  });
});

describe('firstName', () => {
  it('greets by the first word of a name, and by a whole handle', () => {
    expect(firstName({ username: 'ada', display_name: 'Ada  Lovelace' })).toBe('Ada');
    expect(firstName({ username: 'ada', handle: 'ada_l' })).toBe('ada_l');
    expect(firstName({ username: 'ada@example.com' })).toBeUndefined();
  });
});
