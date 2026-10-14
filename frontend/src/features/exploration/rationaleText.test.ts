import { describe, expect, it } from 'vitest';
import { splitRationale } from './rationaleText';

describe('recorded rationale text', () => {
  it('leads with the first sentence and keeps the rest verbatim as detail', () => {
    expect(
      splitRationale(
        'Added delete and dark mode. Integration complete on commit 15e6ed0; IDs stable.',
      ),
    ).toEqual({
      lead: 'Added delete and dark mode.',
      detail: 'Integration complete on commit 15e6ed0; IDs stable.',
    });
  });

  it('keeps a single sentence whole', () => {
    expect(splitRationale('  One change only  ')).toEqual({ lead: 'One change only', detail: '' });
  });
});
