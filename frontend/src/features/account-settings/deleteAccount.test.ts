// What the Delete account dialog says, and what it takes to confirm.
import { describe, expect, it } from 'vitest';
import { closureLines, confirmMatches } from './deleteAccountModel';

describe('deleting an account', () => {
  it('confirms on the handle, as typed by a person', () => {
    expect(confirmMatches('ada', 'ada')).toBe(true);
    expect(confirmMatches(' Ada ', 'ada')).toBe(true);
    expect(confirmMatches('ad', 'ada')).toBe(false);
    expect(confirmMatches('', 'ada')).toBe(false);
  });

  it('says what goes, counting repositories and naming credit only when there is some', () => {
    expect(closureLines({ repos: 0, credit_usd: 0 })).toEqual([
      'Your tokens, SSH keys, sessions and agents.',
      'Your place in other repositories and organizations.',
    ]);
    const lines = closureLines({ repos: 1, credit_usd: 4.5 });
    expect(lines[0]).toBe('1 repository. Nobody can restore them.');
    expect(lines.at(-1)).toContain('$4.50 of credit');
    expect(closureLines({ repos: 2, credit_usd: 0 })[0]).toContain('2 repositories');
  });

  it('keeps every line short', () => {
    for (const line of closureLines({ repos: 1200, credit_usd: 1000 }))
      expect(line.length).toBeLessThanOrEqual(76);
  });
});
