// The shell's sidebar rows and its New repository seed.
import { describe, expect, it } from 'vitest';
import { readmeSeed } from './NewRepositoryDialog';
import { repoRows } from './repoRows';

const a = 'r0000000000000000000a';
const b = 'r0000000000000000000b';

describe('repository rows', () => {
  it("sorts by name, labels another account's repository with its owner and role, and falls back to the id", () => {
    const rows = repoRows([
      { id: a, name: 'shared', owner: 'ada', role: 'write' },
      { id: b, name: '' },
      { id: 'r0000000000000000000c', name: 'mine', owner: 'me', role: 'owner' },
    ]);
    expect(rows.map((r) => r.name)).toEqual(
      ['mine', b, 'shared'].sort((x, y) => x.localeCompare(y)),
    );
    expect(rows.find((r) => r.repo === a)?.shared).toBe('ada · write');
    expect(rows.find((r) => r.name === 'mine')?.shared).toBeUndefined();
    expect(rows.find((r) => r.repo === b)?.name).toBe(b);
  });
});

describe('new repository seed', () => {
  it('titles the README with the name and adds the description (UTF-8 safe)', () => {
    const decode = (b64: string) =>
      new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
    expect(decode(readmeSeed('demo', ''))).toBe('# demo\n');
    expect(decode(readmeSeed('demo', '  Café ✓ notes \n'))).toBe('# demo\n\nCafé ✓ notes\n');
  });
});
