// The rail's + button: a menu of the ways to get a repository. Built like the account menu
// (a <details>, closed by a press elsewhere) with the arrow keys of a menu button.
import { FolderPlus, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { ProviderMark } from '../workspace/OAuthButtons';
import { menuStep, useMenuDismiss } from './menuDismiss';

export function NewMenu({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  useMenuDismiss(menu);
  const rows = () => [
    ...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
  ];
  const opener = () => menu.current?.querySelector('summary');
  const close = () => {
    if (menu.current) menu.current.open = false;
    opener()?.focus();
  };
  // A dialog gives focus back to what held it, which must not be inside the closed menu.
  const pick = (action: () => void) => () => {
    close();
    action();
  };
  return (
    <details
      ref={menu}
      className="rail-menu"
      onToggle={(event) => {
        const details = event.currentTarget;
        setOpen(details.open);
        if (details.open) rows()[0]?.focus();
        // A press on nothing in particular: focus would otherwise end up on the page.
        else if (document.activeElement === document.body) opener()?.focus();
      }}
      onKeyDown={(event) => {
        const details = event.currentTarget;
        if (!details.open) {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          details.open = true;
        } else if (event.key === 'Escape' || event.key === 'Tab') {
          // Escape stays here: the phone menu around the rail closes on it too.
          event.stopPropagation();
          close();
        } else {
          const entries = rows();
          const at = entries.indexOf(document.activeElement as HTMLButtonElement);
          const next = menuStep(event.key, at, entries.length);
          if (next === null) return;
          event.preventDefault();
          entries[next]?.focus();
        }
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a <summary> is what opens a <details>. */}
      <summary
        className="rail-item"
        role="button"
        aria-label="New repository"
        // The tooltip would sit on top of the open menu.
        title={open ? undefined : 'New repository'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus size={18} aria-hidden="true" />
      </summary>
      <div className="account-dropdown" role="menu" aria-label="New repository">
        <button type="button" role="menuitem" className="account-item" onClick={pick(onCreate)}>
          <FolderPlus size={15} aria-hidden="true" />
          Create repository
        </button>
        <button type="button" role="menuitem" className="account-item" onClick={pick(onImport)}>
          <ProviderMark provider="github" size={15} />
          Add GitHub repository
        </button>
      </div>
    </details>
  );
}
