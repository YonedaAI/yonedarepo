// The shell's sidebar rows and its New repository seed.
import { describe, expect, it } from 'vitest';
import { createBody, readmeSeed } from './NewRepositoryDialog';
import { repoRows, rowLabel } from './repoRows';

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

describe('public repository rows', () => {
  it('marks only public repositories, and says so in the spoken name', () => {
    const rows = repoRows([
      { id: a, name: 'open', visibility: 'public' },
      { id: b, name: 'closed', visibility: 'private' },
      { id: 'r0000000000000000000c', name: 'old' },
      {
        id: 'r0000000000000000000d',
        name: 'theirs',
        owner: 'ada',
        role: 'read',
        visibility: 'public',
      },
    ]);
    const by = (name: string) => rows.find((r) => r.name === name);
    expect(by('open')?.public).toBe(true);
    expect(by('closed')?.public).toBeUndefined();
    expect(by('old')?.public).toBeUndefined();
    expect(rowLabel(by('open') as (typeof rows)[number])).toBe('open, public');
    expect(rowLabel(by('theirs') as (typeof rows)[number])).toBe('theirs, ada · read, public');
    expect(rowLabel(by('closed') as (typeof rows)[number])).toBeUndefined();
  });
});

describe('new repository request', () => {
  it('sends the chosen visibility, private unless public was picked', () => {
    expect(createBody('demo', '', '').visibility).toBe('private');
    expect(createBody('demo', '', '', 'public')).toMatchObject({
      name: 'demo',
      visibility: 'public',
    });
    expect(createBody('demo', '', 'acme', 'private')).toMatchObject({
      owner: 'acme',
      visibility: 'private',
    });
    expect(createBody('demo', '', '')).not.toHaveProperty('owner');
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
