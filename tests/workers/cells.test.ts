// Where a request belongs among the cells (docs/global-scale-plan.md, cells as built): a
// repository's id says its cell, and nothing is read to find out.
import { describe, expect, it } from 'vitest';
import {
  cellOfRegion,
  cellOfRepo,
  cellsOn,
  newRepoId,
  repoInPath,
  thisCell,
  tokenCell,
  tokenPrefix,
} from '../../cloudflare/worker/cells';
import type { Env } from '../../cloudflare/worker/types';

const fetcher = { fetch: async () => new Response('elsewhere') } as unknown as Fetcher;
const bound = { CELLS: 'on', CELL_WEUR: fetcher } as Partial<Env> as Env;
const inEurope = { CELLS: 'on', CELL: 'weur', CELL_ENAM: fetcher } as Partial<Env> as Env;
const off = {} as Env;

describe('a repository id', () => {
  it('names no cell unless it carries a tag, as every id made so far', () => {
    expect(cellOfRepo('r0123456789abcdef0123')).toBe('enam');
  });

  it("keeps the format every client checks, and carries its cell's tag", () => {
    const id = newRepoId(inEurope);
    expect(id).toMatch(/^r[0-9a-f]{20}$/);
    expect(cellOfRepo(id)).toBe('weur');
  });

  it('never takes a tag in enam, even when the random digits would', () => {
    // Each of the first draws ends in the tag; the generator must reject them.
    const bytes = [
      [0, 0, 0, 0, 0, 0, 0, 0xee, 0xa0, 0x01],
      [1, 0, 0, 0, 0, 0, 0, 0xee, 0xa0, 0x01],
      [2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ];
    const id = newRepoId(off, (into) => into.set(bytes.shift() as number[]));
    expect(cellOfRepo(id)).toBe('enam');
    expect(id).toBe('r02000000000000000000');
  });

  it('is found in every path that names one', () => {
    const id = 'r0123456789abcdef0123';
    expect(repoInPath(`/api/v1/repos/${id}`)).toBe(id);
    expect(repoInPath(`/api/v1/repos/${id}/commits`)).toBe(id);
    expect(repoInPath(`/git/${id}.git/info/refs`)).toBe(id);
    expect(repoInPath(`/git/${id}/git-upload-pack`)).toBe(id);
    expect(repoInPath(`/api/v1/admin/repos/${id}/hold`)).toBe(id);
    expect(repoInPath('/api/v1/repos')).toBeNull();
    expect(repoInPath('/alice/project.git/info/refs')).toBeNull();
  });
});

describe('a region', () => {
  it('goes to its nearest cell that exists', () => {
    expect(cellOfRegion(bound, 'weur')).toBe('weur');
    expect(cellOfRegion(bound, 'afr')).toBe('weur');
    expect(cellOfRegion(bound, 'sam')).toBe('enam');
    expect(cellOfRegion(bound, 'enam')).toBe('enam');
  });

  it('with no cell of its own stays in enam, and so does no region at all', () => {
    expect(cellOfRegion(bound, 'apac')).toBe('enam');
    expect(cellOfRegion(bound, 'oc')).toBe('enam');
    expect(cellOfRegion(bound, undefined)).toBe('enam');
  });

  it('means nothing with the switch off', () => {
    expect(cellOfRegion(off, 'weur')).toBe('enam');
  });
});

describe('a personal token', () => {
  it('starts with its cell, and an old one names none', () => {
    expect(tokenPrefix('enam')).toBe('');
    expect(tokenCell(`ypat_${tokenPrefix('weur')}${'x'.repeat(40)}`)).toBe('weur');
    expect(tokenCell(`ypat_${'x'.repeat(43)}`)).toBe('enam');
  });
});

it('a Worker knows its own cell, and with no switch it is enam', () => {
  expect(thisCell(off)).toBe('enam');
  expect(thisCell(inEurope)).toBe('weur');
  expect(cellsOn(off)).toBe(false);
  expect(cellsOn(bound)).toBe(true);
});
