// A menu built on <details> closes when the press lands outside it, and only then.
import { describe, expect, it } from 'vitest';
import { closeOutside, menuStep } from './menuDismiss';

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

describe('menuStep', () => {
  it('moves down and up, wrapping at the ends', () => {
    expect(menuStep('ArrowDown', 0, 2)).toBe(1);
    expect(menuStep('ArrowDown', 1, 2)).toBe(0);
    expect(menuStep('ArrowUp', 1, 2)).toBe(0);
    expect(menuStep('ArrowUp', 0, 2)).toBe(1);
  });
  it('starts from the right end when no row holds focus', () => {
    expect(menuStep('ArrowDown', -1, 2)).toBe(0);
    expect(menuStep('ArrowUp', -1, 2)).toBe(1);
  });
  it('jumps with Home and End', () => {
    expect(menuStep('Home', 1, 2)).toBe(0);
    expect(menuStep('End', 0, 2)).toBe(1);
  });
  it('leaves every other key alone, Enter included: the row is a button', () => {
    expect(menuStep('Enter', 0, 2)).toBeNull();
    expect(menuStep(' ', 0, 2)).toBeNull();
    expect(menuStep('a', 0, 2)).toBeNull();
  });
  it('has nowhere to go in an empty menu', () => {
    expect(menuStep('ArrowDown', -1, 0)).toBeNull();
  });
});
