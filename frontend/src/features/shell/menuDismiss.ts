// Menus built on <details> stay open until their summary is pressed again; these close them
// on a press anywhere else, as a dropdown should.
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
