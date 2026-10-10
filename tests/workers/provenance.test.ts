import { describe, expect, it } from 'vitest';
import { captureFileProvenance, validateFilePathAssertions } from '../../cloudflare/worker/provenance';

function fakeGit(trees: Record<string, { name: string; type: string; hash: string }[]>) {
  return {
    readCommit: async (commit: string) => ({ treeHash: commit }),
    readTree: async (tree: string) => trees[tree] ?? null,
  };
}

describe('trusted per-file capture receipts', () => {
  it('derives add, modify, delete and unique rename receipts from commit trees', async () => {
    const git = fakeGit({
      base: [
        { name: 'keep.md', type: 'blob', hash: '1'.repeat(40) },
        { name: 'edit.ts', type: 'blob', hash: '2'.repeat(40) },
        { name: 'old.txt', type: 'blob', hash: '3'.repeat(40) },
        { name: 'remove.txt', type: 'blob', hash: '4'.repeat(40) },
      ],
      next: [
        { name: 'keep.md', type: 'blob', hash: '1'.repeat(40) },
        { name: 'edit.ts', type: 'blob', hash: '5'.repeat(40) },
        { name: 'new.txt', type: 'blob', hash: '3'.repeat(40) },
        { name: 'add.txt', type: 'blob', hash: '6'.repeat(40) },
      ],
    });
    const receipt = await captureFileProvenance(git, 'base', 'next');
    expect(receipt).toEqual([
      { path: 'add.txt', change: 'add', old_blob: null, new_blob: '6'.repeat(40) },
      { path: 'edit.ts', change: 'modify', old_blob: '2'.repeat(40), new_blob: '5'.repeat(40) },
      { path: 'new.txt', old_path: 'old.txt', change: 'rename', old_blob: '3'.repeat(40), new_blob: '3'.repeat(40) },
      { path: 'remove.txt', change: 'delete', old_blob: '4'.repeat(40), new_blob: null },
    ]);
  });

  it('does not guess ambiguous same-blob renames and rejects unsafe trees', async () => {
    const ambiguous = fakeGit({
      base: [
        { name: 'one', type: 'blob', hash: 'a'.repeat(40) },
        { name: 'two', type: 'blob', hash: 'a'.repeat(40) },
      ],
      next: [{ name: 'three', type: 'blob', hash: 'a'.repeat(40) }],
    });
    expect(await captureFileProvenance(ambiguous, 'base', 'next')).toHaveLength(3);
    const unsafe = fakeGit({ base: [{ name: '../escape', type: 'blob', hash: 'a'.repeat(40) }], next: [] });
    await expect(captureFileProvenance(unsafe, 'base', 'next')).rejects.toThrow('unsafe path');
  });

  it('keeps the runtime tree cap separate from the changed-file receipt cap', async () => {
    const baseFiles = Array.from({ length: 501 }, (_, index) => ({
      name: `kept-${index}.txt`,
      type: 'blob',
      hash: index.toString(16).padStart(40, '0'),
    }));
    const git = fakeGit({
      base: baseFiles,
      next: [...baseFiles, { name: 'one-more.txt', type: 'blob', hash: 'f'.repeat(40) }],
    });
    await expect(captureFileProvenance(git, 'base', 'next')).resolves.toHaveLength(1);
  });

  it('accepts more than 500 changed paths and rejects captures above 10,000 receipts', async () => {
    const overLegacyLimit = Array.from({ length: 501 }, (_, index) => ({
      name: `file-${index}.txt`,
      type: 'blob',
      hash: index.toString(16).padStart(40, '0'),
    }));
    await expect(
      captureFileProvenance(fakeGit({ base: [], next: overLegacyLimit }), 'base', 'next'),
    ).resolves.toHaveLength(501);

    const beyondReceiptLimit = Array.from({ length: 10_001 }, (_, index) => ({
      name: `file-${index}.txt`,
      type: 'blob',
      hash: index.toString(16).padStart(40, '0'),
    }));
    await expect(
      captureFileProvenance(fakeGit({ base: [], next: beyondReceiptLimit }), 'base', 'next'),
    ).rejects.toThrow('receipt limit');
  });

  it('checks optional context file paths against the assigned captured source tree', async () => {
    const git = fakeGit({ source: [{ name: 'main.rs', type: 'blob', hash: 'b'.repeat(40) }] });
    await expect(validateFilePathAssertions(git, 'source', ['main.rs', 'main.rs'])).resolves.toEqual(['main.rs']);
    await expect(validateFilePathAssertions(git, 'source', ['missing.rs'])).rejects.toThrow('absent from the assigned source');
    await expect(validateFilePathAssertions(git, 'source', ['../secret'])).rejects.toThrow('unsafe');
  });
});
