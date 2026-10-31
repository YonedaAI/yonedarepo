// Menus built on <details> stay open until their summary is pressed again; these close them
// on a press anywhere else, as a dropdown should. `menuStep` is a menu's arrow-key movement.
import { type RefObject, useEffect } from 'react';

/** Closes `menu` when `target`, the pressed element, is outside it. */
export function closeOutside(menu: HTMLDetailsElement | null, target: Node) {
  if (menu?.open && !menu.contains(target)) menu.open = false;
}

/** Closes the <details> in `menu` on any press outside it. */
export function useMenuDismiss(menu: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const away = (event: PointerEvent) => closeOutside(menu.current, event.target as Node);
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [menu]);
}

/** The row `key` moves focus to from row `at` of `count` (-1: focus is on no row), wrapping at
 * the ends; null for any other key, which the row itself answers. */
export function menuStep(key: string, at: number, count: number) {
  if (count === 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return (at + 1) % count;
  if (key === 'ArrowUp') return at <= 0 ? count - 1 : at - 1;
  return null;
}
