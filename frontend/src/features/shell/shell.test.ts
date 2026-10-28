// The shell's sidebar rows and its New repository seed.
import { describe, expect, it } from 'vitest';
import type { Repository } from '../../lib/types';
import { readmeSeed } from './NewRepositoryDialog';
import { repoRows } from './repoRows';

const project = (id: string, name: string, repo?: string, status = 'ready') =>
  ({ id, name, status, ...(repo ? { platform: { repo } } : {}) }) as Repository;
const a = 'r0000000000000000000a';
const b = 'r0000000000000000000b';
const c = 'r0000000000000000000c';

describe('repository rows', () => {
  it('lists an agent project once, as its platform repository under the project name', () => {
    const rows = repoRows(
      [
        { id: a, name: 'p-site' },
        { id: b, name: 'cli-repo' },
      ],
      [project('p-site', 'Marketing site', a)],
    );
    expect(rows.map((r) => [r.name, r.repo, r.project?.id])).toEqual([
      ['cli-repo', b, undefined],
      ['Marketing site', a, 'p-site'],
    ]);
  });

  it('keeps a project whose setup has not bound (or listed) its repository yet', () => {
    const rows = repoRows([], [project('p-new', 'New site', undefined, 'provisioning')]);
    expect(rows).toEqual([
      expect.objectContaining({ key: 'project:p-new', name: 'New site', repo: undefined }),
    ]);
    const bound = repoRows([], [project('p-new', 'New site', c, 'provisioning')]);
    expect(bound[0]).toMatchObject({ repo: c, name: 'New site' });
    // The legacy snapshot field binds too.
    const legacy = repoRows(
      [{ id: c, name: 'p-old' }],
      [{ ...project('p-old', 'Old'), platform_repo: c }],
    );
    expect(legacy).toHaveLength(1);
    expect(legacy[0].name).toBe('Old');
  });

  it("labels another account's repository with its owner and role, and falls back to the id", () => {
    const rows = repoRows(
      [
        { id: a, name: 'shared', owner: 'ada', role: 'write' },
        { id: b, name: '' },
      ],
      [],
    );
    expect(rows.find((r) => r.repo === a)?.shared).toBe('ada · write');
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
