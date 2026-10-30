// A menu built on <details> closes when the press lands outside it, and only then.
import { describe, expect, it } from 'vitest';
import { closeOutside } from './menuDismiss';

const menu = (open: boolean, inside: unknown[] = []) => ({
  open,
  contains: (node: unknown) => inside.includes(node),
});

describe('closeOutside', () => {
  it('closes an open menu on a press outside it', () => {
    const details = menu(true);
    closeOutside(details as unknown as HTMLDetailsElement, {} as Node);
    expect(details.open).toBe(false);
  });
  it('stays open on a press inside it', () => {
    const inner = {};
    const details = menu(true, [inner]);
    closeOutside(details as unknown as HTMLDetailsElement, inner as Node);
    expect(details.open).toBe(true);
  });
  it('leaves a closed or missing menu alone', () => {
    const details = menu(false);
    closeOutside(details as unknown as HTMLDetailsElement, {} as Node);
    expect(details.open).toBe(false);
    expect(() => closeOutside(null, {} as Node)).not.toThrow();
  });
});
